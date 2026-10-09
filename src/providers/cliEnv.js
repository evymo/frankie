'use strict';
/**
 * Vyhledání Claude Code CLI a sestavení čistého prostředí pro podřízený proces.
 * Prostředí je WHITELIST — žádné ANTHROPIC_*, CLAUDE_*, AWS_*, GOOGLE_* ani hostitelské tokeny se nepropíší,
 * takže CLI nemůže potichu použít API klíč, 3P providera (Bedrock/Vertex/Foundry) ani relaci hostitelské aplikace.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENV_WHITELIST = [
  'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'PROGRAMDATA',
  'ProgramFiles', 'PROGRAMFILES', 'ProgramFiles(x86)', 'COMSPEC', 'ComSpec', 'USERNAME', 'USER', 'LOGNAME',
  'USERDOMAIN', 'COMPUTERNAME', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'SHELL', 'XDG_CONFIG_HOME',
];

const FORBIDDEN_ENV = /^(ANTHROPIC_|CLAUDE|AWS_|GOOGLE_|VERTEX|BEDROCK|FOUNDRY|AZURE_|OPENAI_)/i;

function sanitizedEnv(source = process.env) {
  const env = {};
  for (const k of ENV_WHITELIST) if (source[k] !== undefined && !FORBIDDEN_ENV.test(k)) env[k] = source[k];
  return env;
}

/** Proměnné v prostředí FR serveru, které by mohly vést k API fakturaci (do CLI se nepředávají). */
function riskyEnvPresent(source = process.env) {
  const risky = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID'];
  return risky.filter((k) => source[k] !== undefined && source[k] !== '');
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function bundledCandidates() {
  const roots = [];
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Claude', 'claude-code'));
  if (process.env.LOCALAPPDATA) {
    const pk = path.join(process.env.LOCALAPPDATA, 'Packages');
    try {
      for (const d of fs.readdirSync(pk)) if (/^Claude_/i.test(d)) roots.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
    } catch (_) { /* nic */ }
  }
  const out = [];
  for (const r of roots) {
    let versions = [];
    try { versions = fs.readdirSync(r).filter((v) => /^\d+\.\d+\.\d+/.test(v)); } catch (_) { continue; }
    versions.sort((a, b) => cmpVersion(b, a));
    for (const v of versions) {
      let subs = [];
      try { subs = fs.readdirSync(path.join(r, v)); } catch (_) { continue; }
      for (const s of subs) {
        const exe = path.join(r, v, s, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (fs.existsSync(exe)) out.push({ path: exe, version: v, source: 'desktop-bundled' });
      }
    }
  }
  return out;
}

/** Pořadí: konfigurace → FR_CLAUDE_CLI → PATH → ~/.local/bin → CLI přibalené k desktop aplikaci. */
function discoverCli(configured) {
  const tried = [];
  const ok = (p, source) => { tried.push(p); return fs.existsSync(p) ? { path: p, source } : null; };
  if (configured) { const r = ok(configured, 'config'); if (r) return { ...r, tried }; }
  if (process.env.FR_CLAUDE_CLI) { const r = ok(process.env.FR_CLAUDE_CLI, 'env FR_CLAUDE_CLI'); if (r) return { ...r, tried }; }
  const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const n of names) { const r = ok(path.join(dir, n), 'PATH'); if (r) return { ...r, tried }; }
  }
  const local = ok(path.join(os.homedir(), '.local', 'bin', names[0]), '~/.local/bin');
  if (local) return { ...local, tried };
  const b = bundledCandidates();
  if (b.length) return { path: b[0].path, source: b[0].source, tried: [...tried, b[0].path] };
  return { path: null, source: null, tried };
}


/** Codex: konfigurace → FR_CODEX_CLI → PATH → ~/.local/bin → desktop bin. */
function discoverCodexCli(configured) {
  const tried = [];
  const check = (p, source) => {
    tried.push(p);
    try { if (fs.statSync(p).isFile()) return { path: p, source, tried }; } catch (_) { /* není soubor */ }
    return null;
  };
  for (const [p, source] of [[configured, 'config'], [process.env.FR_CODEX_CLI, 'FR_CODEX_CLI']]) {
    if (p) { const found = check(p, source); if (found) return found; }
  }
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean)) {
    const found = check(path.join(dir, name), 'PATH'); if (found) return found;
  }
  const local = check(path.join(os.homedir(), '.local', 'bin', name), '~/.local/bin');
  if (local) return local;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const versions = fs.readdirSync(bin).map(v => ({ v, time: fs.statSync(path.join(bin, v)).mtimeMs })).sort((a,b) => b.time-a.time);
      for (const { v } of versions) { const found = check(path.join(bin, v, name), 'desktop-bundled'); if (found) return found; }
    } catch (_) { /* desktop CLI není dostupné */ }
  }
  return { path: null, source: null, tried };
}

module.exports = { discoverCodexCli, sanitizedEnv, riskyEnvPresent, discoverCli, cmpVersion, ENV_WHITELIST, FORBIDDEN_ENV };
