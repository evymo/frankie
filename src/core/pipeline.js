'use strict';
/**
 * FR Core — deterministický stavový automat celého cyklu.
 * Algoritmus řídí pořadí, limity, rozhodnutí a evidenci; AI je volána jen v definovaných bodech
 * (Gate 0, Goal Audit, porovnání cílů, exekuce, sémantická verifikace, volitelně baseline).
 *
 * v0.4: PROFILE (charakteristika zadání + výběr H-sestavy z Knowledge Base, bez AI) a LEARN (diagnóza,
 * hypotézy, řízené srovnání, aktualizace KB, bez AI). Každý krok zapisuje perzistentní událost průběhu
 * (run.events) — UI z nich zobrazuje živý provoz i po znovuotevření historie.
 */
const { newId, nowIso, sha256, extractJson, clone, deepFreeze } = require('./util');
const { validate } = require('./schema');
const S = require('./schemas');
const { Telemetry } = require('./telemetry');
const { selectProviderModel } = require('../providers/models');
const { extractExplicitGoal } = require('./detectors');
const { processGate0 } = require('./gate0');
const { processAudit, planComparison, mergeComparison } = require('./goalAudit');
const { decide } = require('./decision');
const { buildContracts, verifyContractHash } = require('./goalContract');
const { compileExecution, compileRepair, EXECUTION_TEMPLATE } = require('./promptCompiler');
const { execute } = require('./executor');
const { verify, repairDecision } = require('./verifier');
const { profileTask, satisfies } = require('./profile');
const { DEFAULT_SET, resolveAspects, setRef, refLabel } = require('./aspectSets');
const { KnowledgeBase } = require('./knowledge');
const { diagnoseBranch, proposeHypotheses, compareExperiment, observationFor } = require('./learning');
const { EVALUATOR_VERSION, evaluatorOf } = require('./evaluator');
const T = require('../templates/analysis');

const FR_VERSION = '0.4.1';

const TRANSITIONS = {
  RECEIVED: ['PROFILE', 'FAILED'],
  PROFILE: ['GATE0', 'FAILED'],
  // GATE0 → CONTRACTS jen v řízeném experimentu: Goal Contract se nepřebírá z nové analýzy, ale je zamčený z původního běhu.
  GATE0: ['GOAL_AUDIT', 'CONTRACTS', 'FAILED'],
  GOAL_AUDIT: ['GOAL_COMPARE', 'FAILED'],
  GOAL_COMPARE: ['DECISION', 'FAILED'],
  DECISION: ['CONTRACTS', 'CLARIFICATION_REQUIRED', 'FAILED'],
  CONTRACTS: ['COMPILE', 'FAILED'],
  COMPILE: ['EXECUTE', 'FAILED'],
  EXECUTE: ['VERIFY', 'FAILED'],
  VERIFY: ['REPAIR', 'COMPILE', 'BASELINE', 'REPORT', 'FAILED'],
  REPAIR: ['VERIFY', 'FAILED'],
  BASELINE: ['REPORT', 'FAILED'],
  REPORT: ['LEARN', 'FAILED'],
  LEARN: ['DONE', 'FAILED'],
  DONE: [], FAILED: [], CLARIFICATION_REQUIRED: [],
};

const PHASES = ['RECEIVED', 'PROFILE', 'GATE0', 'GOAL_AUDIT', 'GOAL_COMPARE', 'DECISION', 'CONTRACTS', 'COMPILE', 'EXECUTE', 'VERIFY', 'REPAIR', 'BASELINE', 'REPORT', 'LEARN', 'DONE'];

const STEP_LABEL = {
  RECEIVED: 'Příjem zadání', PROFILE: 'Profil zadání a výběr H-sestavy', GATE0: 'Analýza hledisek (Gate 0)', GOAL_AUDIT: 'Nezávislý audit cíle',
  GOAL_COMPARE: 'Porovnání cílů', DECISION: 'Rozhodnutí A/B/C/D', CONTRACTS: 'Goal Contract', COMPILE: 'Kompilace exekučního promptu',
  EXECUTE: 'Exekuce', VERIFY: 'Ověření výsledku', REPAIR: 'Řízená oprava (max. 1)', BASELINE: 'Baseline (experiment)', REPORT: 'Souhrn a odchylky',
  LEARN: 'Učení: diagnóza a znalosti', DONE: 'Hotovo', FAILED: 'Selhalo', CLARIFICATION_REQUIRED: 'STOP — čeká na upřesnění',
};

const TASK_LABEL = { gate0: 'Gate 0 — analýza hledisek', goal_audit: 'audit cíle', goal_compare: 'porovnání cílů', execute: 'exekuce', semantic_verify: 'sémantická verifikace', baseline: 'baseline' };

class FrError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function combinedText(input) {
  return [input.prompt, ...(input.clarifications || []).map((c) => c.answer)].join('\n');
}

