'use strict';
/** `npm run preflight` — samostatná kontrola předplatitelského režimu Claude Code CLI (bez inference). */
const { loadConfig } = require('../config');
const { runPreflight } = require('../providers/preflight');

runPreflight(loadConfig()).then((pf) => {
  console.log(`Preflight ${pf.at}: ${pf.ok ? 'OK — reálná inference povolena' : 'NEPROŠEL — reálná inference zablokována'}`);
  for (const c of pf.checks) console.log(`[${c.status}] ${c.label}: ${c.detail}`);
  process.exitCode = pf.ok ? 0 : 2;
});
