'use strict';
/** npm run preflight -- codex-cli (bez inference). */
const { loadConfig } = require('../config');
const { runPreflight } = require('../providers/preflight');
const { runCodexPreflight } = require('../providers/codexPreflight');
const id = process.argv[2] || 'claude-cli';
const check = { 'claude-cli': runPreflight, 'codex-cli': runCodexPreflight }[id];
if (!check) { console.error('Neznámý CLI provider: ' + id); process.exitCode = 2; }
else check(loadConfig()).then(pf => {
  console.log('Preflight ' + id + ' ' + pf.at + ': ' + (pf.ok ? 'OK — reálná inference povolena' : 'NEPROŠEL — reálná inference zablokována'));
  for (const c of pf.checks) console.log('[' + c.status + '] ' + c.label + ': ' + c.detail);
  process.exitCode = pf.ok ? 0 : 2;
}).catch(e => { console.error('Preflight selhal:', e.message); process.exitCode = 2; });