function createRun({ prompt, explicitGoal, provider, model, baseline, parent, clarificationAnswer, config, learningMode, experiment }) {
  if (parent && experiment) throw new FrError('BAD_INPUT', 'Experiment nelze kombinovat s upřesněním.');
  if (parent) {
    if (parent.state !== 'CLARIFICATION_REQUIRED') throw new FrError('BAD_PARENT', 'Navázat lze jen na běh ve stavu CLARIFICATION_REQUIRED.');
    if (!String(clarificationAnswer || '').trim()) throw new FrError('BAD_INPUT', 'Odpověď na upřesňující otázku je prázdná.');
    prompt = parent.input.prompt;
    // Odpověď na upřesnění je novější projev vůle než původní explicitní cíl, který rozpor způsobil:
    // bez nového cíle se původní nepřebírá (zůstává evidován v previousExplicitGoal).
  }
  if (experiment) {
    // Řízený experiment: TÝŽ původní prompt, upřesnění i explicitní cíl jako původní běh (beze změny).
    prompt = experiment.baseRun.input.prompt;
    explicitGoal = experiment.baseRun.input.explicitGoalField;
    baseline = false;
  }
  prompt = String(prompt || '');
  if (!prompt.trim()) throw new FrError('BAD_INPUT', 'Zadání je prázdné.');
  if (prompt.length > config.limits.maxPromptChars) throw new FrError('BAD_INPUT', `Zadání je delší než limit ${config.limits.maxPromptChars} znaků.`);
  const clarifications = experiment ? clone(experiment.baseRun.input.clarifications || [])
    : parent ? [...(parent.input.clarifications || []), { question: parent.clarification.question, answer: String(clarificationAnswer), fromRunId: parent.id, at: nowIso() }] : [];
  const at = nowIso();
  return {
    id: newId('RUN'),
    schemaVersion: 'fr-run/0.4',
    frVersion: FR_VERSION,
    createdAt: at,
    finishedAt: null,
    state: 'RECEIVED',
    stateHistory: [{ state: 'RECEIVED', at, note: experiment ? `Řízený experiment nad během ${experiment.baseRun.id}.` : 'Zadání přijato.' }],
    events: [{ seq: 1, at, kind: 'stage', step: 'RECEIVED', status: 'done', label: STEP_LABEL.RECEIVED, detail: experiment ? `Řízený experiment: ${experiment.rec.changeText}` : null, branch: null, durationMs: 0 }],
    input: {
      prompt, promptSha256: sha256(prompt), explicitGoalField: String(explicitGoal || '').trim() || null, clarifications,
      parentRunId: parent ? parent.id : null, previousExplicitGoal: parent ? parent.input.explicitGoalField : null,
      options: { provider, model: model || null, baseline: !!baseline, learningMode: experiment ? 'experiment' : learningMode === 'default' ? 'default' : 'auto' },
    },
    experiment: experiment ? {
      baseRunId: experiment.baseRun.id, recommendationId: experiment.rec.id, changeText: experiment.rec.changeText,
      baseSet: experiment.rec.baseSet, candidateSet: experiment.rec.candidateSet,
      lockedContract: { id: experiment.lockedContract.id, contentHash: experiment.lockedContract.contentHash },
      authorization: experiment.authorization,
    } : null,
    explicitGoal: null, provider: null, learning: null, gate0: null, goalAudit: null, comparison: null, decision: null, clarification: null,
    contracts: [], branches: [], baseline: null, report: null, telemetry: null, error: null,
  };
}

/* ---------- události průběhu (perzistentní, bez chain-of-thought) ---------- */
function addEvent(ctx, ev) {
  const run = ctx.run;
  run.events = run.events || [];
  const e = { seq: run.events.length + 1, at: nowIso(), kind: 'step', status: 'running', branch: ctx.branchTag || null, detail: null, ...ev };
  if (e.status !== 'running') e.durationMs = e.durationMs ?? 0;
  run.events.push(e);
  return e;
}

function endEvent(e, status = 'done', detail) {
  if (!e || e.status !== 'running') return;
  e.status = status;
  e.endedAt = nowIso();
  e.durationMs = Date.parse(e.endedAt) - Date.parse(e.at);
  if (detail !== undefined) e.detail = detail;
}

function transition(ctx, to, note = '') {
  const { run } = ctx;
  const allowed = TRANSITIONS[run.state] || [];
  if (!allowed.includes(to)) throw new FrError('ILLEGAL_TRANSITION', `Nepovolený přechod ${run.state} → ${to}`);
  ctx.telemetry.stageEnd(ctx.currentStage);
  endEvent(ctx.stageEvent, 'done');
  run.state = to;
  run.stateHistory.push({ state: to, at: nowIso(), note });
  ctx.currentStage = `${to}${ctx.branchTag ? ':' + ctx.branchTag : ''}`;
  ctx.telemetry.stageStart(ctx.currentStage);
  if (ctx.events !== false) {
    const terminal = ['DONE', 'CLARIFICATION_REQUIRED'].includes(to);
    ctx.stageEvent = addEvent(ctx, { kind: 'stage', step: to, label: STEP_LABEL[to] || to, detail: note || null, status: terminal ? (to === 'DONE' ? 'done' : 'stopped') : 'running' });
  }
  ctx.persist();
}

