'use strict';
/**
 * Goal Contract — verzovaný, neměnný (deep-frozen) cílový kontrakt s hashem obsahu.
 * Změna cíle je možná jen explicitně přes reviseContract() → nová verze s odkazem na předchozí.
 */
const { sha256, canonicalJson, deepFreeze, clone, nowIso } = require('./util');
const { systemCriteria } = require('./criteria');
const { EVALUATOR_VERSION } = require('./evaluator');
const { runTool, TOOLS } = require('../tools');

const SCHEMA_VERSION = 'goal-contract/1.0';

function hashContract(c) {
  const { contentHash, ...rest } = c;
  return sha256(canonicalJson(rest));
}

function uniq(list, n = 12) {
  return Array.from(new Set((list || []).filter(Boolean))).slice(0, n);
}

/** Plán deterministického nástroje (z validovaných kandidátů Gate 0) včetně předem spočteného výsledku. */
function toolPlanFrom(gate0) {
  const cand = (gate0.toolCandidates || []).find((c) => c.accepted);
  if (!cand) return null;
  const r = runTool(cand.tool, cand.input);
  if (!r.ok) return null;
  return { tool: cand.tool, input: cand.input, fullySolves: !!cand.fullySolves, value: r.value, rendered: r.rendered, outputFormat: TOOLS[cand.tool].outputFormat };
}

function toolCriteria(plan) {
  if (!plan) return [];
  if (plan.tool === 'arith_eval') {
    // Číselný výsledek nástroje je povinný vždy, i když nástroj úlohu řeší jen zčásti (např. „a vysvětli postup“).
    // Bench S01: model 201 × nástroj 198 vyšlo jako PASS a učení z toho navrhlo analyzovat méně.
    return [{ id: 'TOOL-1', description: `Číselný výsledek odpovídá přesnému výpočtu ${plan.input} = ${plan.value}.`, mandatory: true, verification: { kind: 'deterministic', type: 'number_equals', params: { expected: plan.value, tolerance: 1e-6 } }, origin: 'deterministic_tool' }];
  }
  if (plan.tool === 'csv_to_json') {
    // Úplný převod je očekávaný výsledek jen u úplného řešení; u filtrování nebo řazení by povinné json_equals
    // shodilo i správnou odpověď (nástroj tu spočítal jen mezikrok).
    return [{ id: 'TOOL-1', description: 'JSON obsahově odpovídá deterministickému převodu vstupního CSV.', mandatory: plan.fullySolves, verification: { kind: 'deterministic', type: 'json_equals', params: { expected: plan.value } }, origin: 'deterministic_tool' }];
  }
  return [];
}

function goalCriterion(statement) {
  return { id: 'GOAL-1', description: `Výsledek věcně naplňuje cíl kontraktu: „${statement}“.`, mandatory: true, verification: { kind: 'semantic', type: 'semantic', params: {} }, origin: 'system' };
}

function basisData(basis, { explicitGoal, gate0, audit }) {
  if (basis === 'explicit') {
    const eqH1 = audit._relations && audit._relations.explicit_vs_h1 === 'EQUIVALENT';
    const eqAudit = audit._relations && audit._relations.explicit_vs_audit === 'EQUIVALENT';
    const comps = eqAudit || !eqH1 ? audit.components : gate0.h1Goal.components;
    return {
      statement: explicitGoal.text,
      components: clone(comps),
      componentsSource: eqAudit ? 'audit (významově shodný)' : eqH1 ? 'H1 (významově shodný)' : 'audit — aproximace, cíl se nekriticky liší',
      criteria: audit.explicitGoalCriteria && audit.explicitGoalCriteria.length ? audit.explicitGoalCriteria : (eqAudit ? audit.acceptanceCriteria : []),
    };
  }
  if (basis === 'audit') return { statement: audit.statement, components: clone(audit.components), componentsSource: 'audit', criteria: audit.acceptanceCriteria };
  return { statement: gate0.h1Goal.statement, components: clone(gate0.h1Goal.components), componentsSource: 'H1', criteria: [] };
}

