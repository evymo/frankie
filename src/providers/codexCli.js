'use strict';
/** Codex CLI přes ChatGPT přihlášení; prompt pouze stdin, nový proces pro každé volání. */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizedEnv, cmpVersion } = require('./cliEnv');
const { runCodexPreflight, DISABLED_FEATURES } = require('./codexPreflight');

function buildArgs({ model, effort }) {
  const args = ['exec', '--json', '--model', model, '--sandbox', 'read-only', '--ephemeral',
    '--ignore-user-config', '--skip-git-repo-check', '--color', 'never',
    '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'developer_instructions="Interpret only instructions and input provided on stdin. Do not use tools, files, network, skills or external actions. Return only the requested answer."'];
  for (const feature of DISABLED_FEATURES) args.push('-c', 'features.' + feature + '=' + (feature === 'skip_host_skill_discovery' ? 'true' : 'false'));
  if (effort) args.push('-c', 'model_reasoning_effort=' + JSON.stringify(effort));
  args.push('-');
  return args;
}
function parseCodexResult(stdout) {
  let events;
  try { events = String(stdout).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (_) { throw new Error('Codex CLI nevrátilo platný JSONL.'); }
  let text = null;
  let completed = null;
  let sessionId = null;
  for (const e of events) {
    if (!e || typeof e !== 'object') throw new Error('Neplatná událost Codex CLI.');
    if (e.type === 'error' || e.type === 'turn.failed') throw new Error('Codex CLI chyba: ' + String(e.message || e.error?.message || 'turn.failed').slice(0, 300));
    if (e.type === 'thread.started') sessionId = e.thread_id;
    if (e.item && !['agent_message', 'reasoning'].includes(e.item.type)) throw new Error('Codex CLI použilo nepovolený nástroj: ' + e.item.type);
    if (e.type === 'item.completed' && e.item?.type === 'agent_message') {
      if (typeof e.item.text !== 'string') throw new Error('Neplatný agent_message.');
      text = e.item.text;
    }
    if (e.type === 'turn.completed') completed = e;
  }
  if (!completed || text === null) throw new Error('Codex CLI nevrátilo dokončený výsledek.');
  const u = completed.usage;
  if (!u || !['input_tokens', 'output_tokens', 'cached_input_tokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0)) throw new Error('Neplatná telemetrie Codex CLI.');
  if (u.cached_input_tokens > u.input_tokens) throw new Error('Cache překračuje vstupní tokeny Codex CLI.');
  return { text, usage: { inputTokens: u.input_tokens - u.cached_input_tokens, outputTokens: u.output_tokens, cacheReadTokens: u.cached_input_tokens, cacheCreationTokens: 0 },
    modelVersions: [], apiDurationMs: null, costUsdEstimate: null, sessionId, numTurns: 1 };
}
function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) { /* proces už skončil */ }
}
class CodexCliProvider {
  constructor({ config, sandboxDir, preflightFn = runCodexPreflight, commandPrefixArgs = [] }) {
    this.id = 'codex-cli'; this.config = config; this.pc = config.providers[this.id]; this.model = this.pc.model;
    this.simulated = false; this.requiresPreflight = true;
    this.sandboxDir = sandboxDir; this.preflightFn = preflightFn; this.commandPrefixArgs = commandPrefixArgs;
    this.lastPreflight = null;
    fs.mkdirSync(sandboxDir, { recursive: true });
  }
  describe() { return { id: this.id, model: this.model, simulated: false, cli: this.lastPreflight?.cliPath || null }; }
  withModel(entry) {
    const pc = { ...this.pc, model: entry.id };
    if (entry.minCliVersion && cmpVersion(entry.minCliVersion, pc.minCliVersion) > 0) pc.minCliVersion = entry.minCliVersion;
    const config = { ...this.config, providers: { ...this.config.providers, [this.id]: pc } };
    return new this.constructor({ config, sandboxDir: this.sandboxDir, preflightFn: this.preflightFn, commandPrefixArgs: this.commandPrefixArgs });
  }

  billingInfo() {
    return { mode: 'codex-chatgpt-subscription', authMethod: this.lastPreflight?.authMethod || null,
      preflightOk: this.lastPreflight?.ok || false, preflightAt: this.lastPreflight?.at || null,
      paidCredits: this.config.billing.codex?.creditUsageDisabledAttested ? 'ručně potvrzeno: nepovoleny' : 'NEPOTVRZENO',
      note: 'Pouze Codex CLI s ChatGPT přihlášením; žádný přímý API provider ani automatický fallback.' };
  }
  async preflight() { this.lastPreflight = await this.preflightFn(this.config); return this.lastPreflight; }
  call(req) {
    const pf = this.lastPreflight;
    if (!pf?.ok) return Promise.reject(new Error('BILLING_GUARD: Codex preflight neprošel nebo neproběhl.'));
    const cwd = fs.mkdtempSync(path.join(this.sandboxDir, 'call-'));
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(pf.cliPath, [...this.commandPrefixArgs, ...buildArgs({ model: this.model, effort: this.pc.effort })],
        { cwd, env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '', err = '', failure = null;
      const timer = setTimeout(() => { failure = new Error('Časový limit Codex CLI překročen.'); killTree(child); }, this.pc.timeoutMs);
      child.stdout.on('data', d => {
        if (out.length + d.length > 4e6) { failure = new Error('Codex CLI překročilo limit výstupu.'); killTree(child); }
        else out += d;
      });
      child.stderr.on('data', d => { if (err.length < 20000) err += d; });
      child.stdin.on('error', () => {});
      const cleanup = () => { clearTimeout(timer); fs.rmSync(cwd, { recursive: true, force: true }); };
      child.on('error', e => { cleanup(); reject(new Error('Spuštění Codex CLI selhalo: ' + e.message)); });
      child.on('close', code => {
        cleanup();
        if (failure) return reject(failure);
        if (code !== 0) return reject(new Error('Codex CLI skončilo s chybou (exit ' + code + '). ' + err.slice(0, 300)));
        try { resolve({ ...parseCodexResult(out), model: this.model, simulated: false, tokensEstimated: false, durationMs: Date.now() - start }); }
        catch (e) { reject(e); }
      });
      child.stdin.end('# INSTRUCTIONS\n' + req.system + '\n\n# INPUT\n' + req.prompt, 'utf8');
    });
  }
}
module.exports = { CodexCliProvider, buildArgs, parseCodexResult };