function step(ctx, stepId, label, status, detail, extra = {}) {
  const e = addEvent(ctx, { step: stepId, label, status, detail, ...extra });
  ctx.persist();
  return e;
}

/** Jediný vstupní bod pro AI: limity, validace schématu, max. 1 opakování při neplatném výstupu, telemetrie, událost průběhu. */
function makeCallModel(ctx) {
  return async function callModel(req) {
    const { provider, config, telemetry } = ctx;
    let prompt = req.prompt;
    let lastErr = null;
    let lastCallId = null;
    const maxAttempts = 1 + Math.max(0, Math.min(1, config.limits.maxRetriesPerCall));
    const ev = ctx.events === false ? null : addEvent(ctx, {
      kind: 'call', step: req.task, label: `Modelové volání: ${TASK_LABEL[req.task] || req.task}`,
      call: { task: req.task, provider: provider.id, model: provider.model, simulated: !!provider.simulated, template: req.template ? `${req.template.id}@${req.template.version}` : null },
    });
    if (ev && ctx.persist) ctx.persist();
    const finish = (status, detail) => { endEvent(ev, status, detail); return undefined; };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (ctx.callCount >= config.limits.maxModelCallsPerRun) {
        finish('blocked', `Limit modelových volání na běh (${config.limits.maxModelCallsPerRun}) vyčerpán — volání neproběhlo.`);
        return { ok: false, error: `Limit modelových volání na běh (${config.limits.maxModelCallsPerRun}) vyčerpán.`, callId: lastCallId, simulated: provider.simulated };
      }
      ctx.callCount++;
      const t0 = Date.now();
      let res;
      try {
        res = await provider.call({ ...req, prompt });
      } catch (e) {
        lastCallId = telemetry.recordCall({ task: req.task, stage: ctx.currentStage, template: req.template, provider: provider.id, model: provider.model, simulated: provider.simulated, durationMs: Date.now() - t0, attempts: attempt, status: 'error', error: e.message, promptChars: prompt.length, promptSha256: sha256(prompt) });
        finish('failed', `${lastCallId}: chyba volání — ${e.message}`);
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
      if (!errs.length) {
        finish('done', `${lastCallId}${attempt > 1 ? ` (po ${attempt - 1} opakování kvůli formátu)` : ''}${res.simulated ? ' · simulace' : ''}`);
        return { ok: true, data, callId: lastCallId, simulated: !!res.simulated };
      }
      lastErr = `Výstup neodpovídá schématu: ${errs.slice(0, 5).join('; ')}`;
      prompt = `${req.prompt}\n\n## OPRAVA FORMÁTU\nPředchozí odpověď byla neplatná (${errs.slice(0, 5).join('; ')}). Vrať pouze platný JSON podle struktury.`;
    }
    finish('failed', `${lastCallId}: neplatný výstup i po opakování`);
    return { ok: false, error: lastErr, callId: lastCallId, simulated: provider.simulated };
  };
}

function fail(ctx, code, message) {
  throw new FrError(code, message);
}

/* ---------- PROFILE: charakteristika + výběr H-sestavy (bez AI) ---------- */
function stageProfile(ctx) {
  const { run, config } = ctx;
  transition(ctx, 'PROFILE', 'Charakteristika zadání a výběr analytické sestavy — bez AI volání.');
  const profile = profileTask({ prompt: run.input.prompt, explicitGoal: run.explicitGoal.text, clarifications: run.input.clarifications });
  const f = profile.features;
  step(ctx, 'PROFILE_TASK', 'Profil zadání', 'done', `povaha ${f.kind} · artefakt ${f.artifact} · jazyk ${f.language} · ověřitelnost ${f.verifiability}${f.constraints.length ? ' · omezení ' + f.constraints.join(', ') : ''}${f.needs.length ? ' · potřebuje ' + f.needs.join(', ') : ''}${f.risks.length ? ' · rizika ' + f.risks.join(', ') : ''}`);
  const learningOn = !(config.learning && config.learning.enabled === false);
  let sel;
  if (ctx.experiment) {
    sel = { mode: 'experiment', set: ctx.experiment.set, appliedRecommendationId: ctx.experiment.rec.id, candidates: [],
      reason: `Řízený experiment (spuštěn uživatelem): kandidátní sestava ${refLabel(ctx.experiment.rec.candidateSet)} — ${ctx.experiment.rec.changeText} — proti zamčenému ${ctx.experiment.lockedContract.id} z běhu ${ctx.experiment.baseRun.id}.` };
  } else if (!learningOn) {
    sel = { mode: 'default', set: DEFAULT_SET, appliedRecommendationId: null, candidates: [], reason: 'Učení je v konfiguraci vypnuto — výchozí sestava.' };
  } else {
    ctx.kb.reload(); // zkušenosti kolegů mohly přibýt (git pull)
    sel = ctx.kb.select(profile, { mode: run.input.options.learningMode });
  }
  ctx.aspectSet = sel.set;
  run.learning = {
    version: 'fr-learning/1',
    enabled: learningOn,
    kbAvailable: ctx.kb.available(),
    profile,
    selection: {
      mode: sel.mode, set: setRef(sel.set), setLabel: sel.set.label, aspects: resolveAspects(sel.set).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
      floors: sel.set.floors, caps: sel.set.caps, appliedRecommendationId: sel.appliedRecommendationId, reason: sel.reason, candidates: sel.candidates,
    },
    diagnosis: null, hypotheses: [], comparison: null, observation: null, kbUpdate: null,
  };
  const modeText = { applied: 'AKTIVNĚ POUŽITA ověřená zkušenost', experiment: 'experiment — kandidátní sestava', default: 'výchozí sestava' }[sel.mode];
  step(ctx, 'ASPECT_SET', 'Výběr H-sestavy', 'done', `${refLabel(setRef(sel.set))} (${modeText}). ${sel.reason}${sel.candidates.filter((c) => !c.applied).length ? ` Doporučeno, nepoužito: ${sel.candidates.filter((c) => !c.applied).length}.` : ''}`);
}

