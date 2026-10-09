'use strict';
/**
 * Bezpečnostní preflight před jakoukoli reálnou inferencí (§13 zadání).
 * Fail-closed: cokoli neověřitelného = FAIL. Neexistuje žádná náhradní placená cesta.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { sanitizedEnv, riskyEnvPresent, discoverCli, cmpVersion } = require('./cliEnv');

const REQUIRED_FLAGS = ['--print', '--output-format', '--model', '--tools', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--system-prompt', '--permission-prompts'];

const SUBSCRIPTION_AUTH = /^(claude\.?ai|claudeai|oauth|oauth_token|subscription)$/i;
const API_AUTH = /(api[_\s-]?key|apikeyhelper|console|bedrock|vertex|foundry|third[_\s-]?party)/i;

function runCli(exe, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(exe, args, { env: sanitizedEnv(), cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

function maskEmails(s) { return String(s || '').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<e-mail>'); }

function settingsFiles() {
  const home = os.homedir();
  const files = [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')];
  if (process.platform === 'win32') {
    files.push('C:\\Program Files\\ClaudeCode\\managed-settings.json', 'C:\\ProgramData\\ClaudeCode\\managed-settings.json');
  } else if (process.platform === 'darwin') {
    files.push('/Library/Application Support/ClaudeCode/managed-settings.json');
  } else {
    files.push('/etc/claude-code/managed-settings.json');
  }
  return files;
}

/** Hledá v nastavení Claude Code cokoli, co by přepnulo autentizaci na API/3P. */
function inspectSettings(files = settingsFiles()) {
  const findings = [];
  const inspected = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    inspected.push(f);
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { findings.push(`${f}: nelze parsovat (fail-closed)`); continue; }
    if (j.apiKeyHelper) findings.push(`${f}: apiKeyHelper`);
    if (j.awsAuthRefresh || j.awsCredentialExport) findings.push(`${f}: AWS přihlašování`);
    const env = j.env || {};
    for (const k of Object.keys(env)) {
      if (/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY|ANTHROPIC_BASE_URL)$/.test(k)) findings.push(`${f}: env.${k}`);
    }
  }
  return { findings, inspected };
}

function parseAuthStatus(text) {
  try { return JSON.parse(String(text).trim()); } catch (_) {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { /* nic */ } }
  }
  return null;
}

/** Vyhodnocení auth status — čistá funkce (testovatelná bez CLI). */
function evaluateAuth(status) {
  const checks = [];
  if (!status) {
    checks.push({ id: 'auth_status', status: 'FAIL', label: 'claude auth status', detail: 'Výstup nelze přečíst.' });
    return checks;
  }
  checks.push({ id: 'auth_logged_in', status: status.loggedIn === true ? 'PASS' : 'FAIL', label: 'Přihlášení CLI', detail: status.loggedIn === true ? 'loggedIn=true' : 'CLI není přihlášeno (v čistém prostředí). Přihlaste se předplatným: claude auth login.' });
  const m = String(status.authMethod || '');
  let st;
  let detail;
  if (API_AUTH.test(m) || status.apiKeySource) { st = 'FAIL'; detail = `Metoda „${m}“${status.apiKeySource ? `, apiKeySource=${status.apiKeySource}` : ''} = API fakturace — zakázáno.`; }
  else if (SUBSCRIPTION_AUTH.test(m)) { st = 'PASS'; detail = `Metoda „${m}“ = přihlášení předplatným Claude.`; }
  else { st = 'FAIL'; detail = `Metoda „${m || 'none'}“ nepotvrzuje předplatné (fail-closed).`; }
  checks.push({ id: 'auth_method_subscription', status: st, label: 'Autentizace předplatným', detail });
  checks.push({ id: 'api_provider_first_party', status: status.apiProvider === 'firstParty' ? 'PASS' : 'FAIL', label: 'Poskytovatel', detail: `apiProvider=${status.apiProvider}` });
  if (status.subscriptionType !== undefined) checks.push({ id: 'subscription_type', status: status.subscriptionType ? 'PASS' : 'FAIL', label: 'Typ předplatného', detail: String(status.subscriptionType) });
  return checks;
}

function evaluateBilling(billing) {
  const ok = billing && billing.extraUsageDisabledAttested === true && billing.extraUsageAttestedAt && billing.extraUsageAttestedBy;
  return {
    id: 'extra_usage_attested', label: 'Placená extra usage vypnutá', status: ok ? 'PASS' : 'FAIL',
    detail: ok ? `Potvrdil(a) ${billing.extraUsageAttestedBy} dne ${billing.extraUsageAttestedAt} (ruční ověření v claude.ai).`
      : 'Z CLI nelze ověřit. Zkontrolujte v claude.ai → Settings → Usage, že extra usage je VYPNUTÁ, a potvrďte v config/fr.config.json (billing.extraUsageDisabledAttested, …AttestedBy, …AttestedAt).',
    manual: true,
  };
}

