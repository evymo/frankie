'use strict';
/**
 * Goal Contract — verzovaný, neměnný (deep-frozen) cílový kontrakt s hashem obsahu.
 * Změna cíle je možná jen explicitně přes reviseContract() → nová verze s odkazem na předchozí.
 */
const { sha256, canonicalJson, deepFreeze, clone, nowIso } = require('./util');
const { systemCriteria } = require('./criteria');
const { EVALUATOR_VERSION } = require('./evaluator');
const { runTool, TOOLS } = require('../tools');
const { numbers, replaceNumbers } = require('./numbers');
const { evaluateWithSteps } = require('../tools/arith');

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
    // fullySolves vyplňuje model, proto o povinnosti TOOL-1 nerozhoduje: řádky a hodnoty nesmí být vymyšlené nikdy.
    // Úplnost (TOOL-2) jen u úplného převodu; u filtrování je úplný převod mezikrok a správnou odpověď by shodil.
    return [
      { id: 'TOOL-1', description: 'Každý řádek výstupu je řádkem deterministického převodu vstupního CSV (nic vymyšleného ani zdvojeného).', mandatory: true, verification: { kind: 'deterministic', type: 'json_rows_subset', params: { expected: plan.value } }, origin: 'deterministic_tool' },
      { id: 'TOOL-2', description: 'JSON obsahově odpovídá úplnému deterministickému převodu vstupního CSV.', mandatory: plan.fullySolves, verification: { kind: 'deterministic', type: 'json_equals', params: { expected: plan.value } }, origin: 'deterministic_tool' },
    ];
  }
  return [];
}

// Typy kontrol, u nichž je číslo limitem nebo strukturou, ne výsledkem (veto je nebere).
const NON_RESULT_TYPES = new Set(['max_words', 'min_words', 'json_valid', 'json_schema', 'json_equals', 'json_rows_subset', 'js_function_tests', 'code_artifact_present', 'nonempty', 'no_blocked_claims', 'blocked_scope']);
const near = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/**
 * Hlídač čísel u arith_eval (veto nástroje, hodnotitel 1.3.0). Povolená čísla = výsledek nástroje ∪ mezivýsledky
 * výrazu ∪ čísla doslovně v zadání (a v upřesněních / explicitním cíli). Bez klíčových slov: o rozporu rozhoduje jen to,
 * zda je číslo matematicky doložené, ne jak ho model formuloval. Vrací null, když kontrakt nemá číselný nástroj.
 */
function numberGuard(plan, texts = []) {
  if (!plan || plan.tool !== 'arith_eval' || !Number.isFinite(plan.value)) return null;
  let steps = [];
  try { steps = evaluateWithSteps(plan.input).steps; } catch (_) { steps = []; }
  const base = [plan.value, ...steps, ...numbers(plan.input), ...texts.flatMap((t) => numbers(t || ''))];
  const allowed = [...base, ...base.map((n) => Math.abs(n))];
  return { plan, toolValue: plan.value, allowed, foreign: (n) => !allowed.some((x) => near(n, x)) };
}

/** Cizí čísla, která kritérium navržené modelem nese ([] = v pořádku). Kritéria nástroje a systému se neberou. */
function criterionForeignNumbers(c, guard) {
  if (!guard || c.origin === 'deterministic_tool' || c.origin === 'tool_override' || (c.origin === 'system' && c.id !== 'GOAL-1')) return [];
  const v = c.verification || {};
  const p = v.params || {};
  if (NON_RESULT_TYPES.has(v.type)) return [];
  if (v.type === 'not_contains') {
    // Zakázat chybnou hodnotu je v pořádku; zakázat výsledek nástroje (nebo mezivýsledek) je rozpor.
    return numbers(p.text || '').some((n) => !guard.foreign(n)) ? [guard.toolValue] : [];
  }
  const found = numbers(c.description || '').filter(guard.foreign);
  if (v.type === 'number_equals' && Number.isFinite(Number(p.expected)) && guard.foreign(Number(p.expected))) found.push(Number(p.expected));
  if (v.type === 'contains') found.push(...numbers(p.text || '').filter(guard.foreign));
  // Ve vzoru regexu se kvantifikátory {n,m} a třídy \d … za čísla nepovažují.
  if (v.type === 'regex') found.push(...numbers(String(p.pattern || '').replace(/\{\d+(?:,\d*)?\}/g, ' ').replace(/\\[a-zA-Z]/g, ' ')).filter(guard.foreign));
  return [...new Set(found)];
}

function conflictFinding(guard, extra) {
  return { type: 'tool_conflict', status: 'proposed', toolValue: guard.toolValue, tool: guard.plan.tool, toolInput: guard.plan.input, ...extra };
}

/**
 * Veto nástroje při vzniku kontraktu: kritérium z modelu s cizím číslem se nahradí kontrolou hodnoty nástroje
 * (popis náhrady číslo z modelu NEnese — jde do Execution Contract), rozpor → nález kontraktu (proposed).
 */