async function stageGate0(ctx) {
  const { run } = ctx;
  const set = ctx.aspectSet || DEFAULT_SET;
  const defs = resolveAspects(set);
  transition(ctx, 'GATE0', `${defs.length} hledisek sestavy ${refLabel(setRef(set))} v jednom AI volání.`);
  const tpl = T.gate0Prompt({ prompt: run.input.prompt, clarifications: run.input.clarifications, aspectSet: set });
  const r = await ctx.callModel({ task: 'gate0', template: tpl.template, system: tpl.system, prompt: tpl.prompt, schema: S.gate0Schema(defs.map((a) => a.id)), input: { prompt: run.input.prompt, clarifications: run.input.clarifications, aspects: defs } });
  if (!r.ok) fail(ctx, 'GATE0_FAILED', `Gate 0 selhala: ${r.error}`);
  run.gate0 = { template: tpl.template, callId: r.callId, simulated: r.simulated, ...processGate0(r.data, { prompt: combinedText(run.input), config: ctx.config, aspectSet: set }) };
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
  } else if (ctx.stageEvent) ctx.stageEvent.detail = 'Bez AI volání — vztah cílů určen algoritmicky.';
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
  if (ctx.stageEvent) ctx.stageEvent.detail = `${run.decision.code} (${run.decision.rule}) — ${run.decision.proceed ? 'pokračuje se' : 'STOP'}`;
  if (!run.decision.proceed) {
    run.clarification = { question: run.decision.question, rule: run.decision.rule, askedAt: nowIso() };
    transition(ctx, 'CLARIFICATION_REQUIRED', `STOP — ${run.decision.rule}. Čeká se na upřesnění.`);
    step(ctx, 'LEARN', 'Učení', 'skipped', 'Běh skončil upřesňující otázkou — bez výsledku k diagnóze se znalosti neaktualizují.');
    return false;
  }
  return true;
}

/** Řízený experiment: Goal Contract se převezme ZAMČENÝ z původního běhu (ověřený hash), cíl ani kritéria se nemění. */
function stageLockedContract(ctx) {
  const { run } = ctx;
  const base = ctx.experiment.baseRun;
  const locked = ctx.experiment.lockedContract;
  transition(ctx, 'CONTRACTS', `Zamčený ${locked.id}@v${locked.version} z běhu ${base.id} — bez auditu a nového rozhodování.`);
  if (!verifyContractHash(locked)) fail(ctx, 'LOCKED_CONTRACT', 'Hash zamčeného Goal Contract nesouhlasí s obsahem — experiment zastaven.');
  run.decision = { ...clone(base.decision), lockedFrom: base.id, note: 'Převzato z původního běhu (řízený experiment).' };
  return [deepFreeze(clone(locked))];
}

