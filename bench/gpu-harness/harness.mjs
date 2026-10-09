#!/usr/bin/env node
/**
 * Integrační harness FR × vlastní modely na GPU (majitel + AISHA, 2026-10-09).
 *
 * Žije MIMO kód FR (rozhodnutí vlastníka FR, K3): kód `frankie` se nemění, harness jen vloží do jeho pipeline
 * složený provider — úlohy soudce (`semantic_verify`) jdou na model soudce, ostatní na model vykonavatele.
 * Shodná identita soudce a vykonavatele = preflight FAIL (K9: soudce ≠ vykonavatel).
 *
 * Náklady: tokeny po rolích z `usage` backendu + orientační přepočet na ceník API Anthropic (tokenizéry se liší,
 * je to ekvivalent, ne fakturace) + energie GPU z `nvidia-smi` přes ssh (jen čtení).
 *
 * Použití:
 *   node harness.mjs --frankie <cesta> --scenare scenare.json --out <adresář> \
 *     --exec-url http://127.0.0.1:<port-exec>/v1 --exec-model fr-exec \
 *     --judge-url http://127.0.0.1:<port-judge>/v1 --judge-model fr-judge \
 *     [--klic-env FR_TEST_VLLM_KEY] [--energie-ssh <ssh-alias-gpu>] [--json-schema] [--s-uvazovanim] [--sucho]
 * Uvažování (thinking) je ve výchozím stavu VYPNUTÉ (Qwen3 na vLLM bez reasoning-parseru by ho psal do content);
 * `--s-uvazovanim` ho zapne. `--bez-uvazovani` se přijímá kvůli zpětné kompatibilitě (no-op).
 * `--sucho`: místo sítě odpovídá mock FR (ověření řetězce bez GPU); report je označený jako simulace.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Ceník Anthropic API za 1M tokenů (cache skillu claude-api k 2026-10-06). Jen pro přepočet — FR nic neplatí.
export const CENIK_API = Object.freeze({
  'claude-sonnet-5-5': { vstup: 2.0, vystup: 10.0 },
  'claude-opus-5-5': { vstup: 4.0, vystup: 20.0 },
  'claude-haiku-5-5': { vstup: 0.1, vystup: 0.5, poznamka: 'do 100K tokenů promptu' },
  'claude-fable-5-1': { vstup: 10.0, vystup: 50.0 },
});
export const CENIK_ZDROJ = 'ceník Anthropic API (skill claude-api, cache 2026-10-06)';

function arg(jmeno, vychozi) {
  const i = process.argv.indexOf(`--${jmeno}`);
  return i > 0 ? process.argv[i + 1] : vychozi;
}
const prepinac = (jmeno) => process.argv.includes(`--${jmeno}`);

/** Text a usage z odpovědi `chat.completion` (čistá funkce). */
export function parseCompletion(body) {
  let j;
  try { j = JSON.parse(String(body)); } catch (_) { throw new Error('backend nevrátil platný JSON'); }
  if (j.error) throw new Error(`backend vrátil chybu: ${String(j.error.message || j.error).slice(0, 200)}`);
  const c = (j.choices || [])[0];
  if (!c || !c.message) throw new Error('odpověď backendu neobsahuje zprávu');
  return { text: String(c.message.content ?? ''), model: j.model || null, usage: j.usage || null, finish: c.finish_reason || null };
}

/** Přímé volání vLLM (OpenAI API) — jen v harnessu, nikdy v kódu FR. */
export class VllmPrimy {
  constructor({ role, baseUrl, model, klicEnv, jsonSchema = false, uvazovani = false, maxTokens = null, timeoutMs = 300000, fetchFn = globalThis.fetch, env = process.env }) {
    Object.assign(this, { role, baseUrl: baseUrl.replace(/\/+$/, ''), model, klicEnv, jsonSchema, uvazovani, maxTokens, timeoutMs, fetchFn, env });
    this.id = `vllm-${role}`;
    this.simulated = false;
    this.lastPreflight = null;
    this.identita = null;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    const k = this.klicEnv ? this.env[this.klicEnv] : null;
    if (k) h.Authorization = `Bearer ${k}`;
    return h;
  }

