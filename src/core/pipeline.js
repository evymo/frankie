'use strict';
/**
 * FR Core — deterministický stavový automat celého cyklu.
 * Algoritmus řídí pořadí, limity, rozhodnutí a evidenci; AI je volána jen v definovaných bodech
 * (Gate 0, Goal Audit, porovnání cílů, exekuce, sémantická verifikace, volitelně baseline).
 */
const { newId, nowIso, sha256, extractJson, clone } = require('./util');
const { validate } = require('./schema');
const S = require('./schemas');
const { Telemetry } = require('./telemetry');
const { extractExplicitGoal } = require('./detectors');
const { processGate0 } = require('./gate0');
const { processAudit, planComparison, mergeComparison } = require('./goalAudit');
const { decide } = require('./decision');
const { buildContracts } = require('./goalContract');
const { compileExecution, compileRepair } = require('./promptCompiler');
const { execute } = require('./executor');
const { verify, repairDecision } = require('./verifier');
const T = require('../templates/analysis');

const TRANSITIONS = {
  RECEIVED: ['GATE0', 'FAILED'],
  GATE0: ['GOAL_AUDIT', 'FAILED'],
  GOAL_AUDIT: ['GOAL_COMPARE', 'FAILED'],
  GOAL_COMPARE: ['DECISION', 'FAILED'],
  DECISION: ['CONTRACTS', 'CLARIFICATION_REQUIRED', 'FAILED'],
  CONTRACTS: ['COMPILE', 'FAILED'],
  COMPILE: ['EXECUTE', 'FAILED'],
  EXECUTE: ['VERIFY', 'FAILED'],
  VERIFY: ['REPAIR', 'COMPILE', 'BASELINE', 'REPORT', 'FAILED'],
  REPAIR: ['VERIFY', 'FAILED'],
  BASELINE: ['REPORT', 'FAILED'],
  REPORT: ['DONE', 'FAILED'],
  DONE: [], FAILED: [], CLARIFICATION_REQUIRED: [],
};

const PHASES = ['RECEIVED', 'GATE0', 'GOAL_AUDIT', 'GOAL_COMPARE', 'DECISION', 'CONTRACTS', 'COMPILE', 'EXECUTE', 'VERIFY', 'REPAIR', 'BASELINE', 'REPORT', 'DONE'];

class FrError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function combinedText(input) {
  return [input.prompt, ...(input.clarifications || []).map((c) => c.answer)].join('\n');
}

function createRun({ prompt, explicitGoal, provider, baseline, parent, clarificationAnswer, config }) {
  if (parent) {
    if (parent.state !== 'CLARIFICATION_REQUIRED') throw new FrError('BAD_PARENT', 'Navázat lze jen na běh ve stavu CLARIFICATION_REQUIRED.');
    if (!String(clarificationAnswer || '').trim()) throw new FrError('BAD_INPUT', 'Odpověď na upřesňující otázku je prázdná.');
    prompt = parent.input.prompt;
    // Odpověď na upřesnění je novější projev vůle než původní explicitní cíl, který rozpor způsobil:
    // bez nového cíle se původní nepřebírá (zůstává evidován v previousExplicitGoal).
  }
  prompt = String(prompt || '');
  if (!prompt.trim()) throw new FrError('BAD_INPUT', 'Zadání je prázdné.');
  if (prompt.length > config.limits.maxPromptChars) throw new FrError('BAD_INPUT', `Zadání je delší než limit ${config.limits.maxPromptChars} znaků.`);
  const clarifications = parent ? [...(parent.input.clarifications || []), { question: parent.clarification.question, answer: String(clarificationAnswer), fromRunId: parent.id, at: nowIso() }] : [];
  return {
    id: newId('RUN'),
    schemaVersion: 'fr-run/0.3',
    frVersion: '0.3.1',
    createdAt: nowIso(),
    finishedAt: null,
    state: 'RECEIVED',
    stateHistory: [{ state: 'RECEIVED', at: nowIso(), note: 'Zadání přijato.' }],
    input: { prompt, promptSha256: sha256(prompt), explicitGoalField: String(explicitGoal || '').trim() || null, clarifications, parentRunId: parent ? parent.id : null, previousExplicitGoal: parent ? parent.input.explicitGoalField : null, options: { provider, baseline: !!baseline } },
    explicitGoal: null, provider: null, gate0: null, goalAudit: null, comparison: null, decision: null, clarification: null,
    contracts: [], branches: [], baseline: null, report: null, telemetry: null, error: null,
  };
}

