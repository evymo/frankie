'use strict';
/**
 * Result Verifier — ověřuje výsledek proti Goal Contract po jednotlivých kritériích.
 * Deterministické kontroly mají přednost; sémantická kritéria posoudí oddělená relace modelu,
 * která dostane jen výstup a artefakty (nikoli poznámky či uvažování vykonávacího modelu).
 * Sémantický PASS bez doslovně dohledatelné citace ve výstupu se algoritmicky sníží na UNVERIFIED.
 */
const { runDeterministic } = require('./criteria');
const { SEMANTIC_VERIFY } = require('./schemas');
const { semanticVerifyPrompt } = require('../templates/analysis');
const { isQuoteIn } = require('./util');
const { EVALUATOR_VERSION } = require('./evaluator');

const VERDICTS = ['PASS', 'PARTIAL', 'FAIL', 'UNVERIFIED'];

/** Celkový verdikt — čistá funkce. PASS jen pokud jsou VŠECHNA povinná kritéria prokázána. */
function computeVerdict(results) {
  const mand = results.filter((r) => r.mandatory);
  const f = mand.filter((r) => r.result === 'FAIL').length;
  const u = mand.filter((r) => r.result === 'UNVERIFIED').length;
  const p = mand.filter((r) => r.result === 'PASS').length;
  let verdict;
  if (!mand.length) verdict = 'UNVERIFIED';
  else if (f === 0 && u === 0) verdict = 'PASS';
  else if (f === 0) verdict = 'UNVERIFIED';
  else if (p > 0) verdict = 'PARTIAL';
  else verdict = 'FAIL';
  return { verdict, counts: { mandatory: mand.length, passed: p, failed: f, unverified: u, optionalFailed: results.filter((r) => !r.mandatory && r.result !== 'PASS').length } };
}

function method(c) {
  return c.verification.kind === 'semantic' ? 'sémantický hodnotitel (model, oddělená relace)' : `deterministicky: ${c.verification.type}`;
}

/**
 * Je důkaz hodnotitele doložitelný ve výstupu? Buď je celý doslovně ve výstupu, nebo obsahuje
 * citace v uvozovkách a VŠECHNY se ve výstupu doslovně nacházejí. (Čistá funkce.)
 */
