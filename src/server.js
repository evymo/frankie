'use strict';
/**
 * Lokální HTTP server FRANKENSTEIN (jen 127.0.0.1). Bez závislostí.
 * API: stav, preflight, spuštění běhu (zámek = max. 1 běh), detail/historie, export JSON a exekučních promptů.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./config');
const { RunStore } = require('./core/store');
const { RunManager, PHASES, FrError } = require('./core/pipeline');
const { createProviders } = require('./providers');
const { ASPECTS } = require('./core/aspects');
const { RULES } = require('./core/decision');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function createServer({ config = loadConfig(), dataDir = path.join(ROOT, 'data'), providers } = {}) {
  const store = new RunStore(path.join(dataDir, 'runs'));
  const interrupted = store.recoverInterrupted();
  providers = providers || createProviders(config);
  const manager = new RunManager({ store, config, providers });
  const publicDir = path.join(ROOT, 'public');
  let preflightCache = null;
  let preflightRunning = null;

  async function getPreflight(force) {
    const p = providers['claude-cli'];
    if (!p) return null;
    if (preflightCache && !force) return preflightCache;
    if (!preflightRunning) preflightRunning = p.preflight().then((r) => { preflightCache = r; return r; }).finally(() => { preflightRunning = null; });
    return preflightRunning;
  }

  function send(res, code, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(code, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let b = '';
      req.on('data', (d) => { b += d; if (b.length > 1e6) { reject(new FrError('TOO_LARGE', 'Požadavek je příliš velký.')); req.destroy(); } });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { reject(new FrError('BAD_JSON', 'Neplatný JSON.')); } });
    });
  }

  /** Ochrana lokálního API: jen localhost Host (proti DNS rebinding) a stejný Origin u zápisů. */
  function hostOk(req) {
    const h = String(req.headers.host || '');
    return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);
  }
  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o) && o.endsWith(String(req.headers.host).replace(/^[^:]+/, '')) ;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) return send(res, 403, { error: 'Nepovolený Host.' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;

      if (p.startsWith('/api/')) {
        if (req.method === 'POST' && !originOk(req)) return send(res, 403, { error: 'Nepovolený Origin.' });
        if (req.method === 'POST' && !/application\/json/.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Očekáván application/json.' });

        if (p === '/api/status' && req.method === 'GET') {
          const active = manager.busy();
          return send(res, 200, {
            version: '0.3.1', defaultProvider: config.defaultProvider, providers: Object.values(providers).map((x) => x.describe()),
            preflight: preflightCache, busy: active ? { id: active.id, state: active.state } : null, limits: config.limits,
            capabilities: config.capabilities, permissions: config.permissions, aspects: ASPECTS, phases: PHASES, decisionRules: RULES, interruptedOnStart: interrupted,
          });
        }
        if (p === '/api/preflight' && req.method === 'POST') return send(res, 200, await getPreflight(true));
        if (p === '/api/runs' && req.method === 'GET') return send(res, 200, store.list());
        if (p === '/api/runs' && req.method === 'POST') {
          const body = await readBody(req);
          const { run } = manager.start({ prompt: body.prompt, explicitGoal: body.explicitGoal, provider: body.provider, baseline: !!body.baseline, parentRunId: body.parentRunId || null, clarificationAnswer: body.clarificationAnswer });
          return send(res, 202, { id: run.id, state: run.state });
        }
        const m = p.match(/^\/api\/runs\/([A-Za-z0-9-]+)(\/export|\/prompt\/([A-Za-z0-9]+)\/(\d+))?$/);
        if (m && req.method === 'GET') {
          const run = store.load(m[1]);
          if (!run) return send(res, 404, { error: 'Běh nenalezen.' });
          if (!m[2]) return send(res, 200, run);
          if (m[2] === '/export') return send(res, 200, JSON.stringify(run, null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${run.id}.json"` });
          const br = (run.branches || []).find((b) => b.id === m[3]);
          const at = br && br.attempts[parseInt(m[4], 10) - 1];
          if (!at) return send(res, 404, { error: 'Prompt nenalezen.' });
          const cp = at.compiledPrompt;
          const text = `# SYSTEM PROMPT\n${cp.system}\n\n# USER PROMPT (stdin)\n${cp.text}`;
          return send(res, 200, text, { 'Content-Disposition': `attachment; filename="${run.id}-${br.id}-pokus${m[4]}-prompt.md"` });
        }
        return send(res, 404, { error: 'Neznámý endpoint.' });
      }

      // statické soubory
      const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
      const file = path.resolve(publicDir, rel);
      if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Nenalezeno');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'" });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      const code = e.code === 'BUSY' ? 409 : ['BAD_INPUT', 'BAD_PARENT', 'BAD_PROVIDER', 'BAD_JSON', 'TOO_LARGE'].includes(e.code) ? 400 : 500;
      send(res, code, { error: e.message, code: e.code || 'INTERNAL' });
    }
  });

  return { server, store, manager, getPreflight, providers };
}

if (require.main === module) {
  const config = loadConfig();
  const port = parseInt(process.env.FR_PORT || config.server.port, 10);
  const { server, getPreflight } = createServer({ config });
  server.listen(port, '127.0.0.1', () => {
    console.log(`FRANKENSTEIN v0.3.1 běží na http://127.0.0.1:${port}`);
    console.log(`Výchozí provider: ${config.defaultProvider}. Preflight Claude CLI běží na pozadí (bez inference).`);
    getPreflight(true).then((pf) => {
      console.log(`Preflight Claude CLI: ${pf.ok ? 'OK — reálná inference povolena' : 'NEPROŠEL — reálná inference zablokována (mock funguje)'}`);
      for (const c of pf.checks) console.log(`  [${c.status}] ${c.label}: ${c.detail}`);
    }).catch((e) => console.log('Preflight selhal:', e.message));
  });
}

module.exports = { createServer };
