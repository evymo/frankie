'use strict';
/**
 * Lokální HTTP server FRANKENSTEIN (jen 127.0.0.1). Bez závislostí.
 * API: stav, preflight, spuštění běhu (zámek = max. 1 běh), detail/historie, export JSON a exekučních promptů,
 * v0.4: přehled sdílené Knowledge Base (knowledge/) a řízený experiment H-sestavy (spouští jen uživatel).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./config');
const { RunStore } = require('./core/store');
const { RunManager, PHASES, STEP_LABEL, FrError, FR_VERSION } = require('./core/pipeline');
const { KnowledgeBase } = require('./core/knowledge');
const { EVALUATOR_VERSION, EVALUATOR_HISTORY } = require('./core/evaluator');
const { DEFAULT_SET } = require('./core/aspectSets');
const { createProviders } = require('./providers');
const { modelsFor } = require('./providers/models');
const { ASPECTS, ASPECT_CATALOG, CORE_ASPECT_IDS } = require('./core/aspects');
const { RULES } = require('./core/decision');

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');

function createServer({ config = loadConfig(), dataDir = DEFAULT_DATA_DIR, knowledgeDir, providers } = {}) {
  const store = new RunStore(path.join(dataDir, 'runs'));
  const interrupted = store.recoverInterrupted();
  providers = providers || createProviders(config);
  // Sdílená Knowledge Base = knowledge/ v repozitáři (jen metoda, bez textů úloh). Testy a jiné dataDir mají vlastní.
  knowledgeDir = knowledgeDir || process.env.FR_KNOWLEDGE_DIR || (path.resolve(dataDir) === DEFAULT_DATA_DIR ? path.join(ROOT, 'knowledge') : path.join(dataDir, 'knowledge'));
  const kb = new KnowledgeBase({ dir: knowledgeDir, config });
  // Jednorázový převod dřívější lokální KB (v0.4.0: data/kb/fr-kb.json). Původní soubor zůstává beze změny.
  const legacy = path.join(dataDir, 'kb', 'fr-kb.json');
  let kbMigration = null;
  if (kb.available() && !kb.manifest && fs.existsSync(legacy)) {
    try { kbMigration = { from: 'data/kb/fr-kb.json', ...kb.importLegacy(legacy) }; kb.reload(); } catch (e) { kbMigration = { from: 'data/kb/fr-kb.json', error: e.message }; }
  }
  const manager = new RunManager({ store, config, providers, kb });
  const publicDir = path.join(ROOT, 'public');
  const preflightCache = {};
  const preflightRunning = {};

  async function getPreflight(force, providerId = 'claude-cli') {
    const p = providers[providerId];
    if (!p || !p.requiresPreflight) throw new FrError('BAD_PROVIDER', 'Preflight je dostupný jen pro CLI provider.');
    if (preflightCache[providerId] && !force) return preflightCache[providerId];
    if (!preflightRunning[providerId]) preflightRunning[providerId] = p.preflight()
      .then(r => { preflightCache[providerId] = r; return r; })
      .finally(() => { delete preflightRunning[providerId]; });
    return preflightRunning[providerId];
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
            version: FR_VERSION, defaultProvider: config.defaultProvider, providers: Object.values(providers).map((x) => ({ ...x.describe(), models: modelsFor(x) })),
            preflight: preflightCache['claude-cli'] || null, preflights: preflightCache, busy: active ? { id: active.id, state: active.state } : null, limits: config.limits,
            capabilities: config.capabilities, permissions: config.permissions, aspects: ASPECTS, aspectCatalog: ASPECT_CATALOG, coreAspects: CORE_ASPECT_IDS, defaultAspectSet: DEFAULT_SET, phases: PHASES, stepLabels: STEP_LABEL, decisionRules: RULES, interruptedOnStart: interrupted,
            evaluator: { version: EVALUATOR_VERSION, history: EVALUATOR_HISTORY },
            learning: { enabled: config.learning.enabled, verifyMinWins: config.learning.verifyMinWins, realExperiments: { enabled: config.learning.realExperiments.enabled, maxPerDay: config.learning.realExperiments.maxPerDay }, kbAvailable: kb.available(), kbError: kb.error },
          });
        }
        if (p === '/api/preflight' && req.method === 'POST') {
          const body = await readBody(req);
          return send(res, 200, await getPreflight(true, body.provider || 'claude-cli'));
        }
        if (p === '/api/runs' && req.method === 'GET') return send(res, 200, store.list());
        if (p === '/api/runs' && req.method === 'POST') {
          const body = await readBody(req);
          const { run } = manager.start({ prompt: body.prompt, explicitGoal: body.explicitGoal, provider: body.provider, model: body.model, baseline: !!body.baseline, parentRunId: body.parentRunId || null, clarificationAnswer: body.clarificationAnswer, learningMode: body.learningMode === 'default' ? 'default' : 'auto' });
          return send(res, 202, { id: run.id, state: run.state });
        }
        if (p === '/api/kb' && req.method === 'GET') { if (!manager.busy()) kb.reload(); return send(res, 200, { ...kb.summary(), migration: kbMigration }); }
        if (p === '/api/experiments' && req.method === 'POST') {
          const body = await readBody(req);
          const { run } = manager.start({ provider: body.provider, experiment: { baseRunId: String(body.baseRunId || ''), recommendationId: String(body.recommendationId || ''), confirmRealCalls: body.confirmRealCalls === true } });
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
      const code = e.code === 'BUSY' ? 409 : e.code === 'NOT_AUTHORIZED' ? 403 : ['BAD_INPUT', 'BAD_PARENT', 'BAD_PROVIDER', 'BAD_MODEL', 'BAD_JSON', 'TOO_LARGE', 'BAD_EXPERIMENT'].includes(e.code) ? 400 : 500;
      send(res, code, { error: e.message, code: e.code || 'INTERNAL' });
    }
  });

  return { server, store, manager, getPreflight, providers, kb, kbMigration };
}

if (require.main === module) {
  const config = loadConfig();
  const port = parseInt(process.env.FR_PORT || config.server.port, 10);
  const { server, getPreflight } = createServer({ config });
  server.listen(port, '127.0.0.1', () => {
    console.log(`FRANKENSTEIN v${FR_VERSION} běží na http://127.0.0.1:${port}`);
    console.log('Výchozí provider: ' + config.defaultProvider + '. Preflight CLI běží na pozadí (bez inference).');
    for (const id of ['claude-cli', 'codex-cli']) {
      getPreflight(true, id).then(pf => {
        console.log('Preflight ' + id + ': ' + (pf.ok ? 'OK' : 'NEPROŠEL — mock funguje'));
        for (const c of pf.checks) console.log('  [' + c.status + '] ' + c.label + ': ' + c.detail);
      }).catch(e => console.error('Preflight ' + id + ' selhal:', e.message));
    }

  });
}

module.exports = { createServer };