  async request(p, init) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try { return await this.fetchFn(`${this.baseUrl}${p}`, { ...init, signal: ctl.signal, redirect: 'error' }); } finally { clearTimeout(t); }
  }

  /** Bez inference: model nabízený backendem a jeho identita (`root` = repozitář vah). */
  async preflight() {
    const checks = [];
    if (this.klicEnv && !this.env[this.klicEnv]) checks.push({ id: `${this.role}_klic`, status: 'FAIL', label: `Klíč ${this.role}`, detail: `proměnná ${this.klicEnv} chybí` });
    try {
      const r = await this.request('/models', { method: 'GET', headers: this.headers() });
      const data = JSON.parse(await r.text()).data || [];
      const m = data.find((x) => x.id === this.model);
      this.identita = m ? { served: m.id, root: m.root || null, maxModelLen: m.max_model_len ?? null } : null; // bez root nezávislost neověřitelná
      checks.push({ id: `${this.role}_model`, status: r.ok && m ? 'PASS' : 'FAIL', label: `Model ${this.role}`, detail: m ? `${m.id} ← ${m.root || '?'}` : `HTTP ${r.status}; nabízené: ${data.map((x) => x.id).join(', ') || '—'}` });
    } catch (e) {
      checks.push({ id: `${this.role}_model`, status: 'FAIL', label: `Model ${this.role}`, detail: `backend nedostupný: ${e.message}` });
    }
    this.lastPreflight = { ok: checks.every((c) => c.status === 'PASS'), at: new Date().toISOString(), checks };
    return this.lastPreflight;
  }

  async call(req) {
    if (!this.lastPreflight || !this.lastPreflight.ok) throw new Error(`${this.id}: preflight neprošel`);
    const body = { model: this.model, temperature: 0, messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }] };
    if (!this.uvazovani) body.chat_template_kwargs = { enable_thinking: false };
    if (this.maxTokens) body.max_tokens = this.maxTokens;
    if (this.jsonSchema && req.schema) body.response_format = { type: 'json_schema', json_schema: { name: String(req.task || 'fr').replace(/[^A-Za-z0-9_-]/g, '_'), schema: req.schema } };
    const t0 = Date.now();
    const r = await this.request('/chat/completions', { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${this.id}: HTTP ${r.status}: ${text.slice(0, 200)}`);
    const out = parseCompletion(text);
    const u = out.usage || {};
    return {
      text: out.text, model: out.model || this.model, modelVersions: this.identita ? [this.identita.root] : [],
      simulated: false, tokensEstimated: !out.usage,
      usage: { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, cacheReadTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, cacheCreationTokens: 0 },
      durationMs: Date.now() - t0, costUsdEstimate: null,
    };
  }
}

/** Složený provider: soudce ≠ vykonavatel. Vkládá se do pipeline FR beze změny jejího kódu. */
export class SlozenyProvider {
  constructor({ exec, judge, ulohySoudce = ['semantic_verify'] }) {
    Object.assign(this, { exec, judge, ulohySoudce });
    this.id = 'gpu-primo';
    this.model = `${exec.model} | soudce ${judge.model}`;
    this.simulated = !!(exec.simulated || judge.simulated);
    this.requiresPreflight = true;
  }

  describe() { return { id: this.id, model: this.model, simulated: this.simulated, vykonavatel: this.exec.identita, soudce: this.judge.identita }; }

  billingInfo() { return { mode: 'self-hosted', preflightOk: !!(this.pf && this.pf.ok), note: 'Vlastní modely v soukromé síti testu; přepočet na API je jen ekvivalent.' }; }

  async preflight() {
    const [a, b] = [await this.exec.preflight(), await this.judge.preflight()];
    const checks = [...a.checks, ...b.checks];
    const ia = this.exec.identita, ib = this.judge.identita;
    const nezavisly = !!(ia && ib && ia.root && ib.root && ia.root !== ib.root);
    checks.push({ id: 'soudce_nezavisly', status: nezavisly ? 'PASS' : 'FAIL', label: 'Soudce ≠ vykonavatel (K9)', detail: !(ia && ib) ? 'identita nezjištěna' : !(ia.root && ib.root) ? 'backend nevrací root — nezávislost neověřitelná' : `${ia.root} × ${ib.root}` });
    this.pf = { ok: checks.every((c) => c.status === 'PASS'), at: new Date().toISOString(), checks };
    return this.pf;
  }

  call(req) {
    return (this.ulohySoudce.includes(req.task) ? this.judge : this.exec).call(req);
  }
}

/** Součty tokenů po rolích a přepočet na ceník API (čistá funkce nad telemetrií běhů FR). */
export function spocitejNaklady(behy, ulohySoudce = ['semantic_verify']) {
  const role = { vykonavatel: { volani: 0, vstup: 0, vystup: 0, ms: 0 }, soudce: { volani: 0, vstup: 0, vystup: 0, ms: 0 } };
  for (const run of behy) {
    for (const c of (run.telemetry && run.telemetry.calls) || []) {
      const r = role[ulohySoudce.includes(c.task) ? 'soudce' : 'vykonavatel'];
      r.volani++;
      // Záznam volání FR (telemetry.recordCall) nese tokeny přímo: inputTokens / outputTokens.
      r.vstup += c.inputTokens || 0;
      r.vystup += c.outputTokens || 0;
      r.ms += c.durationMs || 0;
    }
  }
  const celkem = { volani: role.vykonavatel.volani + role.soudce.volani, vstup: role.vykonavatel.vstup + role.soudce.vstup, vystup: role.vykonavatel.vystup + role.soudce.vystup };
  const api = {};
  for (const [m, p] of Object.entries(CENIK_API)) api[m] = Number(((celkem.vstup * p.vstup + celkem.vystup * p.vystup) / 1e6).toFixed(4));
  return { role, celkem, ekvivalentApiUsd: api, zdrojCeniku: CENIK_ZDROJ, poznamka: 'Tokeny jsou počítané tokenizérem vlastního modelu; přepočet je orientační ekvivalent, ne fakturace.' };
}

/** Energie GPU z řádků `nvidia-smi --query-gpu=timestamp,power.draw,utilization.gpu,memory.used --format=csv,noheader,nounits -lms N`. */
export function spocitejEnergii(radky, intervalMs) {
  const vzorky = radky.map((l) => l.split(',').map((x) => x.trim())).filter((p) => p.length >= 4 && !Number.isNaN(Number(p[1])))
    .map((p) => ({ w: Number(p[1]), util: Number(p[2]), mib: Number(p[3]) }));
  if (!vzorky.length) return null;
  const wh = vzorky.reduce((s, v) => s + v.w, 0) * (intervalMs / 1000) / 3600;
  return {
    vzorku: vzorky.length, intervalMs, wh: Number(wh.toFixed(3)),
    prumerW: Number((vzorky.reduce((s, v) => s + v.w, 0) / vzorky.length).toFixed(1)),
    maxW: Math.max(...vzorky.map((v) => v.w)), maxMiB: Math.max(...vzorky.map((v) => v.mib)),
    gpuAktivniS: Number((vzorky.filter((v) => v.util > 0).length * intervalMs / 1000).toFixed(1)),
    poznamka: 'Celý GPU včetně ostatních lane na sdíleném uzlu.',
  };
}

function suchyFetch(MockProvider) {
  // Suchý běh: HTTP cesta harnessu proběhne celá, jen odpověď vyrobí mock FR z původního požadavku pipeline.
  const mock = new MockProvider({});
  return (role, posledni) => async (url, init) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: `fr-${role}`, root: `sucho/${role}` }] }), { status: 200 });
    const r = await mock.call(posledni());
    return new Response(JSON.stringify({ model: `fr-${role}`, choices: [{ message: { content: r.text }, finish_reason: 'stop' }], usage: { prompt_tokens: r.usage.inputTokens, completion_tokens: r.usage.outputTokens } }), { status: 200 });
  };
}

async function main() {
  const frankie = path.resolve(arg('frankie'));
  const req = createRequire(path.join(frankie, 'package.json'));
  const { loadConfig } = req('./src/config');
  const { createRun, runPipeline } = req('./src/core/pipeline');
  const sucho = prepinac('sucho');
  const out = path.resolve(arg('out'));
  fs.mkdirSync(path.join(out, 'behy'), { recursive: true });
  const scenare = JSON.parse(fs.readFileSync(arg('scenare'), 'utf8'));

  let fetchExec = globalThis.fetch, fetchJudge = globalThis.fetch;
  const posledni = { exec: null, judge: null };
  if (sucho) {
    const { MockProvider } = req('./src/providers/mock');
    const f = suchyFetch(MockProvider);
    fetchExec = f('exec', () => posledni.exec);
    fetchJudge = f('judge', () => posledni.judge);
  }
  const spolecne = { klicEnv: arg('klic-env'), jsonSchema: prepinac('json-schema'), uvazovani: prepinac('s-uvazovanim'), maxTokens: arg('max-tokens') ? Number(arg('max-tokens')) : null };
  const exec = new VllmPrimy({ role: 'exec', baseUrl: arg('exec-url', 'http://sucho/v1'), model: arg('exec-model', 'fr-exec'), fetchFn: fetchExec, ...spolecne });
  const judge = new VllmPrimy({ role: 'judge', baseUrl: arg('judge-url', 'http://sucho/v1'), model: arg('judge-model', 'fr-judge'), fetchFn: fetchJudge, ...spolecne });
  if (sucho) {
    for (const [p, k] of [[exec, 'exec'], [judge, 'judge']]) {
      const puvodni = p.call.bind(p);
      p.call = (r) => { posledni[k] = r; return puvodni(r); };
    }
  }
  const provider = new SlozenyProvider({ exec, judge });
  const config = loadConfig();

  // Energie: nvidia-smi přes ssh po dobu běhu (jen čtení).
  let smi = null; const smiRadky = []; const intervalMs = 1000;
  const sshHost = arg('energie-ssh');
  if (sshHost && !sucho) {
    smi = spawn('ssh', ['-o', 'BatchMode=yes', sshHost, `nvidia-smi --query-gpu=timestamp,power.draw,utilization.gpu,memory.used --format=csv,noheader,nounits -lms ${intervalMs}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    smi.stdout.on('data', (d) => smiRadky.push(...String(d).split('\n').filter(Boolean)));
  }

  const behy = [];
  const t0 = Date.now();
  for (const s of scenare) {
    const run = createRun({ prompt: s.prompt, explicitGoal: s.explicitGoal, provider: provider.id, baseline: false, parent: null, clarificationAnswer: null, config });
    await runPipeline({ run, provider, config, persist: (r) => fs.writeFileSync(path.join(out, 'behy', `${r.id}.json`), JSON.stringify(r, null, 2)) });
    behy.push(run);
    const v = (run.branches || []).map((b) => (b.final && b.final.verdict) || (b.attempts && b.attempts.at(-1) && b.attempts.at(-1).verification && b.attempts.at(-1).verification.verdict) || '?');
    process.stdout.write(`${s.id}\t${run.state}\t${run.decision ? run.decision.code : '-'}\t${v.join(',') || '-'}\t${(run.telemetry && run.telemetry.calls || []).length} volání\n`);
  }
  const trvaniS = (Date.now() - t0) / 1000;
  if (smi) smi.kill('SIGTERM');

  const report = {
    kdy: new Date().toISOString(), simulace: sucho, trvaniS,
    nastaveniBackendu: { uvazovani: spolecne.uvazovani, jsonSchema: spolecne.jsonSchema, maxTokens: spolecne.maxTokens }, preflight: provider.pf, identita: provider.describe(),
    scenare: behy.map((r, i) => ({ id: scenare[i].id, stav: r.state, rozhodnuti: r.decision && r.decision.code, chyba: r.error || null, volani: (r.telemetry && r.telemetry.calls || []).length })),
    naklady: spocitejNaklady(behy), energie: spocitejEnergii(smiRadky, intervalMs),
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ trvaniS, naklady: report.naklady.celkem, ekvivalentApiUsd: report.naklady.ekvivalentApiUsd, energie: report.energie }, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
