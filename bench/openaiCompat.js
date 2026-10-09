'use strict';
/**
 * OpenAI-kompatibilní provider — jeden adaptér pro vLLM (GPU), Ollama, Docker Model Runner i AISHA /v1.
 * Vykonavatel a soudce mohou být různé modely i endpointy (K9: soudce ≠ vykonavatel):
 * úlohy uvedené v `judgeTasks` jdou na judgeModel, vše ostatní na model.
 * Klíč se čte jen z proměnné prostředí (apiKeyEnv), nikdy z konfigurace ani z repa.
 *
 * Integrační harness MIMO kód FR (rozhodnutí vlastníka FR 2026-10-09, K3: kód FR mluví s modelem jen přes
 * AISHA /v1 a nenese adresu ani klíč lane). Vkládá se do runPipeline zvenku; kód FR se nemění.
 */

const DEFAULT_JUDGE_TASKS = Object.freeze(['semantic_verify']);

/** Odstraní bloky uvažování (Qwen3 a další), které by rozbily extrakci JSON. Čistá funkce. */
function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

function endpoint({ baseUrl, apiKeyEnv, model }) {
  if (!baseUrl) throw new Error('openai-compatible: chybí baseUrl.');
  if (!model) throw new Error('openai-compatible: chybí model.');
  return { baseUrl: String(baseUrl).replace(/\/+$/, ''), apiKeyEnv: apiKeyEnv || null, model };
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return String(url); }
}

class OpenAICompatProvider {
  constructor({
    id = 'openai-compatible', baseUrl, apiKeyEnv, model,
    judgeBaseUrl, judgeApiKeyEnv, judgeModel, judgeTasks = DEFAULT_JUDGE_TASKS,
    timeoutMs = 300000, temperature = 0, maxTokens = 6000, jsonMode = true, extraBody = {},
    pricePerMTok = null, fetchFn = globalThis.fetch,
  }) {
    this.id = id;
    this.exec = endpoint({ baseUrl, apiKeyEnv, model });
    this.judge = judgeModel ? endpoint({ baseUrl: judgeBaseUrl || baseUrl, apiKeyEnv: judgeApiKeyEnv || apiKeyEnv, model: judgeModel }) : null;
    this.judgeTasks = new Set(judgeTasks);
    this.model = model;
    this.simulated = false;
    this.requiresPreflight = true;
    this.timeoutMs = timeoutMs;
    this.temperature = temperature;
    this.maxTokens = maxTokens;
    this.jsonMode = jsonMode;
    this.extraBody = extraBody;
    this.pricePerMTok = pricePerMTok; // { input, output } v USD; null = vlastní hardware, bez odhadu ceny
    this.fetchFn = fetchFn;
    this.lastPreflight = null;
  }

  describe() {
    return { id: this.id, model: this.model, judgeModel: this.judge ? this.judge.model : null, endpoint: hostOf(this.exec.baseUrl), judgeEndpoint: this.judge ? hostOf(this.judge.baseUrl) : null, simulated: false };
  }

  billingInfo() {
    return {
      mode: this.pricePerMTok ? 'openai-compatible-paid' : 'openai-compatible-self-hosted',
      endpoint: hostOf(this.exec.baseUrl),
      preflightOk: this.lastPreflight ? this.lastPreflight.ok : false,
      preflightAt: this.lastPreflight ? this.lastPreflight.at : null,
      note: this.pricePerMTok ? 'Placené API — cena je odhad z ceníku v konfiguraci.' : 'Vlastní model — bez fakturace za tokeny.',
    };
  }

  headers(ep) {
    const h = { 'content-type': 'application/json' };
    const key = ep.apiKeyEnv ? process.env[ep.apiKeyEnv] : null;
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  async request(ep, pathname, init = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), init.timeoutMs || this.timeoutMs);
    try {
      const res = await this.fetchFn(`${ep.baseUrl}${pathname}`, { ...init, headers: this.headers(ep), signal: ac.signal });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} z ${hostOf(ep.baseUrl)}: ${body.slice(0, 300)}`);
      return JSON.parse(body);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`Časový limit ${init.timeoutMs || this.timeoutMs} ms překročen (${hostOf(ep.baseUrl)}).`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ověří dostupnost endpointů a přítomnost obou modelů. Fail-closed: bez úspěchu žádné volání. */
  async preflight() {
    const checks = [];
    const eps = [['vykonavatel', this.exec], ...(this.judge ? [['soudce', this.judge]] : [])];
    for (const [role, ep] of eps) {
      try {
        const j = await this.request(ep, '/models', { method: 'GET', timeoutMs: 15000 });
        const ids = (j.data || []).map((m) => m.id);
        const found = ids.includes(ep.model);
        checks.push({ id: `model_${role}`, ok: found, detail: found ? `${ep.model} @ ${hostOf(ep.baseUrl)}` : `${ep.model} nenalezen; dostupné: ${ids.slice(0, 8).join(', ') || '—'}` });
      } catch (e) {
        checks.push({ id: `model_${role}`, ok: false, detail: e.message });
      }
    }
    this.lastPreflight = { ok: checks.every((c) => c.ok), checks, at: new Date().toISOString() };
    return this.lastPreflight;
  }

  /**
   * req: { task, system, prompt, json? } — json:false vypne JSON režim (čistý dotaz bez FR obálky).
   */
  async call(req) {
    if (!this.lastPreflight || !this.lastPreflight.ok) throw new Error('openai-compatible: preflight neprošel nebo neproběhl — volání zablokováno.');
    const asJudge = !!this.judge && this.judgeTasks.has(req.task);
    const ep = asJudge ? this.judge : this.exec;
    const body = {
      model: ep.model,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), { role: 'user', content: req.prompt }],
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      ...this.extraBody,
    };
    if (this.jsonMode && req.json !== false) body.response_format = { type: 'json_object' };
    const t0 = Date.now();
    const j = await this.request(ep, '/chat/completions', { method: 'POST', body: JSON.stringify(body) });
    const choice = (j.choices || [])[0];
    if (!choice || !choice.message) throw new Error('Odpověď neobsahuje choices[0].message.');
    const u = j.usage || {};
    const usage = { inputTokens: u.prompt_tokens || 0, outputTokens: u.completion_tokens || 0, cacheReadTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0, cacheCreationTokens: 0 };
    const cost = this.pricePerMTok ? (usage.inputTokens * this.pricePerMTok.input + usage.outputTokens * this.pricePerMTok.output) / 1e6 : null;
    return {
      text: stripThink(choice.message.content),
      usage,
      model: ep.model, // požadovaný alias; co server skutečně hlásí (např. cesta ke GGUF) je v modelVersions
      modelVersions: [j.model || ep.model],
      role: asJudge ? 'judge' : 'executor',
      finishReason: choice.finish_reason || null,
      simulated: false,
      tokensEstimated: !j.usage,
      durationMs: Date.now() - t0,
      costUsdEstimate: cost,
    };
  }
}

module.exports = { OpenAICompatProvider, stripThink, DEFAULT_JUDGE_TASKS };
