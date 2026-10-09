'use strict';
/**
 * Souhrn benchmarku: node bench/report.js data/bench/<čas>
 * Zapíše report.md a summary.json do stejného adresáře a report vypíše na stdout.
 */
const fs = require('fs');
const path = require('path');
const { SCENARIOS } = require('./scenarios');
const { computeVerdict } = require('../src/core/verifier');

/** Co kdyby: deterministický nástroj má veto (TOOL-* povinné vždy, ne jen při fullySolves). */
function vetoVerdict(dir, runId) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(dir, 'runs', `${runId}.json`), 'utf8'));
    const b0 = run.branches[0];
    const crit = b0.attempts[b0.attempts.length - 1].verification.criteria;
    if (!crit.some((c) => c.origin === 'deterministic_tool' && !c.mandatory)) return null;
    return computeVerdict(crit.map((c) => ({ ...c, mandatory: c.mandatory || c.origin === 'deterministic_tool' }))).verdict;
  } catch (_) { return null; }
}

const COMPARABLE = new Set(['good', 'trap', 'alternative']);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '—');
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '—');

function load(dir) {
  return fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function summarize(rows, dir) {
  const byBackend = {};
  for (const r of rows) (byBackend[r.backend] = byBackend[r.backend] || []).push(r);
  const out = {};
  for (const [backend, rs] of Object.entries(byBackend)) {
    if (rs.some((r) => r.skipped)) { out[backend] = { skipped: true, preflight: rs[0].preflight }; continue; }
    const fr = rs.filter((r) => r.mode === 'fr' && COMPARABLE.has(r.group));
    const raw = rs.filter((r) => r.mode === 'raw' && COMPARABLE.has(r.group) && r.ok !== null);
    const pairs = fr.map((f) => ({ f, r: raw.find((x) => x.scenario === f.scenario) })).filter((p) => p.r);
    const s = {
      model: rs[0].model, judgeModel: rs[0].judgeModel,
      accuracy: { fr: fr.filter((r) => r.ok).length, raw: raw.filter((r) => r.ok).length, n: fr.length, nRaw: raw.length },
      head2head: { frOnly: pairs.filter((p) => p.f.ok && !p.r.ok).map((p) => p.f.scenario), rawOnly: pairs.filter((p) => !p.f.ok && p.r.ok).map((p) => p.f.scenario), both: pairs.filter((p) => p.f.ok && p.r.ok).length, neither: pairs.filter((p) => !p.f.ok && !p.r.ok).map((p) => p.f.scenario) },
      followUp: { fr: rs.find((r) => r.mode === 'fr-followup') || null, raw: rs.find((r) => r.mode === 'raw-followup') || null },
      groups: {},
      calibration: { truePass: [], falsePass: [], falseReject: [], caught: [] },
      veto: [],
      learning: [],
      organicRepairs: [],
      cost: { frCalls: 0, frTokens: 0, frMs: 0, rawCalls: 0, rawTokens: 0, rawMs: 0, frUsd: null, rawUsd: null, n: pairs.length },
      decisions: fr.map((r) => ({ scenario: r.scenario, decision: r.fr.decision, ok: r.decisionOk })),
    };
    for (const g of COMPARABLE) {
      const fg = fr.filter((r) => r.group === g);
      const rg = raw.filter((r) => r.group === g);
      s.groups[g] = { fr: fg.filter((r) => r.ok).length, raw: rg.filter((r) => r.ok).length, nFr: fg.length, nRaw: rg.length };
    }
    // Kalibrace: shoduje se verdikt FR s oráklem? (jen dokončené běhy)
    for (const r of rs.filter((x) => (x.mode === 'fr' || x.mode === 'fr-followup') && x.fr && x.fr.state === 'DONE')) {
      const pass = r.fr.verdictFinal === 'PASS';
      const key = pass ? (r.ok ? 'truePass' : 'falsePass') : (r.ok ? 'falseReject' : 'caught');
      s.calibration[key].push(`${r.scenario}${r.injected ? '*' : ''}`);
      const v = vetoVerdict(dir, r.fr.runId);
      if (v && v !== r.fr.verdictFinal) s.veto.push({ scenario: r.scenario, from: r.fr.verdictFinal, to: v, oracleOk: r.ok });
    }
    // Učení: řízená chyba → odhalena? → opravena?
    for (const r of rs.filter((x) => x.mode === 'fr' && x.group === 'learning')) {
      s.learning.push({ scenario: r.scenario, title: r.title, verdictInitial: r.fr.verdictInitial, detected: ['FAIL', 'PARTIAL'].includes(r.fr.verdictInitial), repaired: r.fr.repaired, verdictFinal: r.fr.verdictFinal, fixed: r.ok, detail: r.detail, failedCriteria: r.fr.failedCriteria, repairReason: r.fr.repairReason });
    }
    // Spontánní opravy (bez podvrhu): zlepšila oprava výsledek podle orákla?
    for (const r of rs.filter((x) => x.mode === 'fr' && !x.injected && x.fr && x.fr.repaired && x.fr.firstOutput)) {
      const sc = SCENARIOS.find((x) => x.id === r.scenario);
      const before = await sc.oracle(r.fr.firstOutput);
      s.organicRepairs.push({ scenario: r.scenario, before: before.ok, after: r.ok, verdictInitial: r.fr.verdictInitial, verdictFinal: r.fr.verdictFinal });
    }
    for (const p of pairs) {
      s.cost.frCalls += p.f.fr.cost.calls; s.cost.frTokens += p.f.fr.cost.inputTokens + p.f.fr.cost.outputTokens; s.cost.frMs += p.f.fr.wallMs;
      s.cost.rawCalls += p.r.raw.cost.calls; s.cost.rawTokens += p.r.raw.cost.inputTokens + p.r.raw.cost.outputTokens; s.cost.rawMs += p.r.raw.wallMs;
      if (p.f.fr.cost.costUsd != null) s.cost.frUsd = (s.cost.frUsd || 0) + p.f.fr.cost.costUsd;
      if (p.r.raw.cost.costUsd != null) s.cost.rawUsd = (s.cost.rawUsd || 0) + p.r.raw.cost.costUsd;
    }
    s.rows = rs;
    out[backend] = s;
  }
  return out;
}

function render(meta, sum) {
  const L = [];
  L.push(`# FR vs. samostatný dotaz na model — výsledky benchmarku`, '');
  L.push(`Spuštěno ${meta.startedAt} (${meta.platform || meta.host || '—'}), FR ${meta.frVersion}. Scénáře: ${meta.scenarios.join(', ')}.`);
  L.push('Správnost hodnotí **nezávislý orákl** (předem známá odpověď, deterministická kontrola), ne verdikt FR. `*` = řízená chyba.', '');
  for (const [backend, s] of Object.entries(sum)) {
    L.push(`## ${backend}`, '');
    if (s.skipped) { L.push(`Přeskočeno — preflight neprošel: \`${JSON.stringify(s.preflight.checks || s.preflight).slice(0, 300)}\``, ''); continue; }
    L.push(`Vykonavatel \`${s.model}\`${s.judgeModel ? `, soudce \`${s.judgeModel}\`` : ' (soudí týž model)'}.`, '');
    L.push('| | FR | samostatný dotaz |', '|---|---|---|');
    L.push(`| Správně celkem | **${s.accuracy.fr}/${s.accuracy.n}** (${pct(s.accuracy.fr, s.accuracy.n)}) | **${s.accuracy.raw}/${s.accuracy.nRaw}** (${pct(s.accuracy.raw, s.accuracy.nRaw)}) |`);
    for (const [g, v] of Object.entries(s.groups)) L.push(`| — ${g} | ${v.fr}/${v.nFr} | ${v.raw}/${v.nRaw} |`);
    if (s.followUp.fr || s.followUp.raw) L.push(`| Po upřesnění (S09) | ${mark(s.followUp.fr && s.followUp.fr.ok)} | ${mark(s.followUp.raw && s.followUp.raw.ok)} |`);
    if (s.cost.n) {
      L.push(`| Volání modelu / scénář | ${(s.cost.frCalls / s.cost.n).toFixed(1)} | ${(s.cost.rawCalls / s.cost.n).toFixed(1)} |`);
      L.push(`| Tokeny / scénář | ${Math.round(s.cost.frTokens / s.cost.n)} | ${Math.round(s.cost.rawTokens / s.cost.n)} |`);
      L.push(`| Čas / scénář | ${sec(s.cost.frMs / s.cost.n)} | ${sec(s.cost.rawMs / s.cost.n)} |`);
      if (s.cost.frUsd != null) L.push(`| Cena celkem (odhad) | $${s.cost.frUsd.toFixed(3)} | $${(s.cost.rawUsd || 0).toFixed(3)} |`);
    }
    L.push('');
    L.push(`**Přímé srovnání:** jen FR správně: ${s.head2head.frOnly.join(', ') || '—'} · jen samostatný dotaz správně: ${s.head2head.rawOnly.join(', ') || '—'} · oba: ${s.head2head.both} · ani jeden: ${s.head2head.neither.join(', ') || '—'}`, '');
    const c = s.calibration;
    L.push('**Kalibrace sebehodnocení FR** (verdikt FR × orákl):', '');
    L.push('| | orákl: správně | orákl: špatně |', '|---|---|---|');
    L.push(`| FR: PASS | ${c.truePass.length} ✔ potvrzeno (${c.truePass.join(', ') || '—'}) | **${c.falsePass.length} ✘ falešný souhlas** (${c.falsePass.join(', ') || '—'}) |`);
    L.push(`| FR: jiný verdikt | ${c.falseReject.length} zbytečná nedůvěra (${c.falseReject.join(', ') || '—'}) | ${c.caught.length} ✔ chyba zachycena (${c.caught.join(', ') || '—'}) |`, '');
    if (s.veto.length) {
      L.push(`**Co kdyby deterministický nástroj měl veto** (TOOL-* povinné vždy): ${s.veto.map((v) => `${v.scenario} ${v.from}→${v.to} (orákl ${v.oracleOk ? 'správně' : 'špatně'})`).join(', ')}. Přepočet jen detekce; jestli by oprava uspěla, ukáže až nový běh.`, '');
    }
    if (s.learning.length) {
      L.push('**Učení z chyby (řízená chyba v 1. exekuci → zpětná vazba → oprava skutečným modelem):**', '');
      L.push('| Scénář | Odhaleno | Nesplněná kritéria | Oprava | Výsledek po opravě (orákl) |', '|---|---|---|---|---|');
      for (const l of s.learning) L.push(`| ${l.scenario} ${l.title} | ${l.detected ? '✅' : '❌'} ${l.verdictInitial || '—'} | ${l.failedCriteria.join(', ') || '—'} | ${l.repaired ? `ano → ${l.verdictFinal}` : `ne (${(l.repairReason || '').slice(0, 60)})`} | ${mark(l.fixed)} ${l.detail.slice(0, 80)} |`);
      L.push('');
    }
    if (s.organicRepairs.length) {
      L.push(`**Spontánní opravy** (FR sám našel chybu skutečného modelu): ${s.organicRepairs.map((o) => `${o.scenario} ${mark(o.before)}→${mark(o.after)}`).join(', ')}`, '');
    }
    L.push('<details><summary>Detail po scénářích</summary>', '');
    L.push('| Scénář | Režim | Rozhodnutí | Verdikt FR | Orákl | Volání | Čas | Detail |', '|---|---|---|---|---|---|---|---|');
    for (const r of s.rows) {
      const v = r.fr ? `${r.fr.verdictInitial || '—'}${r.fr.repaired ? '→' + r.fr.verdictFinal : ''}` : '';
      const calls = r.fr ? r.fr.cost.calls : r.raw ? r.raw.cost.calls : '';
      const ms = r.fr ? r.fr.wallMs : r.raw ? r.raw.wallMs : 0;
      L.push(`| ${r.scenario}${r.injected ? '*' : ''} | ${r.mode} | ${r.fr ? (r.fr.decision || '—') : ''} | ${v} | ${mark(r.ok)} | ${calls} | ${ms ? sec(ms) : ''} | ${String(r.detail || '').replace(/\|/g, '/').slice(0, 100)} |`);
    }
    L.push('', '</details>', '');
  }
  return L.join('\n');
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error('Použití: node bench/report.js data/bench/<čas>'); process.exit(2); }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const sum = await summarize(load(dir), dir);
  const md = render(meta, sum);
  fs.writeFileSync(path.join(dir, 'report.md'), md);
  const lean = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, { ...v, rows: undefined }]));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ meta, backends: lean }, null, 2));
  process.stdout.write(md + '\n');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { summarize, render };