function transition(ctx, to, note = '') {
  const { run } = ctx;
  const allowed = TRANSITIONS[run.state] || [];
  if (!allowed.includes(to)) throw new FrError('ILLEGAL_TRANSITION', `Nepovolený přechod ${run.state} → ${to}`);
  ctx.telemetry.stageEnd(ctx.currentStage);
  run.state = to;
  run.stateHistory.push({ state: to, at: nowIso(), note });
  ctx.currentStage = `${to}${ctx.branchTag ? ':' + ctx.branchTag : ''}`;
  ctx.telemetry.stageStart(ctx.currentStage);
  ctx.persist();
}

/** Jediný vstupní bod pro AI: limity, validace schématu, max. 1 opakování při neplatném výstupu, telemetrie. */
function makeCallModel(ctx) {
  return async function callModel(req) {
    const { provider, config, telemetry } = ctx;
    let prompt = req.prompt;
    let lastErr = null;
    let lastCallId = null;
    const maxAttempts = 1 + Math.max(0, Math.min(1, config.limits.maxRetriesPerCall));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (ctx.callCount >= config.limits.maxModelCallsPerRun) {
        return { ok: false, error: `Limit modelových volání na běh (${config.limits.maxModelCallsPerRun}) vyčerpán.`, callId: lastCallId, simulated: provider.simulated };
      }
      ctx.callCount++;
      const t0 = Date.now();
      let res;
      try {
        res = await provider.call({ ...req, prompt });
      } catch (e) {
        lastCallId = telemetry.recordCall({ task: req.task, stage: ctx.currentStage, template: req.template, provider: provider.id, model: provider.model, simulated: provider.simulated, durationMs: Date.now() - t0, attempts: attempt, status: 'error', error: e.message, promptChars: prompt.length, promptSha256: sha256(prompt) });
        return { ok: false, error: e.message, callId: lastCallId, simulated: provider.simulated };
      }
      const data = res.data !== undefined ? res.data : extractJson(res.text);
      const errs = data === undefined ? ['Odpověď neobsahuje JSON'] : validate(req.schema, data);
      lastCallId = telemetry.recordCall({
        task: req.task, stage: ctx.currentStage, template: req.template, provider: provider.id, model: res.model || provider.model,
        modelVersions: res.modelVersions, simulated: res.simulated, tokensEstimated: res.tokensEstimated, usage: res.usage,
        durationMs: Date.now() - t0, reportedDurationMs: res.durationMs ?? null, apiDurationMs: res.apiDurationMs, attempts: attempt,
        costUsdEstimate: res.costUsdEstimate, sessionId: res.sessionId, status: errs.length ? 'invalid_output' : 'ok',
        error: errs.length ? errs.slice(0, 5).join('; ') : null, promptChars: prompt.length, promptSha256: sha256(prompt), rawOutput: res.text,
      });
      if (!errs.length) return { ok: true, data, callId: lastCallId, simulated: !!res.simulated };
      lastErr = `Výstup neodpovídá schématu: ${errs.slice(0, 5).join('; ')}`;
      prompt = `${req.prompt}\n\n## OPRAVA FORMÁTU\nPředchozí odpověď byla neplatná (${errs.slice(0, 5).join('; ')}). Vrať pouze platný JSON podle struktury.`;
    }
    return { ok: false, error: lastErr, callId: lastCallId, simulated: provider.simulated };
  };
}

function fail(ctx, code, message) {
  throw new FrError(code, message);
}

async function stageGate0(ctx) {
  const { run } = ctx;
  transition(ctx, 'GATE0', 'Deset hledisek v jednom AI volání.');
  const tpl = T.gate0Prompt({ prompt: run.input.prompt, clarifications: run.input.clarifications });
  const r = await ctx.callModel({ task: 'gate0', template: tpl.template, system: tpl.system, prompt: tpl.prompt, schema: S.GATE0, input: { prompt: run.input.prompt, clarifications: run.input.clarifications } });
  if (!r.ok) fail(ctx, 'GATE0_FAILED', `Gate 0 selhala: ${r.error}`);
  run.gate0 = { template: tpl.template, callId: r.callId, simulated: r.simulated, ...processGate0(r.data, { prompt: combinedText(run.input), config: ctx.config }) };
}

