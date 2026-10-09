'use strict';
/**
 * Přehodnocení uložených výsledků aktuálním oráklem (bez nové inference):
 *   node bench/rescore.js data/bench/<čas> [...]
 * Původní results.jsonl se zachová jako results.orig.jsonl (jen při prvním přepočtu); změny vypíše.
 */
const fs = require('fs');
const path = require('path');
const { SCENARIOS } = require('./scenarios');
const { judgeFr } = require('./run');

async function rescore(dir) {
  const file = path.join(dir, 'results.jsonl');
  const orig = path.join(dir, 'results.orig.jsonl');
  if (!fs.existsSync(orig)) fs.copyFileSync(file, orig);
  const rows = fs.readFileSync(orig, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const changes = [];
  for (const r of rows) {
    const s = SCENARIOS.find((x) => x.id === r.scenario);
    if (!s || r.skipped || r.ok === null) continue;
    let j;
    if (r.mode === 'fr' || r.mode === 'fr-followup') {
      const run = JSON.parse(fs.readFileSync(path.join(dir, 'runs', `${r.fr.runId}.json`), 'utf8'));
      const spec = r.mode === 'fr' ? s : s.followUp;
      j = await judgeFr(run, spec.expect, spec.oracle);
    } else {
      const oracle = r.mode === 'raw' ? (s.rawOracle || s.oracle) : s.followUp.oracle;
      j = r.raw.error ? { ok: false, detail: `chyba volání: ${r.raw.error}` } : await oracle({ output: r.raw.output, artifacts: [] });
    }
    if (j.ok !== r.ok) changes.push(`${r.backend} ${r.scenario} ${r.mode}: ${r.ok ? '✅' : '❌'} → ${j.ok ? '✅' : '❌'} (${j.detail})`);
    Object.assign(r, { ok: j.ok, detail: j.detail }, j.branches ? { branches: j.branches } : {});
  }
  fs.writeFileSync(file, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return changes;
}

(async () => {
  for (const dir of process.argv.slice(2)) {
    const ch = await rescore(dir);
    console.log(`${dir}: ${ch.length ? '\n  ' + ch.join('\n  ') : 'beze změny'}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