function vetoCriterion(c, guard, findings) {
  const foreign = criterionForeignNumbers(c, guard);
  if (!foreign.length) return c;
  findings.push(conflictFinding(guard, {
    field: 'successCriteria', criterionId: c.id, criterionDescription: c.description, criterionOrigin: c.origin || null, checkType: (c.verification || {}).type || null,
    modelValue: foreign[0], modelValues: foreign,
    resolution: `Kritérium z modelu nahrazeno kontrolou výsledku nástroje (${guard.toolValue}); čísla z modelu (${foreign.join(', ')}) se do kontraktu nedostala.`,
  }));
  return {
    id: c.id, mandatory: c.mandatory !== false, origin: 'tool_override',
    description: `Číselný výsledek odpovídá výsledku nástroje ${guard.plan.input} = ${guard.toolValue}.`,
    verification: { kind: 'deterministic', type: 'number_equals', params: { expected: guard.toolValue, tolerance: 1e-6 } },
  };
}

/** Textové pole kontraktu (jde do promptu): cizí čísla se přepíší na hodnotu nástroje, rozpor → nález. */
function guardText(text, guard, field, findings) {
  if (!guard || !text) return text;
  const r = replaceNumbers(text, guard.foreign, guard.toolValue);
  if (!r.replaced.length) return text;
  const vals = [...new Set(r.replaced)];
  findings.push(conflictFinding(guard, { field, modelValue: vals[0], modelValues: vals, resolution: `Čísla z modelu (${vals.join(', ')}) v poli „${field}“ přepsána na výsledek nástroje (${guard.toolValue}).` }));
  return r.text;
}

/** Seznam (omezení, předpoklady, ne-cíle): položka s cizím číslem se vyřadí — přepis počtů („max 5 vět“) by byl nesmysl. */
function guardList(items, guard, field, findings) {
  if (!guard) return items;
  const kept = [];
  const dropped = [];
  for (const it of items || []) (numbers(it).some(guard.foreign) ? dropped : kept).push(it);
  if (dropped.length) {
    const vals = [...new Set(dropped.flatMap((it) => numbers(it).filter(guard.foreign)))];
    findings.push(conflictFinding(guard, { field, modelValue: vals[0], modelValues: vals, removedItems: dropped.length, resolution: `Položky pole „${field}“ s čísly z modelu (${vals.join(', ')}) vyřazeny (${dropped.length}).` }));
  }
  return kept;
}

function guardComponents(comp, guard, findings) {
  if (!guard || !comp) return comp;
  const out = { ...comp };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string') out[k] = guardText(out[k], guard, `components.${k}`, findings);
    else if (Array.isArray(out[k])) out[k] = out[k].map((x) => (typeof x === 'string' ? guardText(x, guard, `components.${k}`, findings) : x));
  }
  return out;
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
  // Veto nástroje (hodnotitel 1.3.0): čísla z modelu, která nejsou výsledkem, mezivýsledkem ani v zadání, se do
  // kontraktu nedostanou — v žádném kritériu ani textu, který jde do Execution Contract.
  const guard = numberGuard(plan, [prompt, explicitGoal && explicitGoal.text, ...(clarifications || []).map((x) => x.answer)]);
  const findings = [];
  const statement = guardText(b.statement, guard, 'statement', findings);
  const components = guardComponents(b.components, guard, findings);
  const criteria = [
    ...b.criteria.map((c) => vetoCriterion(clone(c), guard, findings)),
    ...toolCriteria(plan),
    goalCriterion(statement),
    ...systemCriteria(expectedFormat, gate0.systemFacts.blockedOperations.map((o) => ({ ...o, literalSupport: o.literalSupport !== false }))),
  ];
  // jedinečná ID kritérií
  const seen = new Set();
  for (const c of criteria) { let id = c.id; let k = 2; while (seen.has(id)) id = `${c.id}-${k++}`; c.id = id; seen.add(id); }

  const blocked = gate0.systemFacts.blockedOperations.map((o) => ({ operation: o.operation, category: o.category, literalSupport: o.literalSupport !== false }));
  const unavailable = gate0.systemFacts.unavailableCapabilities;
  const constraints = uniq([
    ...guardList(audit.constraints || [], guard, 'constraints', findings),
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
    statement,
    components,
    componentsSource: b.componentsSource,
    origin: {
      basis: branch.basis,
      promptSha256: sha256(prompt),
      clarificationsSha256: clarifications && clarifications.length ? sha256(canonicalJson(clarifications)) : null,
      explicitGoal: explicitGoal.text ? { text: explicitGoal.text, source: explicitGoal.source } : null,
      h1Statement: gate0.h1Goal.statement,
      auditStatement: audit.statement,
    },
    expectedOutput: { format: expectedFormat, description: guardText(audit.expectedOutput.description, guard, 'expectedOutput.description', findings) },
    scope: guardText(audit.scope || '', guard, 'scope', findings),
    nonGoals: guardList(uniq(audit.nonGoals), guard, 'nonGoals', findings),
    constraints,
    successCriteria: criteria,
    assumptions: guardList(uniq([...(audit.assumptions || []), ...gate0.aspects.flatMap((a) => a.assumptions || [])], 12), guard, 'assumptions', findings),
    blockedOperations: blocked,
    unavailableCapabilities: unavailable,
    toolPlan: plan,
    // Nálezy kontraktu (stav „proposed“): např. rozpor kritéria z modelu s výsledkem nástroje (veto nástroje).
    findings,
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

module.exports = { buildContracts, reviseContract, verifyContractHash, hashContract, numberGuard, criterionForeignNumbers, SCHEMA_VERSION };