async function stageAudit(ctx) {
  const { run } = ctx;
  transition(ctx, 'GOAL_AUDIT', 'Izolovaná relace; vstup = zadání + explicitní cíl, bez H1.');
  const tpl = T.goalAuditPrompt({ prompt: run.input.prompt, explicitGoal: run.explicitGoal.text, clarifications: run.input.clarifications });
  const r = await ctx.callModel({ task: 'goal_audit', template: tpl.template, system: tpl.system, prompt: tpl.prompt, schema: S.GOAL_AUDIT, input: { prompt: run.input.prompt, explicitGoal: run.explicitGoal.text, clarifications: run.input.clarifications } });
  if (!r.ok) fail(ctx, 'AUDIT_FAILED', `Audit cíle selhal: ${r.error}`);
  run.goalAudit = { template: tpl.template, callId: r.callId, simulated: r.simulated, isolation: { separateCall: true, receivedH1: false, inputs: ['původní zadání', 'explicitní cíl', 'upřesnění'] }, ...processAudit(r.data, { prompt: combinedText(run.input) }) };
}

async function stageCompare(ctx) {
  const { run } = ctx;
  transition(ctx, 'GOAL_COMPARE', 'Kvalitativní porovnání explicitní cíl / H1 / audit.');
  const plan = planComparison({ explicitGoal: run.explicitGoal.text, h1Statement: run.gate0.h1Goal.statement, auditStatement: run.goalAudit.statement });
  let modelOut = null;
  let callId = null;
  if (plan.forModel.length) {
    const tpl = T.goalComparePrompt({ prompt: run.input.prompt, pairs: plan.forModel });
    const r = await ctx.callModel({ task: 'goal_compare', template: tpl.template, system: tpl.system, prompt: tpl.prompt, schema: S.GOAL_COMPARE, input: { pairs: plan.forModel } });
    callId = r.callId;
    if (r.ok) modelOut = r.data;
  }
  const merged = mergeComparison(plan, modelOut);
  const h1a = merged.pairs.find((p) => p.pair === 'h1_vs_audit');
  run.comparison = {
    ...merged, callId,
    h1Preserved: true,
    h1Correction: h1a && h1a.relation !== 'EQUIVALENT'
      ? { original: run.gate0.h1Goal.statement, auditedAlternative: run.goalAudit.statement, relation: h1a.relation, note: 'Původní report H1 zůstává beze změny; korekce je evidována samostatně.' }
      : null,
  };
}

function stageDecision(ctx) {
  const { run } = ctx;
  transition(ctx, 'DECISION', 'Rozhodovací tabulka A/B/C/D.');
  run.decision = decide({ explicitGoal: run.explicitGoal.text, audit: run.goalAudit, comparison: run.comparison, gate0: run.gate0 });
  if (!run.decision.proceed) {
    run.clarification = { question: run.decision.question, rule: run.decision.rule, askedAt: nowIso() };
    transition(ctx, 'CLARIFICATION_REQUIRED', `STOP — ${run.decision.rule}. Čeká se na upřesnění.`);
    return false;
  }
  return true;
}

