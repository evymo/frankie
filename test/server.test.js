'use strict';
/** HTTP API: spuštění, zámek proti souběhu, perzistence, znovuotevření bez inference, export, ochrana Host/Origin. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createServer } = require('../src/server');
const { MockProvider } = require('../src/providers/mock');
const { ClaudeCliProvider } = require('../src/providers/claudeCli');
const { testConfig } = require('./helpers');

function req(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch (_) { /* text */ }
        resolve({ status: res.statusCode, json, text: b, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function makeProviders(config) {
  const mock = new MockProvider();
  const slow = mock.call.bind(mock);
  mock.call = async (r) => { await new Promise((ok) => setTimeout(ok, 15)); return slow(r); };
  return {
    mock,
    'claude-cli': new ClaudeCliProvider({ config, sandboxDir: path.join(os.tmpdir(), 'fr-test-sb'), preflightFn: async () => ({ ok: false, at: 'now', checks: [{ id: 'auth_logged_in', status: 'FAIL', label: 'x', detail: 'test' }] }) }),
  };
}

async function waitDone(port, id) {
  for (let i = 0; i < 400; i++) {
    const r = await req(port, 'GET', `/api/runs/${id}`);
    if (['DONE', 'FAILED', 'CLARIFICATION_REQUIRED'].includes(r.json.state)) return r.json;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('timeout');
}

test('Server: běh, zámek 409, export, prompt, historie, znovuotevření bez inference', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-srv-'));
  const config = testConfig();
  const providers = makeProviders(config);
  const { server } = createServer({ config, dataDir, providers });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  try {
    const st = await req(port, 'GET', '/api/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.aspects.length, 10);

    const r1 = await req(port, 'POST', '/api/runs', { prompt: 'Vypočítej (17*23+5)/2', provider: 'mock' });
    assert.equal(r1.status, 202);
    const r2 = await req(port, 'POST', '/api/runs', { prompt: 'Jiné zadání 1+1', provider: 'mock' });
    assert.equal(r2.status, 409, 'souběžný běh musí být odmítnut');

    const run = await waitDone(port, r1.json.id);
    assert.equal(run.state, 'DONE');
    assert.equal(run.branches[0].finalVerdict, 'UNVERIFIED', 'mock nikdy nedá PASS (simulované sémantické hodnocení)');

    const exp = await req(port, 'GET', `/api/runs/${run.id}/export`);
    assert.equal(exp.status, 200);
    assert.match(exp.headers['content-disposition'], /attachment/);
    assert.equal(JSON.parse(exp.text).id, run.id);

    const pr = await req(port, 'GET', `/api/runs/${run.id}/prompt/B1/1`);
    assert.equal(pr.status, 200);
    assert.ok(pr.text.includes('Vypočítej (17*23+5)/2'));
    assert.ok(pr.text.includes('# SYSTEM PROMPT'));

    const list = await req(port, 'GET', '/api/runs');
    assert.ok(list.json.some((x) => x.id === run.id && x.simulated === true));

    // claude-cli bez preflightu: běh selže na BILLING_GUARD bez jediného volání
    const rc = await req(port, 'POST', '/api/runs', { prompt: 'Vypočítej 1+1', provider: 'claude-cli' });
    const cr = await waitDone(port, rc.json.id);
    assert.equal(cr.state, 'FAILED');
    assert.equal(cr.error.code, 'BILLING_GUARD');
    assert.equal(cr.telemetry.calls.length, 0);

    // validace vstupu
    assert.equal((await req(port, 'POST', '/api/runs', { prompt: '   ', provider: 'mock' })).status, 400);
    assert.equal((await req(port, 'POST', '/api/runs', { prompt: 'x', provider: 'anthropic-api' })).status, 400);
    // ochrana lokálního API
    assert.equal((await req(port, 'GET', '/api/status', null, { Host: 'evil.example' })).status, 403);
    assert.equal((await req(port, 'POST', '/api/runs', { prompt: 'x' }, { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await req(port, 'GET', '/../config/fr.config.json')).status, 404);
    assert.equal((await req(port, 'GET', '/')).status, 200);
  } finally {
    server.close();
  }

  // Znovuotevření nad stejnými daty, nový server, žádná inference
  const providers2 = makeProviders(config);
  let calls = 0;
  providers2.mock.call = async () => { calls++; throw new Error('nemá být voláno'); };
  const { server: s2 } = createServer({ config, dataDir, providers: providers2 });
  await new Promise((ok) => s2.listen(0, '127.0.0.1', ok));
  try {
    const port2 = s2.address().port;
    const list = await req(port2, 'GET', '/api/runs');
    assert.ok(list.json.length >= 2);
    const done = list.json.find((x) => x.state === 'DONE');
    const again = await req(port2, 'GET', `/api/runs/${done.id}`);
    assert.equal(again.json.branches[0].finalVerdict, 'UNVERIFIED');
    assert.ok(again.json.branches[0].attempts[0].execution.output.includes('198'));
    assert.equal(calls, 0);
  } finally {
    s2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Server: nedokončený běh po restartu je označen jako přerušený (ne tiše obnoven)', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-srv-'));
  const runs = path.join(dataDir, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'RUN-X-1.json'), JSON.stringify({ id: 'RUN-X-1', state: 'EXECUTE', stateHistory: [], input: { prompt: 'x' }, createdAt: 'now' }));
  const config = testConfig();
  const { server } = createServer({ config, dataDir, providers: makeProviders(config) });
  const r = JSON.parse(fs.readFileSync(path.join(runs, 'RUN-X-1.json'), 'utf8'));
  assert.equal(r.state, 'FAILED');
  assert.equal(r.error.code, 'INTERRUPTED');
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
