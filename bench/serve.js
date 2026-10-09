'use strict';
/**
 * Lokální server FR (UI) s dalšími modely z bench/backends.json — harness MIMO kód FR (K3).
 *   node bench/serve.js [--backends bench/backends.json] [--port 4173]
 * Kód FR se nemění: createServer() dostane providery zvenku. Přidá se jen backend typu openai-compatible,
 * jehož preflight projde; nedostupné backendy se vypíšou a přeskočí.
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

async function main() {
  const config = loadConfig();
  const providers = createProviders(config);
  const file = arg('backends', path.join(__dirname, 'backends.json'));
  const extra = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).filter((b) => b.type === 'openai-compatible') : [];
  for (const b of extra) {
    const p = new OpenAICompatProvider({ ...b, id: b.id });
    const pf = await p.preflight();
    if (pf.ok) { providers[b.id] = p; console.log(`+ ${b.id}: ${p.describe().label}`); }
    else console.log(`- ${b.id}: přeskočen (${pf.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')})`);
  }
  const { server, getPreflight } = createServer({ config, providers });
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

main().catch((e) => { console.error(e); process.exit(1); });