async function stageBranches(ctx, lockedContracts = null) {
  const { run, config } = ctx;
  let contracts = lockedContracts;
  if (!contracts) {
    transition(ctx, 'CONTRACTS', `Goal Contracts: ${run.decision.branches.length}.`);
    contracts = buildContracts({ runId: run.id, decision: run.decision, explicitGoal: run.explicitGoal, gate0: run.gate0, audit: run.goalAudit, prompt: run.input.prompt, clarifications: run.input.clarifications });
  }
  run.contracts = clone(contracts);
  run.branches = contracts.map((c, i) => ({ id: `B${i + 1}`, contractId: c.id, role: c.role, authority: c.authority, attempts: [], repairsUsed: 0, repairDecision: null, finalVerdict: null }));

  for (let i = 0; i < contracts.length; i++) {
    const contract = contracts[i];
    const branch = run.branches[i];
    ctx.branchTag = branch.id;
    transition(ctx, 'COMPILE', `${branch.id}: sestavení Execution Contract (bez AI).`);
    const compiled = compileExecution({ prompt: run.input.prompt, clarifications: run.input.clarifications, contract, gate0: run.gate0 });
    if (ctx.stageEvent) ctx.stageEvent.detail = `${branch.id}: ${compiled.template.id}@${compiled.template.version}, ${compiled.chars} znaků; do promptu propsána hlediska ${compiled.aspectTrace.included.map((a) => a.id).join(', ') || '—'}${compiled.aspectTrace.omitted.length ? `; vynechána (P3) ${compiled.aspectTrace.omitted.map((a) => a.id).join(', ')}` : ''}.`;
    const attempt = { n: 1, kind: 'initial', compiledPrompt: compiled, execution: null, verification: null };
    branch.attempts.push(attempt);
    transition(ctx, 'EXECUTE', `${branch.id}: exekuce.`);
    attempt.execution = await execute({ contract, compiled, callModel: ctx.callModel, config, attemptKind: 'initial' });
    if (ctx.stageEvent) ctx.stageEvent.detail = `${branch.id}: ${attempt.execution.mode === 'deterministic_tool' ? `deterministický nástroj ${attempt.execution.tool} (bez AI)` : 'AI'} · stav ${attempt.execution.status}`;
    transition(ctx, 'VERIFY', `${branch.id}: verifikace proti ${contract.id}.`);
    attempt.verification = await verify({ contract, execution: attempt.execution, callModel: ctx.callModel, config, canCallModel: () => ctx.callCount < config.limits.maxModelCallsPerRun, prompt: run.input.prompt, clarifications: run.input.clarifications });
    if (ctx.stageEvent) ctx.stageEvent.detail = `${branch.id}: verdikt ${attempt.verification.verdict} (povinná ${attempt.verification.counts.passed}/${attempt.verification.counts.mandatory} PASS)`;

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
      if (ctx.stageEvent) ctx.stageEvent.detail = `${branch.id}: verdikt po opravě ${rep.verification.verdict}`;
    } else {
      const deviation = attempt.verification.verdict !== 'PASS';
      step(ctx, 'REPAIR_DECISION', deviation ? 'Zjištěná odchylka — oprava se nespouští' : 'Oprava není potřeba', deviation ? 'skipped' : 'done', `${branch.id}: ${rd.reason}`);
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
    aspectSet: run.gate0.aspectSet,
    evaluator: EVALUATOR_VERSION,
    branches,
    primaryVerdict: branches[0] ? branches[0].verdict : null,
    simulated: ctx.provider.simulated,
    realityNote: ctx.provider.simulated
      ? 'SIMULACE: odpovědi modelu generoval deterministický mock provider. Algoritmické části (stavový automat, rozhodnutí, kompilace promptu, deterministické nástroje a kontroly, sandbox testy kódu) proběhly reálně.'
      : 'Reálná inference přes Claude Code CLI (předplatné ověřené preflightem).',
  };
}

function experienceOf(run, diagnoses, telemetrySummary) {
  const L = run.learning;
  const traces = run.branches.map((b) => b.attempts[0] && b.attempts[0].compiledPrompt && b.attempts[0].compiledPrompt.aspectTrace).filter(Boolean);
  return {
    runId: run.id,
    promptSha256: run.input.promptSha256,
    simulated: !!run.provider.simulated,
    provider: { id: run.provider.id, model: run.provider.model },
    experiment: run.experiment ? { baseRunId: run.experiment.baseRunId, recommendationId: run.experiment.recommendationId } : null,
    profile: L.profile.features,
    observed: { taskType: run.gate0.taskType, decision: `${run.decision.code}/${run.decision.rule}` },
    aspectSet: run.gate0.aspectSet,
    selectionMode: L.selection.mode,
    appliedRecommendationId: L.selection.appliedRecommendationId,
    branches: diagnoses.map((d) => {
      const c = run.contracts.find((x) => x.id === d.contractId);
      return { branchId: d.branchId, contractId: d.contractId, contractHash: c.contentHash, evaluator: d.evaluator, verdict: d.verdict, causes: d.counts, signals: d.signals, failed: d.items.filter((i) => i.mandatory).map((i) => ({ criterionId: i.criterionId, checkType: i.checkType, cause: i.cause })) };
    }),
    aspectTrace: traces.map((t) => ({ included: t.included.map((a) => a.id), omitted: t.omitted.map((a) => a.id) })),
    cost: { calls: telemetrySummary.calls, inputTokens: telemetrySummary.inputTokens, outputTokens: telemetrySummary.outputTokens, totalMs: telemetrySummary.totalMs },
  };
}

