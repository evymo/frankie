'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OpenAICompatProvider, stripThink } = require('./openaiCompat');
const { createRun, runPipeline } = require('../src/core/pipeline');
const { testConfig } = require('../test/helpers');

/** Falešný fetch: zaznamená požadavky a vrátí připravenou odpověď podle cesty. */
function fakeFetch({ models = ['exec-m', 'judge-m'], roots = {}, reply = '{"ok":true}', status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body, redirect: init.redirect });
    if (status !== 200) return { ok: false, status, text: async () => 'chyba serveru' };
    if (url.endsWith('/models')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: models.map((id) => ({ id, root: roots[id] || `org/${id}` })) }) };
    const content = typeof reply === 'function' ? reply(body) : reply;
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: body.model, choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } }) };
  };
  fn.calls = calls;
  return fn;
}

test('stripThink: odstraní bloky uvažování, JSON zůstane parsovatelný', () => {
  assert.equal(stripThink('<think>{"x": úvaha}</think>\n{"a":1}'), '{"a":1}');
  assert.equal(stripThink('nedokončená úvaha</think>{"a":1}'), '{"a":1}');
  assert.equal(stripThink('{"a":1}'), '{"a":1}');
});

test('openai-compatible: bez úspěšného preflightu žádné volání (fail-closed)', async () => {
  const f = fakeFetch({ models: ['jiny-model'] });
  const p = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'exec-m', fetchFn: f });
  await assert.rejects(p.call({ task: 'gate0', system: 's', prompt: 'p' }), /preflight/);
  const pf = await p.preflight();
  assert.equal(pf.ok, false);
  assert.match(pf.checks[0].detail, /nenalezen/);
  await assert.rejects(p.call({ task: 'gate0', system: 's', prompt: 'p' }), /preflight/);
  assert.ok(f.calls.every((c) => c.url.endsWith('/models')), 'žádné /chat/completions');
});

test('openai-compatible: soudce ≠ vykonavatel — semantic_verify jde na judgeModel, ostatní na model', async () => {
  const f = fakeFetch();
  const p = new OpenAICompatProvider({ baseUrl: 'http://exec/v1', model: 'exec-m', judgeBaseUrl: 'http://judge/v1', judgeModel: 'judge-m', fetchFn: f });
  assert.equal((await p.preflight()).ok, true);
  const e = await p.call({ task: 'execute', system: 's', prompt: 'p' });
  const j = await p.call({ task: 'semantic_verify', system: 's', prompt: 'p' });
  const chats = f.calls.filter((c) => c.url.endsWith('/chat/completions'));
  assert.equal(chats[0].url, 'http://exec/v1/chat/completions');
  assert.equal(chats[0].body.model, 'exec-m');
  assert.equal(chats[1].url, 'http://judge/v1/chat/completions');
  assert.equal(chats[1].body.model, 'judge-m');
  assert.deepEqual([e.role, j.role, e.model, j.model], ['executor', 'judge', 'exec-m', 'judge-m']);
  assert.deepEqual(e.usage, { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 });
});

test('openai-compatible: JSON režim jen pro FR úlohy; čistý dotaz (json:false) bez response_format', async () => {
  const f = fakeFetch();
  const p = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'exec-m', fetchFn: f, allowSameJudge: true, extraBody: { chat_template_kwargs: { enable_thinking: false } } });
  assert.equal((await p.preflight()).ok, true);
  await p.call({ task: 'gate0', system: 's', prompt: 'p' });
  await p.call({ task: 'raw', system: 's', prompt: 'p', json: false });
  const [fr, raw] = f.calls.filter((c) => c.url.endsWith('/chat/completions'));
  assert.deepEqual(fr.body.response_format, { type: 'json_object' });
  assert.equal(raw.body.response_format, undefined);
  assert.deepEqual(fr.body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(fr.body.temperature, 0);
});

