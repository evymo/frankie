'use strict';
/**
 * Lokální server FR (UI) s dalšími modely z bench/backends.json — harness MIMO kód FR (K3).
 *   node bench/serve.js [--backends bench/backends.json] [--port 4173]
 * Kód FR se nemění: createServer() dostane providery zvenku. Backend, který při startu ještě neprojde preflightem
 * (např. GPU model se teprve načítá), se zkouší znovu a přidá se za běhu — server čte providery živě.
 */
const fs = require('fs');
const path = require('path');
const { createServer } = require('../src/server');
const { createProviders } = require('../src/providers');
const { loadConfig } = require('../src/config');
const { OpenAICompatProvider } = require('./openaiCompat');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

/**
 * Backendy, které při startu neprošly preflightem, zkouší znovu po `intervalMs`; po úspěchu je přidá do objektu
 * providerů (server ho čte živě — status i RunManager), takže restart není potřeba. Vrací funkci pro zastavení.
 */
function attachWhenReady({ pending, providers, getPreflight, intervalMs = 30000, log = console.log }) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; // pomalý preflight: pokusy se nepřekrývají
    busy = true;
    try {
      for (const p of [...pending]) {
        let ok = false;
        try { ok = (await p.preflight()).ok; } catch (_) { ok = false; }
        if (!ok) continue;
        providers[p.id] = p;
        pending.splice(pending.indexOf(p), 1);
        await getPreflight(true, p.id).catch(() => {});
        log(`+ ${p.id}: ${p.describe().label || p.model} (připojen za běhu)`);
      }
      if (!pending.length) clearInterval(timer);
    } finally { busy = false; }
  }, intervalMs);
  return () => clearInterval(timer);
}

async function main() {
  const config = loadConfig();
  const providers = createProviders(config);
  const file = arg('backends', path.join(__dirname, 'backends.json'));
  const extra = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).filter((b) => b.type === 'openai-compatible') : [];
  const pending = [];
  for (const b of extra) {
    const p = new OpenAICompatProvider({ ...b, id: b.id });
    const pf = await p.preflight();
    if (pf.ok) { providers[b.id] = p; console.log(`+ ${b.id}: ${p.describe().label}`); }
    else { pending.push(p); console.log(`- ${b.id}: zatím nedostupný (${pf.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}) — zkusím znovu`); }
  }
  const { server, getPreflight } = createServer({ config, providers });
  attachWhenReady({ pending, providers, getPreflight });
  const port = Number(arg('port', config.server.port));
  server.listen(port, '127.0.0.1', () => {
    console.log(`FR ${require('../package.json').version}: http://127.0.0.1:${port}  (providery: ${Object.keys(providers).join(', ')})`);
    // Preflight všech providerů s preflightem (CLI i harness), ať je UI hned nabídne jako připravené.
    for (const [id, p] of Object.entries(providers)) {
      if (!p.requiresPreflight) continue;
      getPreflight(true, id).then((pf) => console.log(`preflight ${id}: ${pf.ok ? 'OK' : 'NEPROŠEL'}`)).catch((e) => console.log(`preflight ${id}: ${e.message}`));
    }
  });
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { attachWhenReady };
