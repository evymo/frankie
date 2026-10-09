'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/server');
const { MockProvider } = require('../src/providers/mock');
const { testConfig } = require('../test/helpers');
const { attachWhenReady } = require('./serve');

/** Backend, který napoprvé preflightem neprojde (model se načítá) a napodruhé ano. Odpovědi dodává mock. */
class LateBackend {
  constructor() { this.id = 'late-backend'; this.model = 'late-m'; this.simulated = false; this.requiresPreflight = true; this.attempts = 0; this.mock = new MockProvider({}); }
  async preflight() { this.attempts++; return { ok: this.attempts >= 2, checks: [{ id: 'model', ok: this.attempts >= 2, status: this.attempts >= 2 ? 'PASS' : 'FAIL', label: 'Model', detail: this.attempts >= 2 ? 'připraven' : 'načítá se' }] }; }
  describe() { return { id: this.id, model: this.model, simulated: false, label: 'Pozdní backend' }; }
  billingInfo() { return { mode: 'test' }; }
  models() { return [{ id: this.model, label: 'Pozdní backend' }]; }
  withModel() { return this; }
  async call(req) { return { ...(await this.mock.call(req)), simulated: false }; }
}

async function req(port, method, p, body) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}

test('serve: backend, který napoprvé neprojde preflightem, se připojí za běhu — objeví se v /api/status a přijme běh', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-serve-test-'));
  const config = testConfig();
  const providers = { mock: new MockProvider({ model: config.providers.mock.model }) };
  const late = new LateBackend();
  assert.equal((await late.preflight()).ok, false, 'při startu nepřipraven');
  const pending = [late];
  const { server, getPreflight } = createServer({ config, dataDir, providers });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  let st = (await req(port, 'GET', '/api/status')).body;
  st = st.status || st;
  assert.ok(!st.providers.some((p) => p.id === 'late-backend'), 'před připojením v nabídce není');
  const stop = attachWhenReady({ pending, providers, getPreflight, intervalMs: 20, log: () => {} });
  try {
    for (let i = 0; i < 100 && pending.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(pending.length, 0, 'backend připojen');
    st = (await req(port, 'GET', '/api/status')).body;
    st = st.status || st;
    const listed = st.providers.find((p) => p.id === 'late-backend');
    assert.ok(listed, 'po připojení je v /api/status');
    assert.equal(listed.label, 'Pozdní backend');
    assert.equal(st.preflights['late-backend'].ok, true);
    const run = await req(port, 'POST', '/api/runs', { prompt: 'Vypočítej 2+3.', provider: 'late-backend' });
    assert.ok(run.status < 300, `běh přijat (HTTP ${run.status}: ${JSON.stringify(run.body).slice(0, 200)})`);
    const id = (run.body.run || run.body).id;
    for (let i = 0; i < 200; i++) { const s = (await req(port, 'GET', '/api/status')).body; if (!(s.status || s).busy) break; await new Promise((r) => setTimeout(r, 25)); }
    const done = (await req(port, 'GET', `/api/runs/${id}`)).body;
    assert.equal((done.run || done).provider.id, 'late-backend');
  } finally {
    stop();
    await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