async function stageBranches(ctx) {
  const { run, config } = ctx;
  transition(ctx, 'CONTRACTS', `Goal Contracts: ${run.decision.branches.length}.`);
  const contracts = buildContracts({ runId: run.id, decision: run.decision, explicitGoal: run.explicitGoal, gate0: run.gate0, audit: run.goalAudit, prompt: run.input.prompt, clarifications: run.input.clarifications });
  run.contracts = clone(contracts);
  run.branches = contracts.map((c, i) => ({ id: `B${i + 1}`, contractId: c.id, role: c.role, authority: c.authority, attempts: [], repairsUsed: 0, repairDecision: null, finalVerdict: null }));

  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const branch = run.branches[i];
    ctx.branchTag = branch.id;
    transition(ctx, 'COMPILE', `${branch.id}: sestavení Execution Contract (bez AI).`);
    const compiled = compileExecution({ prompt: run.input.prompt, clarifications: run.input.clarifications, contract, gate0: run.gate0 });
    const attempt = { n: 1, kind: 'initial', compiledPrompt: compiled, execution: null, verification: null };
    branch.attempts.push(attempt);
    transition(ctx, 'EXECUTE', `${branch.id}: exekuce.`);
    attempt.execution = await execute({ contract, compiled, callModel: ctx.callModel, config, attemptKind: 'initial' });
    transition(ctx, 'VERIFY', `${branch.id}: verifikace proti ${contract.id}.`);
    attempt.verification = await verify({ contract, execution: attempt.execution, callModel: ctx.callModel, config, canCallModel: () => ctx.callCount < config.limits.maxModelCallsPerRun, prompt: run.input.prompt, clarifications: run.input.clarifications });

    const rd = repairDecision({ verification: attempt.verification, execution: attempt.execution, contract, repairsUsed: branch.repairsUsed, maxRepairs: config.limits.maxRepairPasses, callsRemaining: config.limits.maxModelCallsPerRun - ctx.callCount });
    branch.repairDecision = { repair: rd.repair, reason: rd.reason };
    if (rd.repair) {
      if (branch.repairsUsed >= 1) fail(ctx, 'REPAIR_LIMIT', 'Pokus o druhý opravný průchod zablokován.');
      transition(ctx, 'REPAIR', `${branch.id}: jediný opravný průchod (${rd.failed.length} kritérií).`);
      branch.repairsUsed++;
      const rc = compileRepair({ prompt: run.input.prompt, clarifications: run.input.clarifications, contract, gate0: run.gate0, previous: attempt.execution, failedCriteria: rd.failed });
      const rep = { n: 2, kind: 'repair', compiledPrompt: rc, execution: null, verification: null };
      branch.attempts.push(rep);
      rep.execution = await execute({ contract, compiled: rc, callModel: ctx.callModel, config, attemptKind: 'repair' });
      transition(ctx, 'VERIFY', `${branch.id}: verifikace opravy.`);
      rep.verification = await verify({ contract, execution: rep.execution, callModel: ctx.callModel, config, canCallModel: () => ctx.callCount < config.limits.maxModelCallsPerRun, prompt: run.input.prompt, clarifications: run.input.clarifications });
    }
    branch.finalVerdict = branch.attempts[branch.attempts.length - 1].verification.verdict;
    ctx.persist();
  }
  ctx.branchTag = null;
}

async function stageBaseline(ctx) {
  const { run, config } = ctx;
  transition(ctx, 'BASELINE', 'Experimentální režim BASELINE vs. FR (volitelný).');
  const before = ctx.telemetry.calls.length;
  const t0 = Date.now();
  const tpl = T.baselinePrompt({ prompt: run.input.prompt });
  const r = await ctx.callModel({ task: 'baseline', template: tpl.template, system: tpl.system, prompt: tpl.prompt, schema: S.BASELINE, input: { prompt: run.input.prompt } });
  const execution = r.ok
    ? { mode: 'ai', status: 'completed', output: r.data.output, outputFormat: 'text', artifacts: r.data.artifacts || [], completedOperations: [], blockedOperations: [], simulated: r.simulated, callId: r.callId }
    : { mode: 'ai', status: 'error', error: r.error, output: '', artifacts: [], completedOperations: [], blockedOperations: [], simulated: r.simulated, callId: r.callId };
  const contract = run.contracts[0];
  const verification = await verify({ contract, execution, callModel: ctx.callModel, config, canCallModel: () => ctx.callCount < config.limits.maxModelCallsPerRun, prompt: run.input.prompt, clarifications: run.input.clarifications });
  const calls = ctx.telemetry.calls.slice(before);
  run.baseline = {
    note: 'Přímé řešení modelem bez FR cyklu, ověřené proti stejnému primárnímu Goal Contract.',
    execution, verification,
    cost: { calls: calls.length, inputTokens: calls.reduce((a, c) => a + c.inputTokens, 0), outputTokens: calls.reduce((a, c) => a + c.outputTokens, 0), durationMs: Date.now() - t0 },
  };
}

