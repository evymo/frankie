'use strict';
/**
 * Claude Code CLI provider (výchozí model Claude Sonnet 5.5).
 * Každé volání = nový izolovaný proces bez nástrojů, bez MCP, bez uživatelských customizací a bez perzistence relace.
 * Prompt jde výhradně přes stdin (žádný uživatelský text v argumentech příkazové řádky).
 * Volání je možné jen po úspěšném preflightu předplatitelského režimu; jinak výjimka (žádný fallback).
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizedEnv, cmpVersion } = require('./cliEnv');
const { runPreflight } = require('./preflight');

function buildArgs({ model, system, effort, maxBudgetUsd }) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--model', model,
    '--tools', '',
    '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--permission-prompts', 'none',
    '--system-prompt', system,
  ];
  if (effort) args.push('--effort', effort);
  if (maxBudgetUsd) args.push('--max-budget-usd', String(maxBudgetUsd));
  return args;
}

/** Parsuje výstup `claude -p --output-format json`. Čistá funkce (testovatelná). */
function parseCliResult(stdout) {
  let j;
  try { j = JSON.parse(String(stdout).trim()); } catch (_) { throw new Error('CLI nevrátilo platný JSON výstup.'); }
  if (Array.isArray(j)) j = j.filter((x) => x && x.type === 'result').pop();
  if (!j || typeof j !== 'object') throw new Error('CLI výstup neobsahuje výsledek.');
  if (j.is_error || (j.subtype && j.subtype !== 'success')) throw new Error(`CLI chyba: ${j.subtype || ''} ${String(j.result || j.error || '').slice(0, 300)}`.trim());
  const u = j.usage || {};
  return {
    text: typeof j.structured_output === 'object' && j.structured_output ? JSON.stringify(j.structured_output) : String(j.result ?? ''),
    usage: {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cacheReadTokens: u.cache_read_input_tokens || 0,
      cacheCreationTokens: u.cache_creation_input_tokens || 0,
    },
    modelVersions: j.modelUsage ? Object.keys(j.modelUsage) : [],
    durationMs: j.duration_ms ?? null,
    apiDurationMs: j.duration_api_ms ?? null,
    costUsdEstimate: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    sessionId: j.session_id || null,
    numTurns: j.num_turns ?? null,
  };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGKILL');
  } catch (_) { /* nic */ }
}

class ClaudeCliProvider {
  /** commandPrefixArgs slouží jen testům (falešné CLI spuštěné přes node). */
  constructor({ config, sandboxDir, preflightFn = runPreflight, commandPrefixArgs = [] }) {
    this.commandPrefixArgs = commandPrefixArgs;
    this.id = 'claude-cli';
    this.config = config;
    this.pc = config.providers['claude-cli'];
    this.model = this.pc.model;
    this.simulated = false;
    this.requiresPreflight = true;
    this.sandboxDir = sandboxDir;
    this.preflightFn = preflightFn;
    this.lastPreflight = null;
    fs.mkdirSync(sandboxDir, { recursive: true });
  }

  describe() { return { id: this.id, model: this.model, simulated: false, cli: this.lastPreflight ? this.lastPreflight.cliPath : null, note: 'Reálná inference přes Claude Code CLI (předplatné ověřené preflightem).' }; }

  withModel(entry) {
    const pc = { ...this.pc, model: entry.id };
    if (entry.minCliVersion && cmpVersion(entry.minCliVersion, pc.minCliVersion) > 0) pc.minCliVersion = entry.minCliVersion;
    const config = { ...this.config, providers: { ...this.config.providers, [this.id]: pc } };
    return new this.constructor({ config, sandboxDir: this.sandboxDir, preflightFn: this.preflightFn, commandPrefixArgs: this.commandPrefixArgs });
  }

  billingInfo() {
    const pf = this.lastPreflight;
    return {
      mode: 'claude-code-subscription',
      authMethod: pf ? pf.authMethod : null,
      preflightOk: pf ? pf.ok : false,
      preflightAt: pf ? pf.at : null,
      extraUsage: this.config.billing.extraUsageDisabledAttested ? `vypnuta — potvrzeno ručně (${this.config.billing.extraUsageAttestedBy}, ${this.config.billing.extraUsageAttestedAt})` : 'NEPOTVRZENO',
      note: 'Pouze předplatné Claude Code; API klíče a 3P provideři jsou z prostředí CLI odstraněni.',
    };
  }

  async preflight() {
    this.lastPreflight = await this.preflightFn(this.config);
    return this.lastPreflight;
  }

  call(req) {
    const pf = this.lastPreflight;
    if (!pf || !pf.ok) return Promise.reject(new Error('BILLING_GUARD: reálná inference není povolena — preflight neprošel nebo neproběhl.'));
    const args = buildArgs({ model: this.model, system: req.system, effort: this.pc.effort, maxBudgetUsd: this.pc.maxBudgetUsdPerCall });
    const cwd = fs.mkdtempSync(path.join(this.sandboxDir, 'call-'));
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(pf.cliPath, [...this.commandPrefixArgs, ...args], { cwd, env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, this.pc.timeoutMs);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Spuštění CLI selhalo: ${e.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) { /* nic */ }
        if (timedOut) return reject(new Error(`Časový limit ${this.pc.timeoutMs} ms překročen.`));
        try {
          const r = parseCliResult(out);
          resolve({ ...r, model: this.model, simulated: false, tokensEstimated: false, durationMs: r.durationMs ?? (Date.now() - t0) });
        } catch (e) {
          reject(new Error(`${e.message} (exit ${code}) ${err.slice(0, 300)}`));
        }
      });
      child.stdin.end(req.prompt, 'utf8');
    });
  }
}

module.exports = { ClaudeCliProvider, buildArgs, parseCliResult };
