'use strict';
/**
 * Telemetrie: každé modelové volání a každá fáze. Rozlišuje:
 *  - naměřenou spotřebu (tokeny hlášené CLI; u mocku odhad a simulace),
 *  - odhad nákladového ekvivalentu v USD (z CLI total_cost_usd — NENÍ to zaplacená částka),
 *  - ověřenou fakturaci (z CLI nedostupná → vždy „NEOVĚŘENO“).
 */
const { truncate } = require('./util');

class Telemetry {
  constructor({ provider, billing }) {
    this.calls = [];
    this.stages = [];
    this.provider = provider;
    this.billing = billing;
    this._open = new Map();
    this.startedAt = Date.now();
  }

  stageStart(name) {
    this._open.set(name, { name, startedAt: Date.now(), aiMs: 0 });
  }

  stageEnd(name, status = 'ok') {
    const s = this._open.get(name);
    if (!s) return;
    this._open.delete(name);
    const durationMs = Date.now() - s.startedAt;
    this.stages.push({ name, status, startedAt: new Date(s.startedAt).toISOString(), durationMs, aiMs: s.aiMs, algorithmicMs: Math.max(0, durationMs - s.aiMs) });
  }

  recordCall(rec) {
    const id = `C${String(this.calls.length + 1).padStart(2, '0')}`;
    const row = {
      callId: id,
      task: rec.task,
      stage: rec.stage,
      template: rec.template ? `${rec.template.id}@${rec.template.version}` : null,
      provider: rec.provider,
      model: rec.model,
      modelVersions: rec.modelVersions || [],
      simulated: !!rec.simulated,
      tokensEstimated: !!rec.tokensEstimated,
      inputTokens: rec.usage ? rec.usage.inputTokens : 0,
      outputTokens: rec.usage ? rec.usage.outputTokens : 0,
      cacheReadTokens: rec.usage ? rec.usage.cacheReadTokens : 0,
      cacheCreationTokens: rec.usage ? rec.usage.cacheCreationTokens : 0,
      durationMs: rec.durationMs || 0, // celkový čas volání včetně startu procesu CLI
      reportedDurationMs: rec.reportedDurationMs ?? null, // duration_ms hlášené CLI
      apiDurationMs: rec.apiDurationMs ?? null,
      attempts: rec.attempts || 1,
      retries: Math.max(0, (rec.attempts || 1) - 1),
      costUsdEstimate: rec.costUsdEstimate ?? null,
      sessionId: rec.sessionId || null,
      status: rec.status,
      error: rec.error || null,
      promptChars: rec.promptChars || 0,
      promptSha256: rec.promptSha256 || null,
      rawOutput: truncate(rec.rawOutput || '', 20000),
    };
    this.calls.push(row);
    for (const s of this._open.values()) s.aiMs += row.durationMs;
    return id;
  }

  summary(finalState) {
    const sum = (k) => this.calls.reduce((a, c) => a + (Number(c[k]) || 0), 0);
    const totalMs = Date.now() - this.startedAt;
    const aiMs = sum('durationMs');
    const usdKnown = this.calls.filter((c) => c.costUsdEstimate != null);
    return {
      finalState,
      calls: this.calls.length,
      callsByTask: this.calls.reduce((m, c) => { m[c.task] = (m[c.task] || 0) + 1; return m; }, {}),
      retries: sum('retries'),
      failedCalls: this.calls.filter((c) => c.status !== 'ok').length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadTokens: sum('cacheReadTokens'),
      cacheCreationTokens: sum('cacheCreationTokens'),
      totalInputTokens: sum('inputTokens') + sum('cacheReadTokens') + sum('cacheCreationTokens'),
      tokensEstimated: this.calls.some((c) => c.tokensEstimated),
      simulated: this.calls.some((c) => c.simulated),
      totalMs,
      aiMs,
      algorithmicMs: Math.max(0, totalMs - aiMs),
      costUsdEstimate: usdKnown.length ? Math.round(usdKnown.reduce((a, c) => a + c.costUsdEstimate, 0) * 1e6) / 1e6 : null,
      costUsdNote: 'Odhad nákladového ekvivalentu podle Claude Code CLI (total_cost_usd). Při předplatném NEJDE o zaplacenou částku.',
      verifiedBilling: 'NEOVĚŘENO — skutečnou fakturaci nelze z CLI zjistit; předplatitelský režim ověřen pouze preflightem.',
      billing: this.billing,
      provider: this.provider,
    };
  }

  toJSON() {
    return { calls: this.calls, stages: this.stages };
  }
}

module.exports = { Telemetry };