function stageReport(ctx) {
  const { run } = ctx;
  transition(ctx, 'REPORT', 'Souhrn výsledků, odchylek a telemetrie.');
  const branches = run.branches.map((b) => {
    const last = b.attempts[b.attempts.length - 1];
    const c = run.contracts.find((x) => x.id === b.contractId);
    return {
      branchId: b.id, role: b.role, authority: b.authority, contractId: b.contractId, goal: c.statement,
      verdict: b.finalVerdict, attempts: b.attempts.length, repairNote: b.repairDecision && b.repairDecision.reason,
      executionMode: last.execution.mode, executionStatus: last.execution.status,
      simulated: !!last.execution.simulated,
      deviations: last.verification.deviations,
    };
  });
  run.report = {
    decision: `${run.decision.code} (${run.decision.rule})`,
    branches,
    primaryVerdict: branches[0] ? branches[0].verdict : null,
    simulated: ctx.provider.simulated,
    realityNote: ctx.provider.simulated
      ? 'SIMULACE: odpovědi modelu generoval deterministický mock provider. Algoritmické části (stavový automat, rozhodnutí, kompilace promptu, deterministické nástroje a kontroly, sandbox testy kódu) proběhly reálně.'
      : ctx.provider.id === 'claude-cli'
        ? 'Reálná inference přes Claude Code CLI (předplatné ověřené preflightem).'
        : `Reálná inference: ${ctx.provider.id} (${ctx.provider.model}).`,
  };
}

/** Spustí kompletní cyklus nad připraveným během. Nikdy nevyhodí výjimku ven — chyby zapíše do běhu. */
async function runPipeline({ run, provider, config, persist }) {
  const telemetry = new Telemetry({ provider: provider.describe(), billing: provider.billingInfo() });
  const ctx = { run, provider, config, telemetry, callCount: 0, currentStage: 'RECEIVED', branchTag: null };
  ctx.persist = () => { run.telemetry = { ...telemetry.toJSON(), summary: telemetry.summary(run.state) }; persist(run); };
  ctx.callModel = makeCallModel(ctx);
  telemetry.stageStart('RECEIVED');
  run.provider = { id: provider.id, model: provider.model, simulated: provider.simulated, preflight: null };
  try {
    if (provider.requiresPreflight) {
      const pf = await provider.preflight();
      run.provider.preflight = pf;
      if (!pf.ok) fail(ctx, 'BILLING_GUARD', 'Preflight předplatitelského režimu neprošel — reálná inference je zablokována. Žádný placený ani náhradní provider se neaktivuje.');
    }
    run.explicitGoal = extractExplicitGoal(run.input.prompt, run.input.explicitGoalField);
    await stageGate0(ctx);
    await stageAudit(ctx);
    await stageCompare(ctx);
    if (stageDecision(ctx)) {
      await stageBranches(ctx);
      if (run.input.options.baseline) await stageBaseline(ctx);
      stageReport(ctx);
      transition(ctx, 'DONE', 'Cyklus dokončen.');
    }
  } catch (e) {
    run.error = { code: e.code || 'INTERNAL', message: e.message };
    ctx.telemetry.stageEnd(ctx.currentStage, 'error');
    run.state = 'FAILED';
    run.stateHistory.push({ state: 'FAILED', at: nowIso(), note: e.message });
  }
  telemetry.stageEnd(ctx.currentStage);
  run.finishedAt = nowIso();
  ctx.persist();
  return run;
}

/** Zámek: v jednom okamžiku smí běžet nejvýše jeden běh (žádné nekontrolované souběžné relace). */
class RunManager {
  constructor({ store, config, providers }) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.active = null;
  }

  busy() { return this.active; }

  start({ prompt, explicitGoal, provider, baseline, parentRunId, clarificationAnswer }) {
    if (this.active) throw new FrError('BUSY', `Již probíhá běh ${this.active.id} (stav ${this.active.state}). Souběžné běhy nejsou povoleny.`);
    const providerId = provider || this.config.defaultProvider;
    const p = this.providers[providerId];
    if (!p) throw new FrError('BAD_PROVIDER', `Neznámý provider „${providerId}“.`);
    const parent = parentRunId ? this.store.load(parentRunId) : null;
    if (parentRunId && !parent) throw new FrError('BAD_PARENT', 'Nadřazený běh neexistuje.');
    const run = createRun({ prompt, explicitGoal, provider: providerId, baseline, parent, clarificationAnswer, config: this.config });
    this.active = run;
    this.store.save(run);
    const done = runPipeline({ run, provider: p, config: this.config, persist: (r) => this.store.save(r) })
      .finally(() => { this.active = null; });
    return { run, done };
  }
}

module.exports = { runPipeline, createRun, RunManager, TRANSITIONS, PHASES, FrError, transition };