/* ---------- LEARN: diagnóza → (srovnání | pozorování | hypotézy) → Knowledge Base (bez AI) ---------- */
function stageLearn(ctx) {
  const { run, kb } = ctx;
  transition(ctx, 'LEARN', 'Diagnóza odchylek, hypotézy a aktualizace Knowledge Base — bez AI volání.');
  const L = run.learning;
  const diagnoses = run.branches.filter((b) => b.attempts.length && b.attempts[b.attempts.length - 1].verification).map((branch) => diagnoseBranch({ run, branch }));
  L.diagnosis = diagnoses;
  for (const d of diagnoses) {
    step(ctx, 'DIAGNOSIS', d.verdict === 'PASS' ? 'Diagnóza: bez odchylek' : 'Diagnóza zjištěné odchylky', d.verdict === 'PASS' ? 'done' : 'info', `${d.branchId}: ${d.summary}${d.evidenceGrade === 'simulated' ? ' (simulace — není důkaz kvality)' : ''}`, { branch: d.branchId });
  }

  if (ctx.experiment) {
    const cmp = compareExperiment({ baseRun: ctx.experiment.baseRun, expRun: run, rec: ctx.experiment.rec });
    L.comparison = cmp;
    step(ctx, 'COMPARISON', 'Řízené srovnání se zamčeným cílem', cmp.counted ? 'done' : 'info', `${refLabel(cmp.baseSet)} → ${cmp.verdicts.base}, ${refLabel(cmp.candidateSet)} → ${cmp.verdicts.experiment}; kvalita: ${cmp.quality}. ${cmp.note}`);
  } else if (L.selection.mode === 'applied') {
    L.observation = observationFor({ run, diagnoses, recId: L.selection.appliedRecommendationId });
    step(ctx, 'OBSERVATION', 'Pozorování použité zkušenosti', 'info', L.observation.note);
  } else if (L.enabled) {
    const hyps = proposeHypotheses({ diagnoses, profile: L.profile, aspectSet: ctx.aspectSet || DEFAULT_SET, gate0: run.gate0, runId: run.id, simulated: run.provider.simulated });
    L.hypotheses = hyps.map((h) => ({ kind: h.kind, change: h.change, changeText: h.changeText, signal: h.signal, rationale: h.rationale, baseSet: setRef(h.baseSet), candidateSet: setRef(h.candidateSet), applicability: h.applicability, recommendationId: null, isNew: null, status: 'candidate', simulatedOrigin: !!run.provider.simulated }));
    ctx.hypothesesFull = hyps;
    const blockedReasons = diagnoses.filter((d) => d.verdict !== 'PASS' && !d.hFeedback).map((d) => d.summary);
    step(ctx, 'HYPOTHESES', hyps.length ? 'Návrh alternativní H-sestavy' : 'Návrh alternativy', hyps.length ? 'done' : 'skipped',
      hyps.length ? hyps.map((h) => `${h.kind === 'reduction' ? 'redukce' : 'obohacení'}: ${h.changeText} (kandidát, neověřeno)`).join('; ')
        : blockedReasons.length ? `Žádná hypotéza: ${blockedReasons[0]}` : diagnoses.every((d) => d.verdict === 'PASS') ? 'Žádná hypotéza: úspěch bez nevyužitých adaptivních hledisek.' : 'Žádná hypotéza: odchylky nejsou připsány H-sestavě (simulace / neověřeno).');
  }

  if (!L.enabled) {
    L.kbUpdate = { saved: false, reason: 'Učení je v konfiguraci vypnuto.' };
    step(ctx, 'KB_UPDATE', 'Aktualizace znalostí', 'skipped', L.kbUpdate.reason);
    return;
  }
  const ev = step(ctx, 'KB_UPDATE', 'Aktualizace znalostí', 'running', null);
  try {
    if (!kb.available()) throw new Error(kb.error);
    const exp = kb.recordExperience(experienceOf(run, diagnoses, ctx.telemetry.summary(run.state)));
    const written = [`zkušenost ${exp.id}`];
    if (L.comparison) {
      const row = kb.recordComparison(L.comparison);
      L.comparison.recorded = { comparisonId: row.id, statusChange: row.statusChange || null };
      written.push(`srovnání ${row.id}${row.statusChange ? ` (stav doporučení ${row.statusChange.from} → ${row.statusChange.to})` : ''}`);
    }
    if (L.observation) {
      const o = kb.recordObservation(L.observation.recommendationId, L.observation);
      if (o) { L.observation.statusChange = o.statusChange; written.push(`pozorování k ${L.observation.recommendationId}`); }
    }
    (ctx.hypothesesFull || []).forEach((h, i) => {
      const { rec, isNew } = kb.upsertRecommendation(h);
      Object.assign(L.hypotheses[i], { recommendationId: rec.id, isNew, status: rec.status, proposals: rec.proposals.length });
      written.push(`${isNew ? 'nový kandidát' : 'opakovaný návrh'} ${rec.id}`);
    });
    const saved = kb.save();
    L.kbUpdate = { saved: true, storage: saved.storage, at: nowIso(), experienceId: exp.id, written };
    endEvent(ev, 'done', `Uloženo (${saved.storage}): ${written.join(', ')}.`);
  } catch (e) {
    L.kbUpdate = { saved: false, error: e.message };
    endEvent(ev, 'failed', `Knowledge Base nebyla aktualizována: ${e.message}`);
  }
  ctx.persist();
}

