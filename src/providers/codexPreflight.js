'use strict';
const { runCli, evaluateLimits } = require('./preflight');
const { discoverCodexCli, cmpVersion } = require('./cliEnv');
const REQUIRED_FLAGS = ['--json', '--model', '--sandbox', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--config'];
const DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'view_image', 'apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'image_generation', 'goals', 'skill_search', 'tool_suggest', 'code_mode', 'code_mode_host', 'workspace_dependencies', 'sleep_tool', 'skip_host_skill_discovery'];
function evaluateCodexAuth(result) {
  return result.code === 0 && /^Logged in using ChatGPT\s*$/i.test((result.out + '\n' + result.err).trim());
}
function evaluateCodexBilling(billing) {
  const ok = billing && billing.creditUsageDisabledAttested === true &&
    typeof billing.creditUsageAttestedBy === 'string' && billing.creditUsageAttestedBy.trim() &&
    typeof billing.creditUsageAttestedAt === 'string' && billing.creditUsageAttestedAt.trim();
  return { id: 'credit_usage_attested', status: ok ? 'PASS' : 'FAIL', label: 'Codex: placené kredity nepovoleny', manual: true,
    detail: ok ? 'Ruční potvrzení: ' + billing.creditUsageAttestedBy + ' (' + billing.creditUsageAttestedAt + ').'
      : 'Ověřte v nastavení účtu Codex použití placených kreditů. Potvrďte billing.codex.creditUsageDisabledAttested, creditUsageAttestedBy a creditUsageAttestedAt. Potvrzení Claude se nepřebírá.' };
}
async function runCodexPreflight(config, { exec = runCli, discover = discoverCodexCli } = {}) {
  const pc = config.providers['codex-cli'];
  const cli = discover(pc.command);
  const checks = [];
  const at = new Date().toISOString();
  let authMethod = null;
  const add = (id, ok, label, detail) => checks.push({ id, status: ok ? 'PASS' : 'FAIL', label, detail });
  add('cli_found', !!cli.path, 'Codex CLI nalezeno', cli.path || 'Nastavte FR_CODEX_CLI nebo providers.codex-cli.command.');
  if (!cli.path) return finish();
  if (process.platform === 'win32' && !/\.exe$/i.test(cli.path)) {
    add('cli_native', false, 'Nativní CLI', 'Na Windows je podporováno codex.exe bez shellu.'); return finish();
  }
  const v = await exec(cli.path, ['--version']);
  const version = (v.out.match(/(\d+\.\d+\.\d+)/) || [])[1];
  add('cli_version', v.code === 0 && !!version && cmpVersion(version, pc.minCliVersion) >= 0, 'Verze Codex CLI', version || 'Nezjištěna.');
  const h = await exec(cli.path, ['exec', '--help']);
  const missing = REQUIRED_FLAGS.filter(f => !h.out.includes(f));
  add('cli_flags', h.code === 0 && !missing.length, 'Izolační parametry Codex', missing.length ? 'Chybí: ' + missing.join(', ') : 'Podporovány.');
  const features = await exec(cli.path, ['features', 'list']);
  const missingFeatures = DISABLED_FEATURES.filter(f => !new RegExp('^' + f + '\\s+(?!removed\\b)', 'm').test(features.out));
  add('cli_features', features.code === 0 && !missingFeatures.length, 'Vypnutí nástrojů a rozšíření', missingFeatures.length ? 'Nepodporované: ' + missingFeatures.join(', ') : 'Podporovány.');
  const auth = await exec(cli.path, ['login', 'status']);
  const subscription = evaluateCodexAuth(auth);
  authMethod = subscription ? 'chatgpt' : null;
  add('auth_method_subscription', subscription, 'Přihlášení přes ChatGPT', subscription ? 'ChatGPT přihlášení ověřeno.' : 'Přihlaste se přes codex login. API klíč ani neznámá metoda nejsou povoleny.');
  checks.push(evaluateCodexBilling(config.billing.codex));
  checks.push(evaluateLimits(config.limits));
  return finish();
  function finish() { return { ok: checks.every(c => c.status === 'PASS'), at, cliPath: cli.path, authMethod, checks }; }
}
module.exports = { runCodexPreflight, evaluateCodexAuth, evaluateCodexBilling, REQUIRED_FLAGS, DISABLED_FEATURES };
