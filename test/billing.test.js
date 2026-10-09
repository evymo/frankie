'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateAuth, evaluateBilling, evaluateLimits, inspectSettings, runPreflight } = require('../src/providers/preflight');
const { sanitizedEnv, riskyEnvPresent } = require('../src/providers/cliEnv');
const { ClaudeCliProvider, buildArgs, parseCliResult } = require('../src/providers/claudeCli');
const { createProviders, ALLOWED_PROVIDER_IDS } = require('../src/providers');
const { createRun, runPipeline } = require('../src/core/pipeline');
const { testConfig } = require('./helpers');

const st = (checks, id) => (checks.find((c) => c.id === id) || {}).status;

test('Auth: předplatné PASS; API klíč, 3P provider a nepřihlášení FAIL (fail-closed)', () => {
  let c = evaluateAuth({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
  assert.ok(c.every((x) => x.status === 'PASS'));
  c = evaluateAuth({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' });
  assert.equal(st(c, 'auth_method_subscription'), 'FAIL');
  c = evaluateAuth({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' });
  assert.equal(st(c, 'auth_method_subscription'), 'FAIL');
  c = evaluateAuth({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' });
  assert.equal(st(c, 'api_provider_first_party'), 'FAIL');
  c = evaluateAuth({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });
  assert.equal(st(c, 'auth_logged_in'), 'FAIL');
  assert.equal(st(c, 'auth_method_subscription'), 'FAIL');
  c = evaluateAuth({ loggedIn: true, authMethod: 'neco_noveho', apiProvider: 'firstParty' });
  assert.equal(st(c, 'auth_method_subscription'), 'FAIL', 'neznámá metoda = FAIL');
  assert.equal(evaluateAuth(null)[0].status, 'FAIL');
});

test('Extra usage: bez ručního potvrzení nelze reálnou inferenci povolit', () => {
  assert.equal(evaluateBilling({ extraUsageDisabledAttested: false }).status, 'FAIL');
  assert.equal(evaluateBilling({ extraUsageDisabledAttested: true }).status, 'FAIL');
  assert.equal(evaluateBilling({ extraUsageDisabledAttested: true, extraUsageAttestedBy: 'Martin', extraUsageAttestedAt: '2026-10-09' }).status, 'PASS');
});

test('Limity: více oprav, paralelismus nebo opakování = FAIL', () => {
  assert.equal(evaluateLimits({ maxRepairPasses: 1, parallelism: 1, maxModelCallsPerRun: 14, maxRetriesPerCall: 1 }).status, 'PASS');
  assert.equal(evaluateLimits({ maxRepairPasses: 2, parallelism: 1, maxModelCallsPerRun: 14, maxRetriesPerCall: 1 }).status, 'FAIL');
  assert.equal(evaluateLimits({ maxRepairPasses: 1, parallelism: 3, maxModelCallsPerRun: 14, maxRetriesPerCall: 1 }).status, 'FAIL');
});

test('Nastavení: apiKeyHelper nebo API env v settings = FAIL', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-set-'));
  const ok = path.join(d, 'ok.json');
  const bad = path.join(d, 'bad.json');
  const bad2 = path.join(d, 'bad2.json');
  fs.writeFileSync(ok, JSON.stringify({ theme: 'dark' }));
  fs.writeFileSync(bad, JSON.stringify({ apiKeyHelper: '/bin/key.sh' }));
  fs.writeFileSync(bad2, JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-x' } }));
  assert.deepEqual(inspectSettings([ok]).findings, []);
  assert.equal(inspectSettings([bad]).findings.length, 1);
  assert.equal(inspectSettings([bad2]).findings.length, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('Prostředí CLI: whitelist odstraní API klíče, 3P přepínače i hostitelské tokeny', () => {
  const env = sanitizedEnv({ PATH: 'x', USERPROFILE: 'u', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 'h', AWS_SECRET_ACCESS_KEY: 'a', FOO: 'bar' });
  assert.deepEqual(Object.keys(env).sort(), ['PATH', 'USERPROFILE']);
  assert.deepEqual(riskyEnvPresent({ ANTHROPIC_API_KEY: 'sk' }), ['ANTHROPIC_API_KEY']);
});

test('Argumenty CLI: izolace a žádný --bare; uživatelský text jen přes stdin', () => {
  const a = buildArgs({ model: 'claude-sonnet-5-5', system: 'SYS' });
  for (const f of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--tools') + 1], '');
  assert.equal(a[a.indexOf('--model') + 1], 'claude-sonnet-5-5');
  assert.ok(!a.includes('--bare'));
  assert.ok(!a.includes('--dangerously-skip-permissions'));
});

test('Registr providerů neobsahuje žádnou API/placenou cestu', () => {
  assert.deepEqual([...ALLOWED_PROVIDER_IDS], ['mock', 'claude-cli']);
  assert.deepEqual(Object.keys(createProviders(testConfig())).sort(), ['claude-cli', 'mock']);
  const src = fs.readdirSync(path.join(__dirname, '..', 'src'), { recursive: true }).filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
  assert.ok(!/api\.anthropic\.com|@anthropic-ai\/sdk|x-api-key/i.test(src), 'zdrojový kód nesmí volat Anthropic API přímo');
});

test('CLI provider: bez úspěšného preflightu odmítne volání', async () => {
  const p = new ClaudeCliProvider({ config: testConfig(), sandboxDir: path.join(os.tmpdir(), 'fr-test-sb'), preflightFn: async () => ({ ok: false, checks: [] }) });
  await assert.rejects(() => p.call({ system: 's', prompt: 'p' }), /BILLING_GUARD/);
  await p.preflight();
  await assert.rejects(() => p.call({ system: 's', prompt: 'p' }), /BILLING_GUARD/);
});

test('Pipeline: neúspěšný preflight = FAILED/BILLING_GUARD, nula modelových volání, žádný fallback', async () => {
  const config = testConfig();
  let called = 0;
  const p = new ClaudeCliProvider({ config, sandboxDir: path.join(os.tmpdir(), 'fr-test-sb'), preflightFn: async () => ({ ok: false, at: 'now', checks: [{ id: 'auth_logged_in', status: 'FAIL' }] }) });
  const origCall = p.call.bind(p);
  p.call = (r) => { called++; return origCall(r); };
  const run = createRun({ prompt: 'Vypočítej 2+2', provider: 'claude-cli', config });
  await runPipeline({ run, provider: p, config, persist: () => {} });
  assert.equal(run.state, 'FAILED');
  assert.equal(run.error.code, 'BILLING_GUARD');
  assert.equal(called, 0);
  assert.equal(run.telemetry.summary.calls, 0);
  assert.equal(run.provider.id, 'claude-cli');
});

test('Preflight (integrace s falešným spouštěčem): nepřihlášené CLI → neprojde', async () => {
  const config = testConfig();
  config.providers['claude-cli'] = { ...config.providers['claude-cli'], command: process.execPath };
  config.billing = { ...config.billing, extraUsageDisabledAttested: false };
  const exec = async (exe, args) => {
    if (args[0] === '--version') return { code: 0, out: '2.1.293 (Claude Code)', err: '' };
    if (args[0] === '--help') return { code: 0, out: '--print --output-format --model --tools --safe-mode --strict-mcp-config --no-session-persistence --disable-slash-commands --system-prompt --permission-prompts', err: '' };
    return { code: 1, out: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }), err: '' };
  };
  const pf = await runPreflight(config, { exec });
  assert.equal(pf.ok, false);
  assert.equal(st(pf.checks, 'cli_flags'), 'PASS');
  assert.equal(st(pf.checks, 'auth_logged_in'), 'FAIL');
  assert.equal(st(pf.checks, 'extra_usage_attested'), 'FAIL');
});

test('CLI adaptér (falešné CLI): stdin, izolační argumenty, čisté prostředí, telemetrie z CLI', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test-must-not-leak';
  try {
    const p = new ClaudeCliProvider({
      config: testConfig(), sandboxDir: path.join(os.tmpdir(), 'fr-test-sb'),
      preflightFn: async () => ({ ok: true, cliPath: process.execPath, authMethod: 'claude.ai', at: 'now', checks: [] }),
      commandPrefixArgs: [path.join(__dirname, 'fixtures', 'fake-claude.js')],
    });
    await p.preflight();
    const r = await p.call({ system: 'SYSTEM', prompt: 'Uživatelský prompt „s diakritikou“ a $(nebezpečné) `věci`' });
    const rep = JSON.parse(r.text);
    assert.equal(rep.hasSafeMode, true);
    assert.equal(rep.hasStrictMcp, true);
    assert.equal(rep.noPersistence, true);
    assert.equal(rep.toolsEmpty, true);
    assert.equal(rep.hasBare, false);
    assert.deepEqual(rep.forbiddenEnv, []);
    assert.equal(rep.cwdEmptyDir, true);
    assert.equal(rep.stdinHead, 'Uživatelský prompt „s diakritikou“ a $(n');
    assert.ok(!rep.args.join(' ').includes('Uživatelský'), 'uživatelský text nesmí být v argumentech');
    assert.deepEqual(r.usage, { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 700, cacheCreationTokens: 10 });
    assert.equal(r.costUsdEstimate, 0.0123);
    assert.deepEqual(r.modelVersions, ['claude-sonnet-5-5']);
    assert.equal(r.simulated, false);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('parseCliResult: chyba CLI se propaguje, structured_output má přednost', () => {
  assert.throws(() => parseCliResult(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'x' })), /CLI chyba/);
  assert.throws(() => parseCliResult('not json'), /platný JSON/);
  const r = parseCliResult(JSON.stringify({ type: 'result', subtype: 'success', result: 'text', structured_output: { a: 1 }, usage: {} }));
  assert.equal(r.text, '{"a":1}');
});