/** Spustí kompletní cyklus nad připraveným během. Nikdy nevyhodí výjimku ven — chyby zapíše do běhu. */
async function runPipeline({ run, provider, config, persist, kb, experiment }) {
  const telemetry = new Telemetry({ provider: provider.describe(), billing: provider.billingInfo() });
  const ctx = { run, provider, config, telemetry, callCount: 0, currentStage: 'RECEIVED', branchTag: null, kb: kb || new KnowledgeBase({ config }), experiment: experiment || null, stageEvent: null };
  ctx.persist = () => { run.telemetry = { ...telemetry.toJSON(), summary: telemetry.summary(run.state) }; persist(run); };
  ctx.callModel = makeCallModel(ctx);
  telemetry.stageStart('RECEIVED');
  run.provider = { id: provider.id, model: provider.model, simulated: provider.simulated, preflight: null };
  try {
    if (provider.requiresPreflight) {
      const ev = step(ctx, 'PREFLIGHT', 'Preflight předplatitelského režimu (bez inference)', 'running', null);
      const pf = await provider.preflight();
      run.provider.preflight = pf;
      if (!pf.ok) {
        endEvent(ev, 'blocked', 'Preflight neprošel — reálná inference zablokována, žádný placený ani náhradní provider se neaktivuje.');
        fail(ctx, 'BILLING_GUARD', 'Preflight předplatitelského režimu neprošel — reálná inference je zablokována. Žádný placený ani náhradní provider se neaktivuje.');
      }
      endEvent(ev, 'done', 'Předplatitelský režim ověřen.');
    }
    run.explicitGoal = extractExplicitGoal(run.input.prompt, run.input.explicitGoalField);
    stageProfile(ctx);
    await stageGate0(ctx);
    if (ctx.experiment) {
      await stageBranches(ctx, stageLockedContract(ctx));
      stageReport(ctx);
      stageLearn(ctx);
      transition(ctx, 'DONE', 'Řízený experiment dokončen.');
    } else {
      await stageAudit(ctx);
      await stageCompare(ctx);
      if (stageDecision(ctx)) {
        await stageBranches(ctx);
        if (run.input.options.baseline) await stageBaseline(ctx);
        stageReport(ctx);
        stageLearn(ctx);
        transition(ctx, 'DONE', 'Cyklus dokončen.');
      }
    }
  } catch (e) {
    run.error = { code: e.code || 'INTERNAL', message: e.message };
    ctx.telemetry.stageEnd(ctx.currentStage, 'error');
    for (const ev of run.events || []) if (ev.status === 'running') endEvent(ev, 'failed');
    run.state = 'FAILED';
    run.stateHistory.push({ state: 'FAILED', at: nowIso(), note: e.message });
    addEvent(ctx, { kind: 'stage', step: 'FAILED', label: STEP_LABEL.FAILED, status: 'failed', detail: `${run.error.code}: ${e.message}` });
  }
  telemetry.stageEnd(ctx.currentStage);
  run.finishedAt = nowIso();
  ctx.persist();
  return run;
}

/**
 * Validace řízeného experimentu (bez inference). Experiment spouští jen uživatel; nikdy se neřetězí automaticky.
 * Reálný experiment vyžaduje povolení v konfiguraci (learning.realExperiments.enabled) A výslovné potvrzení v požadavku.
 */
