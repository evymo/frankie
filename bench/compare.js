'use strict';
/**
 * Srovnání více běhů benchmarku: node bench/compare.js <adresář> [<adresář> …] > souhrn.md
 * Každý adresář je výstup bench/run.js; backendy se slučují do jedné tabulky a matice scénářů.
 */
const fs = require('fs');
const path = require('path');
const { summarize } = require('./report');
const { SCENARIOS } = require('./scenarios');

const mark = (ok) => (ok === true ? '✅' : ok === false ? '❌' : '—');
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)} %` : '—');

async function main() {
  const dirs = process.argv.slice(2);
  const all = {};
  for (const dir of dirs) {
    const rows = fs.readFileSync(path.join(dir, 'results.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    Object.assign(all, await summarize(rows, dir));
  }
  // Simulované backendy (mock) nemají samostatný dotaz — do srovnání kvality nepatří.
  const ids = Object.keys(all).filter((k) => !all[k].skipped && all[k].accuracy.n && all[k].accuracy.nRaw);
  const L = [];
  L.push('## Souhrn napříč backendy', '');
  L.push(`| Metrika | ${ids.map((i) => `${i}<br>FR`).join(' | ')} | ${ids.map((i) => `${i}<br>samostatně`).join(' | ')} |`);
  L.push(`|---|${ids.map(() => '---').join('|')}|${ids.map(() => '---').join('|')}|`);
  const row = (label, fr, raw) => L.push(`| ${label} | ${ids.map(fr).join(' | ')} | ${ids.map(raw).join(' | ')} |`);
  row('Správně (orákl)', (i) => `**${all[i].accuracy.fr}/${all[i].accuracy.n}** (${pct(all[i].accuracy.fr, all[i].accuracy.n)})`, (i) => `**${all[i].accuracy.raw}/${all[i].accuracy.nRaw}** (${pct(all[i].accuracy.raw, all[i].accuracy.nRaw)})`);
  for (const g of ['good', 'trap', 'alternative']) row(`— ${g}`, (i) => `${all[i].groups[g].fr}/${all[i].groups[g].n}`, (i) => `${all[i].groups[g].raw}/${all[i].groups[g].n}`);
  row('Po upřesnění (S09)', (i) => mark(all[i].followUp.fr && all[i].followUp.fr.ok), (i) => mark(all[i].followUp.raw && all[i].followUp.raw.ok));
  row('Volání / scénář', (i) => (all[i].cost.frCalls / all[i].cost.n).toFixed(1), (i) => (all[i].cost.rawCalls / all[i].cost.n).toFixed(1));
  row('Tokeny / scénář', (i) => Math.round(all[i].cost.frTokens / all[i].cost.n), (i) => Math.round(all[i].cost.rawTokens / all[i].cost.n));
  row('Čas / scénář', (i) => `${(all[i].cost.frMs / all[i].cost.n / 1000).toFixed(1)} s`, (i) => `${(all[i].cost.rawMs / all[i].cost.n / 1000).toFixed(1)} s`);
  L.push('');
  L.push('| Sebehodnocení a učení FR | ' + ids.join(' | ') + ' |', '|---|' + ids.map(() => '---').join('|') + '|');
  const r2 = (label, f) => L.push(`| ${label} | ${ids.map(f).join(' | ')} |`);
  r2('PASS a správně', (i) => all[i].calibration.truePass.length);
  r2('**PASS, ale špatně (falešný souhlas)**', (i) => `**${all[i].calibration.falsePass.length}** ${all[i].calibration.falsePass.join(', ')}`);
  r2('Jiný verdikt, ale správně (zbytečná nedůvěra)', (i) => `${all[i].calibration.falseReject.length} ${all[i].calibration.falseReject.join(', ')}`);
  r2('Jiný verdikt a špatně (chyba zachycena)', (i) => `${all[i].calibration.caught.length} ${all[i].calibration.caught.join(', ')}`);
  r2('Řízená chyba odhalena', (i) => `${all[i].learning.filter((l) => l.detected).length}/${all[i].learning.length}`);
  r2('Řízená chyba opravena (orákl)', (i) => `${all[i].learning.filter((l) => l.fixed).length}/${all[i].learning.length}`);
  r2('Spontánní opravy (před→po)', (i) => all[i].organicRepairs.map((o) => `${o.scenario} ${mark(o.before)}→${mark(o.after)}`).join(', ') || '—');
  r2('Co kdyby nástroj měl veto', (i) => all[i].veto.map((v) => `${v.scenario} ${v.from}→${v.to}`).join(', ') || '—');
  L.push('');
  L.push('## Matice scénářů (orákl; u FR rozhodnutí a verdikt)', '');
  L.push(`| Scénář | ${ids.map((i) => `${i} FR`).join(' | ')} | ${ids.map((i) => `${i} samostatně`).join(' | ')} |`);
  L.push(`|---|${ids.map(() => '---').join('|')}|${ids.map(() => '---').join('|')}|`);
  for (const s of SCENARIOS) {
    const fr = ids.map((i) => {
      const r = all[i].rows.find((x) => x.scenario === s.id && x.mode === 'fr');
      if (!r) return '';
      const f = all[i].rows.find((x) => x.scenario === s.id && x.mode === 'fr-followup');
      return `${mark(r.ok)} ${r.fr.decision || 'FAILED'} ${r.fr.verdictInitial || ''}${r.fr.repaired ? '→' + r.fr.verdictFinal : ''}${f ? ` · po upřesnění ${mark(f.ok)}` : ''}`;
    });
    const raw = ids.map((i) => {
      const r = all[i].rows.find((x) => x.scenario === s.id && x.mode === 'raw');
      const f = all[i].rows.find((x) => x.scenario === s.id && x.mode === 'raw-followup');
      return r ? `${mark(r.ok)}${f ? ` · po upřesnění ${mark(f.ok)}` : ''}` : 'n/a';
    });
    L.push(`| ${s.id}${s.inject ? '*' : ''} ${s.title} | ${fr.join(' | ')} | ${raw.join(' | ')} |`);
  }
  process.stdout.write(L.join('\n') + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