function evaluateLimits(limits) {
  const problems = [];
  if (limits.maxRepairPasses > 1) problems.push('maxRepairPasses > 1');
  if (limits.parallelism !== 1) problems.push('parallelism ≠ 1');
  if (limits.maxModelCallsPerRun > 20) problems.push('maxModelCallsPerRun > 20');
  if (limits.maxRetriesPerCall > 1) problems.push('maxRetriesPerCall > 1');
  return { id: 'limits', label: 'Limity (opravy, paralelismus, volání)', status: problems.length ? 'FAIL' : 'PASS', detail: problems.length ? problems.join(', ') : `max. ${limits.maxModelCallsPerRun} volání/běh, ${limits.maxRepairPasses} oprava, paralelismus 1, ${limits.maxRetriesPerCall} opakování/volání` };
}

async function runPreflight(config, { exec = runCli } = {}) {
  const pc = config.providers['claude-cli'];
  const checks = [];
  const at = new Date().toISOString();
  let status = null;
  const cli = discoverCli(pc.command);
  checks.push({ id: 'cli_found', status: cli.path ? 'PASS' : 'FAIL', label: 'Claude Code CLI nalezeno', detail: cli.path ? `${cli.path} (${cli.source})` : `Nenalezeno. Zkoušeno: ${cli.tried.join(', ')}` });
  if (!cli.path) return finish();

  if (process.platform === 'win32' && !/\.exe$/i.test(cli.path)) {
    checks.push({ id: 'cli_native', status: 'FAIL', label: 'Nativní spustitelný soubor', detail: 'Na Windows je podporováno jen claude.exe (bez shellu).' });
    return finish();
  }

  const v = await exec(cli.path, ['--version']);
  const ver = (String(v.out).match(/(\d+\.\d+\.\d+)/) || [])[1];
  checks.push({ id: 'cli_version', status: ver && cmpVersion(ver, pc.minCliVersion) >= 0 ? 'PASS' : 'FAIL', label: 'Verze CLI', detail: ver ? `${ver} (min. ${pc.minCliVersion})` : `Nezjištěna: ${maskEmails(v.err).slice(0, 200)}` });

  const h = await exec(cli.path, ['--help']);
  const missing = REQUIRED_FLAGS.filter((f) => !String(h.out).includes(f));
  checks.push({ id: 'cli_flags', status: missing.length ? 'FAIL' : 'PASS', label: 'Podporované parametry (izolace)', detail: missing.length ? `Chybí: ${missing.join(', ')}` : `OK: ${REQUIRED_FLAGS.join(' ')}. --bare se nepoužívá (vynucuje API klíč).` });

  const a = await exec(cli.path, ['auth', 'status', '--json']);
  status = parseAuthStatus(a.out);
  checks.push(...evaluateAuth(status));

  const risky = riskyEnvPresent();
  checks.push({ id: 'env_api_credentials', status: risky.length ? 'WARN' : 'PASS', label: 'API credentials v prostředí', detail: risky.length ? `V prostředí FR jsou ${risky.join(', ')} — do CLI se NEPŘEDÁVAJÍ (whitelist prostředí).` : 'Žádné; do CLI se navíc předává jen whitelist proměnných.' });

  const s = inspectSettings();
  checks.push({ id: 'settings_no_api_auth', status: s.findings.length ? 'FAIL' : 'PASS', label: 'Nastavení bez apiKeyHelper / API env', detail: s.findings.length ? s.findings.join('; ') : `Zkontrolováno: ${s.inspected.length ? s.inspected.join(', ') : 'žádné soubory nastavení neexistují'}` });

  checks.push(evaluateBilling(config.billing));
  checks.push({ id: 'isolation', status: 'PASS', label: 'Izolace volání', detail: 'Každé volání: nový proces, --safe-mode (bez CLAUDE.md, hooků, pluginů, MCP), --strict-mcp-config bez serverů, --tools "" (žádné nástroje), --no-session-persistence, --disable-slash-commands, prázdný pracovní adresář, prompt jen přes stdin.' });
  checks.push(evaluateLimits(config.limits));
  return finish();

  function finish() {
    const ok = checks.every((c) => c.status === 'PASS' || c.status === 'WARN');
    return { ok, at, cliPath: cli.path, cliVersion: (checks.find((c) => c.id === 'cli_version') || {}).detail || null, authMethod: status ? status.authMethod : null, checks };
  }
}

module.exports = { runPreflight, evaluateAuth, evaluateBilling, evaluateLimits, inspectSettings, parseAuthStatus, REQUIRED_FLAGS, runCli };