function planExperiment({ baseRun, kb, config, provider, recommendationId, confirmRealCalls }) {
  const E = (m) => new FrError('BAD_EXPERIMENT', m);
  if (!baseRun) throw E('Původní běh neexistuje.');
  if (baseRun.experiment) throw E('Experiment nelze stavět na jiném experimentu (žádné řetězení pokusů).');
  if (baseRun.state !== 'DONE' || !(baseRun.contracts || []).length || !(baseRun.branches || []).length) throw E('Původní běh musí být dokončený (DONE) s Goal Contract a ověřeným výsledkem.');
  const rec = kb.recommendation(recommendationId);
  if (!rec) throw E('Doporučení (kandidát H-sestavy) v Knowledge Base neexistuje.');
  if (!baseRun.gate0 || !baseRun.gate0.aspectSet || baseRun.gate0.aspectSet.hash !== rec.baseSet.hash) throw E(`Původní běh nepoužil základní sestavu doporučení (${refLabel(rec.baseSet)}) — srovnání by neměnilo jen jednu věc.`);
  const primary = baseRun.branches[0];
  const bv = primary.attempts[primary.attempts.length - 1].verification;
  if (evaluatorOf(bv) !== EVALUATOR_VERSION) throw E(`Původní běh hodnotil hodnotitel ${evaluatorOf(bv)}, nyní platí ${EVALUATOR_VERSION} — výsledky nejsou srovnatelné.`);
  if (baseRun.gate0.template.version !== T.GATE0_V.version || primary.attempts[0].compiledPrompt.template.version !== EXECUTION_TEMPLATE.version) throw E('Původní běh použil jinou verzi šablon — výsledky nejsou srovnatelné.');
  if (baseRun.provider.id !== provider.id || baseRun.provider.model !== provider.model) throw E(`Experiment musí použít stejný provider a model jako původní běh (${baseRun.provider.id} · ${baseRun.provider.model}).`);
  if (!baseRun.learning || !satisfies(baseRun.learning.profile, rec.applicability).ok) throw E('Charakteristika původního běhu nesplňuje podmínky použitelnosti doporučení.');
  if (kb.hasComparison(baseRun.id, rec.candidateSet.hash)) throw E('Toto srovnání už proběhlo — opakování téhož experimentu by bylo hledáním šťastného výsledku.');
  const set = kb.getSet(rec.candidateSet.id);
  if (!set) throw E('Kandidátní H-sestava v Knowledge Base chybí nebo je neplatná.');
  const lockedContract = baseRun.contracts.find((c) => c.id === primary.contractId);
  let authorization = { mode: 'simulation', note: 'Mock — bez inference a bez nákladů.' };
  if (!provider.simulated) {
    const re = (config.learning && config.learning.realExperiments) || {};
    if (!re.enabled) throw new FrError('NOT_AUTHORIZED', 'Reálné experimenty nejsou povolené (config/fr.config.json → learning.realExperiments.enabled). Kandidát zůstává uložen a lze ho prověřit simulací.');
    if (confirmRealCalls !== true) throw new FrError('NOT_AUTHORIZED', 'Reálný experiment vyžaduje výslovné potvrzení dodatečných modelových volání.');
    const today = nowIso().slice(0, 10);
    const used = kb.data.comparisons.filter((c) => !c.simulated && String(c.at).slice(0, 10) === today).length;
    if (used >= (re.maxPerDay || 0)) throw new FrError('NOT_AUTHORIZED', `Denní limit reálných experimentů (${re.maxPerDay || 0}) je vyčerpán.`);
    authorization = { mode: 'real', confirmedByUser: true, at: nowIso(), maxPerDay: re.maxPerDay, usedToday: used, expectedCalls: '3–5 (Gate 0, exekuce, sémantická verifikace, případně 1 oprava)' };
  }
  return { baseRun, rec, set, lockedContract, authorization };
}

/** Zámek: v jednom okamžiku smí běžet nejvýše jeden běh (žádné nekontrolované souběžné relace). */
class RunManager {
  constructor({ store, config, providers, kb }) {
    this.store = store;
    this.config = config;
    this.providers = providers;
    this.kb = kb || new KnowledgeBase({ config });
    this.active = null;
  }

  busy() { return this.active; }

  start({ prompt, explicitGoal, provider, model, baseline, parentRunId, clarificationAnswer, learningMode, experiment }) {
    if (this.active) throw new FrError('BUSY', `Již probíhá běh ${this.active.id} (stav ${this.active.state}). Souběžné běhy nejsou povoleny.`);
    const parent = parentRunId ? this.store.load(parentRunId) : null;
    if (parentRunId && !parent) throw new FrError('BAD_PARENT', 'Nadřazený běh neexistuje.');
    const experimentBase = experiment && /^[A-Za-z0-9-]+$/.test(experiment.baseRunId) ? this.store.load(experiment.baseRunId) : null;
    const providerId = provider || experimentBase?.provider.id || parent?.input.options.provider || this.config.defaultProvider;
    const baseProvider = this.providers[providerId];
    if (!baseProvider) throw new FrError('BAD_PROVIDER', 'Neznámý provider: ' + providerId);
    const inheritedModel = experimentBase?.provider.id === providerId ? experimentBase.provider.model : parent?.input.options.provider === providerId ? parent.input.options.model : undefined;
    const requestedModel = model === undefined ? inheritedModel : model;
    const p = selectProviderModel(baseProvider, requestedModel);
    const plan = experiment ? planExperiment({ baseRun: experimentBase, kb: this.kb, config: this.config, provider: p, recommendationId: experiment.recommendationId, confirmRealCalls: experiment.confirmRealCalls }) : null;
    const run = createRun({ prompt, explicitGoal, provider: providerId, model: p.model, baseline, parent, clarificationAnswer, config: this.config, learningMode, experiment: plan });
    this.active = run;
    this.store.save(run);
    const done = runPipeline({ run, provider: p, config: this.config, persist: (r) => this.store.save(r), kb: this.kb, experiment: plan })
      .finally(() => { this.active = null; });
    return { run, done };
  }
}

module.exports = { runPipeline, createRun, planExperiment, RunManager, TRANSITIONS, PHASES, STEP_LABEL, FrError, transition, FR_VERSION };