test('openai-compatible: klíč jen z proměnné prostředí, chyba HTTP se propaguje', async () => {
  process.env.FR_TEST_OAI_KEY = 'tajne-123';
  try {
    const f = fakeFetch();
    const p = new OpenAICompatProvider({ baseUrl: 'http://x/v1', apiKeyEnv: 'FR_TEST_OAI_KEY', model: 'exec-m', fetchFn: f });
    await p.preflight();
    assert.equal(f.calls[0].headers.authorization, 'Bearer tajne-123');
    assert.ok(!JSON.stringify(p.describe()).includes('tajne-123'), 'klíč není v popisu providera');
    assert.equal(f.calls[0].redirect, 'error', 'přesměrování se nenásleduje');
    const bad = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'exec-m', fetchFn: fakeFetch({ status: 500 }) });
    bad.lastPreflight = { ok: true };
    await assert.rejects(bad.call({ task: 'gate0', system: 's', prompt: 'p' }), /HTTP 500/);
  } finally {
    delete process.env.FR_TEST_OAI_KEY;
  }
});

test('openai-compatible: nedostupný server → běh FR skončí řízeně ve FAILED bez inference', async () => {
  const cfg = testConfig();
  const f = async () => { throw new Error('ECONNREFUSED'); };
  const p = new OpenAICompatProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'exec-m', fetchFn: f });
  const run = createRun({ prompt: 'Vypočítej 2+2.', provider: p.id, config: cfg });
  await runPipeline({ run, provider: p, config: cfg, persist: () => {} });
  assert.equal(run.state, 'FAILED');
  assert.equal(run.telemetry.calls.length, 0);
});

test('K9: bez soudce preflight NEPROJDE; výslovná výjimka projde jen s evidencí k9:false', async () => {
  const p = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'exec-m', fetchFn: fakeFetch() });
  const pf = await p.preflight();
  assert.equal(pf.ok, false);
  assert.match(pf.checks.find((c) => c.id === 'soudce_nezavisly').detail, /soudce chybí/);
  await assert.rejects(p.call({ task: 'gate0', system: 's', prompt: 'p' }), /preflight/);
  const w = new OpenAICompatProvider({ baseUrl: 'http://x/v1', model: 'exec-m', fetchFn: fakeFetch(), allowSameJudge: true });
  assert.equal((await w.preflight()).ok, true);
  assert.equal(w.describe().k9, false);
  assert.match(w.describe().label, /K9 ne/);
});

test('K9: soudce pod jiným jménem, ale se stejnými vahami (root) = vykonavatel → preflight NEPROJDE', async () => {
  const f = fakeFetch({ roots: { 'exec-m': 'org/qwen-27b', 'judge-m': 'org/qwen-27b' } });
  const p = new OpenAICompatProvider({ baseUrl: 'http://e/v1', model: 'exec-m', judgeBaseUrl: 'http://j/v1', judgeModel: 'judge-m', fetchFn: f });
  const pf = await p.preflight();
  assert.equal(pf.ok, false);
  assert.match(pf.checks.find((c) => c.id === 'soudce_nezavisly').detail, /stejný root/);
  const ok = new OpenAICompatProvider({ baseUrl: 'http://e/v1', model: 'exec-m', judgeBaseUrl: 'http://j/v1', judgeModel: 'judge-m', fetchFn: fakeFetch() });
  assert.equal((await ok.preflight()).ok, true);
  assert.equal(ok.describe().k9, true);
  assert.deepEqual(ok.describe().identity, { executor: { served: 'exec-m', root: 'org/exec-m' }, judge: { served: 'judge-m', root: 'org/judge-m' } });
});

test('Evidence nenese adresu lane: describe, billingInfo, preflight ani chyby neobsahují host/port', async () => {
  const host = 'lane-gpu.internal.example:8123';
  const p = new OpenAICompatProvider({ baseUrl: `http://${host}/v1`, model: 'exec-m', judgeBaseUrl: `http://${host}/j/v1`, judgeModel: 'judge-m', fetchFn: fakeFetch() });
  const pf = await p.preflight();
  const down = new OpenAICompatProvider({ baseUrl: `http://${host}/v1`, model: 'exec-m', fetchFn: async () => { throw new Error('ECONNREFUSED'); }, allowSameJudge: true });
  const pfDown = await down.preflight();
  const evidence = JSON.stringify([p.describe(), p.billingInfo(), pf, pfDown]);
  assert.ok(!evidence.includes('lane-gpu') && !evidence.includes('8123'), evidence);
});
