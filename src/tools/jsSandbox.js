'use strict';
/**
 * Spuštění vygenerovaného JavaScriptu proti testovacím případům v izolovaném podprocesu:
 *  - Node permission model (--permission): bez zápisu na disk, bez podprocesů, workerů a addonů;
 *  - čtení povoleno jen pro samotný harness soubor;
 *  - prázdné prostředí, časový limit, statická kontrola zakázaných konstrukcí;
 *  - kód běží ve strict mode s odstíněnými globály (process, require, fetch, globalThis…).
 * Nejde o plnohodnotný bezpečnostní sandbox (viz README – známá omezení).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FORBIDDEN = /\b(?:require|import|process|globalThis|global|eval|Function|child_process|fetch|XMLHttpRequest|WebSocket|Deno|Bun|setInterval|Atomics|SharedArrayBuffer|constructor)\b/;

function staticCheck(code) {
  const withoutComments = String(code).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const m = withoutComments.match(FORBIDDEN);
  return m ? { ok: false, reason: `Kód obsahuje zakázanou konstrukci „${m[0]}“ — nebyl spuštěn.` } : { ok: true };
}

function harnessSource(code, functionName, cases) {
  return `'use strict';
const __code = ${JSON.stringify(String(code))};
const __name = ${JSON.stringify(String(functionName))};
const __cases = ${JSON.stringify(cases)};
for (const k of ['fetch','WebSocket','EventSource','navigator','Worker','SharedArrayBuffer']) { try { delete globalThis[k]; } catch (_) {} }
const __out = [];
let __fn;
try {
  __fn = (new Function('process','require','module','exports','globalThis','global','fetch',
    '"use strict";\\n' + __code + '\\n;return typeof ' + __name + ' !== "undefined" ? ' + __name + ' : undefined;'))();
} catch (e) { console.log(JSON.stringify({ loadError: String(e && e.message || e) })); }
if (__fn !== undefined) {
  if (typeof __fn !== 'function') { console.log(JSON.stringify({ loadError: 'Symbol ' + __name + ' není funkce' })); }
  else {
    for (const c of __cases) {
      try {
        const actual = __fn(...c.args);
        const ok = JSON.stringify(actual) === JSON.stringify(c.expected);
        __out.push({ args: c.args, expected: c.expected, actual, ok });
      } catch (e) { __out.push({ args: c.args, expected: c.expected, error: String(e && e.message || e), ok: false }); }
    }
    console.log(JSON.stringify({ results: __out }));
  }
} else if (!__out.length) { console.log(JSON.stringify({ loadError: 'Funkce ' + __name + ' nebyla v kódu nalezena' })); }
`;
}

function runFunctionTests({ code, functionName, cases, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const sc = staticCheck(code);
    if (!sc.ok) return resolve({ executed: false, reason: sc.reason });
    if (!/^[A-Za-z_$][\w$]*$/.test(String(functionName || ''))) return resolve({ executed: false, reason: 'Neplatný název funkce' });
    // realpath: na macOS je tmpdir symlink (/var → /private/var) a --allow-fs-read porovnává skutečné cesty.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-sandbox-'));
    let dir;
    try { dir = fs.realpathSync(tmp); } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return resolve({ executed: false, reason: `Sandbox nelze připravit: ${e.message}` });
    }
    const file = path.join(dir, `h-${crypto.randomBytes(4).toString('hex')}.js`);
    fs.writeFileSync(file, harnessSource(code, functionName, cases), 'utf8');
    const started = Date.now();
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${file}`, file], {
      cwd: dir, env: {}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < 200000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    child.on('close', (codeExit) => {
      clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* nic */ }
      const durationMs = Date.now() - started;
      if (timedOut) return resolve({ executed: true, timedOut: true, durationMs, reason: `Překročen časový limit ${timeoutMs} ms` });
      const line = out.trim().split(/\r?\n/).pop() || '';
      let parsed;
      try { parsed = JSON.parse(line); } catch (_) { parsed = null; }
      if (!parsed) return resolve({ executed: true, durationMs, exitCode: codeExit, reason: 'Harness nevrátil výsledek', stderr: err.slice(0, 2000) });
      if (parsed.loadError) return resolve({ executed: true, durationMs, loadError: parsed.loadError });
      const results = parsed.results || [];
      resolve({ executed: true, durationMs, results, passed: results.filter((r) => r.ok).length, total: results.length });
    });
  });
}

module.exports = { runFunctionTests, staticCheck };