function evidenceSupported(evidence, haystack) {
  if (isQuoteIn(evidence, haystack)) return { ok: true, how: 'doslovná citace' };
  const quotes = [...String(evidence || '').matchAll(/[„“"]([^„“”"]{3,}?)[“”"]/g)].map((m) => m[1].trim()).filter(Boolean);
  if (quotes.length && quotes.every((q) => isQuoteIn(q, haystack))) return { ok: true, how: `${quotes.length} citovaných úseků nalezeno` };
  return { ok: false, missing: quotes.filter((q) => !isQuoteIn(q, haystack)) };
}

async function verify({ contract, execution, callModel, config, canCallModel, prompt = '', clarifications = [] }) {
  const started = Date.now();
  const out = [];
  const semantic = [];
  for (const c of contract.successCriteria) {
    const base = { criterionId: c.id, description: c.description, mandatory: c.mandatory, condition: c.description, method: method(c), origin: c.origin };
    if (c.verification.kind === 'semantic') { semantic.push(c); out.push({ ...base, result: 'PENDING' }); continue; }
    if (execution.status === 'error') { out.push({ ...base, result: 'UNVERIFIED', evidence: `Exekuce selhala: ${execution.error}`, deviation: 'Bez výsledku nelze ověřit.' }); continue; }
    const r = await runDeterministic(c, execution, { contract, config });
    out.push({ ...base, ...r, simulated: false });
  }

  let semanticCall = null;
  if (semantic.length) {
    let results = null;
    let reason = '';
    if (execution.status === 'error') reason = 'Exekuce selhala — sémantické ověření neproběhlo.';
    else if (!canCallModel()) reason = 'Limit modelových volání vyčerpán — sémantické ověření neproběhlo.';
    else {
      const tpl = semanticVerifyPrompt({ contract, criteria: semantic, output: execution.output, artifacts: execution.artifacts, prompt, clarifications });
      const r = await callModel({ task: 'semantic_verify', template: tpl.template, system: tpl.system, prompt: tpl.prompt, schema: SEMANTIC_VERIFY, input: { contract, criteria: semantic, output: execution.output, artifacts: execution.artifacts, prompt } });
      semanticCall = { callId: r.callId, ok: r.ok, simulated: r.simulated };
      if (r.ok) results = r.data.results; else reason = `Sémantický hodnotitel selhal: ${r.error}`;
    }
    const haystack = [execution.output, ...(execution.artifacts || []).map((a) => a.content)].join('\n');
    for (const row of out) {
      if (row.result !== 'PENDING') continue;
      const m = results && results.find((x) => x.criterionId === row.criterionId);
      if (!m) { Object.assign(row, { result: 'UNVERIFIED', evidence: reason || 'Hodnotitel kritérium nevrátil.', deviation: 'Neověřeno.', simulated: semanticCall ? semanticCall.simulated : false }); continue; }
      const res = { result: m.result, evidence: m.evidence, deviation: m.deviation || '', simulated: semanticCall.simulated };
      if (m.result === 'PASS' && semanticCall.simulated) {
        // Simulované hodnocení (mock) není důkaz splnění — PASS z něj nikdy nevznikne.
        res.result = 'UNVERIFIED';
        res.deviation = 'Sémantické hodnocení bylo jen simulované (mock) — není důkazem splnění.';
        res.downgradedFrom = 'PASS';
      } else if (m.result === 'PASS') {
        const ev = evidenceSupported(m.evidence, haystack);
        if (!ev.ok) {
          res.result = 'UNVERIFIED';
          res.deviation = `Hodnotitel uvedl PASS, ale jeho citace nebyla ve výstupu nalezena (algoritmická kontrola)${ev.missing && ev.missing.length ? ': ' + ev.missing.map((q) => `„${q}“`).join(', ') : ''}.`;
          res.downgradedFrom = 'PASS';
        } else res.evidenceCheck = ev.how;
      }
      Object.assign(row, res);
    }
  }

  const v = computeVerdict(out);
  const deviations = out.filter((r) => r.result !== 'PASS').map((r) => ({ criterionId: r.criterionId, mandatory: r.mandatory, result: r.result, deviation: r.deviation || r.evidence }));
  return { evaluator: EVALUATOR_VERSION, criteria: out, verdict: v.verdict, counts: v.counts, deviations, semanticCall, durationMs: Date.now() - started };
}

/** Je selhání opravitelné jedním řízeným průchodem? (čistá funkce) */
function repairDecision({ verification, execution, contract, repairsUsed, maxRepairs, callsRemaining }) {
  if (!['FAIL', 'PARTIAL'].includes(verification.verdict)) return { repair: false, reason: `Verdikt ${verification.verdict} — oprava se nespouští.` };
  if (repairsUsed >= Math.min(1, maxRepairs)) return { repair: false, reason: 'Limit opravných průchodů (max. 1) vyčerpán.' };
  if (['blocked', 'unsupported', 'error'].includes(execution.status)) return { repair: false, reason: `Stav exekuce „${execution.status}“ není opravitelný v rámci oprávnění.` };
  const allFailed = verification.criteria.filter((c) => c.result === 'FAIL');
  if (allFailed.some((c) => c.criterionId === 'SYS-2')) return { repair: false, reason: 'Selhala bezpečnostní kontrola SYS-2 — oprava by nesměla rozšířit oprávnění; vyžaduje člověka.' };
  const nonRepairable = new Set(contract.successCriteria.filter((c) => c.repairable === false).map((c) => c.id));
  const failed = allFailed.filter((c) => !nonRepairable.has(c.criterionId));
  if (!failed.length) return { repair: false, reason: allFailed.length ? 'Nesplněná kritéria nejsou opravitelná v rámci oprávnění (např. SYS-4 blokované operace).' : 'Žádné konkrétní nesplněné kritérium.' };
  const needCalls = 1 + (contract.successCriteria.some((c) => c.verification.kind === 'semantic') ? 1 : 0);
  if (callsRemaining < needCalls) return { repair: false, reason: `Oprava by překročila limit modelových volání (zbývá ${callsRemaining}, potřeba ${needCalls}).` };
  return { repair: true, reason: `Opravitelné: ${failed.length} nesplněných kritérií.`, failed };
}

module.exports = { verify, computeVerdict, repairDecision, evidenceSupported, VERDICTS };