function buildContract({ runId, index, branch, decision, explicitGoal, gate0, audit, prompt, clarifications }) {
  const b = basisData(branch.basis, { explicitGoal, gate0, audit });
  const plan = toolPlanFrom(gate0);
  const expectedFormat = plan && plan.fullySolves ? plan.outputFormat : audit.expectedOutput.format;
  const criteria = [
    ...b.criteria.map((c) => clone(c)),
    ...toolCriteria(plan),
    goalCriterion(b.statement),
    ...systemCriteria(expectedFormat, gate0.systemFacts.blockedOperations.map((o) => ({ ...o, literalSupport: o.literalSupport !== false }))),
  ];
  // jedinečná ID kritérií
  const seen = new Set();
  for (const c of criteria) { let id = c.id; let k = 2; while (seen.has(id)) id = `${c.id}-${k++}`; c.id = id; seen.add(id); }

  const blocked = gate0.systemFacts.blockedOperations.map((o) => ({ operation: o.operation, category: o.category, literalSupport: o.literalSupport !== false }));
  const unavailable = gate0.systemFacts.unavailableCapabilities;
  const constraints = uniq([
    ...(audit.constraints || []),
    'Výsledek nesmí vydávat předpoklady za ověřená fakta.',
    'Původní cíl nesmí být potichu změněn; odchylky je nutné výslovně vykázat.',
    ...(blocked.length ? [`Blokované operace se neprovádějí ani nevykazují jako splněné: ${blocked.map((o) => o.category).join(', ')}.`] : []),
    ...(unavailable.length ? [`Nedostupné schopnosti (konfigurace): ${unavailable.join(', ')} — odpovídající části označit jako nepodporované.`] : []),
  ], 20);

  const c = {
    schemaVersion: SCHEMA_VERSION,
    id: `GC-${runId}-${index + 1}`,
    version: 1,
    supersedes: null,
    changeReason: null,
    createdAt: nowIso(),
    status: decision.code,
    decisionRule: decision.rule,
    evaluator: EVALUATOR_VERSION,
    role: branch.role,
    authority: branch.authority,
    statement: b.statement,
    components: b.components,
    componentsSource: b.componentsSource,
    origin: {
      basis: branch.basis,
      promptSha256: sha256(prompt),
      clarificationsSha256: clarifications && clarifications.length ? sha256(canonicalJson(clarifications)) : null,
      explicitGoal: explicitGoal.text ? { text: explicitGoal.text, source: explicitGoal.source } : null,
      h1Statement: gate0.h1Goal.statement,
      auditStatement: audit.statement,
    },
    expectedOutput: { format: expectedFormat, description: audit.expectedOutput.description },
    scope: audit.scope || '',
    nonGoals: uniq(audit.nonGoals),
    constraints,
    successCriteria: criteria,
    assumptions: uniq([...(audit.assumptions || []), ...gate0.aspects.flatMap((a) => a.assumptions || [])], 12),
    blockedOperations: blocked,
    unavailableCapabilities: unavailable,
    toolPlan: plan,
    alternativeBranch: null,
  };
  return c;
}

function finalize(c) {
  c.contentHash = hashContract(c);
  return deepFreeze(c);
}

/** Sestaví 1–2 kontrakty podle rozhodnutí; v C jsou vzájemně provázané, ale oddělené. */
function buildContracts(args) {
  const audit = { ...args.audit, _relations: args.decision.relations };
  const drafts = args.decision.branches.map((branch, index) => buildContract({ ...args, audit, branch, index }));
  if (drafts.length === 2) {
    drafts[0].alternativeBranch = drafts[1].id;
    drafts[1].alternativeBranch = drafts[0].id;
  }
  return drafts.map(finalize);
}

/** Explicitní, verzovaná změna kontraktu. Původní verze zůstává nezměněná. */
function reviseContract(contract, changes, reason) {
  if (!reason) throw new Error('Změna Goal Contract vyžaduje zdůvodnění.');
  const forbidden = ['id', 'version', 'supersedes', 'contentHash', 'schemaVersion'];
  for (const k of Object.keys(changes)) if (forbidden.includes(k)) throw new Error(`Pole ${k} nelze měnit.`);
  const next = { ...clone(contract), ...clone(changes), version: contract.version + 1, supersedes: `${contract.id}@v${contract.version}`, changeReason: reason, createdAt: nowIso() };
  delete next.contentHash;
  return finalize(next);
}

function verifyContractHash(c) {
  return hashContract(c) === c.contentHash;
}

module.exports = { buildContracts, reviseContract, verifyContractHash, hashContract, SCHEMA_VERSION };
