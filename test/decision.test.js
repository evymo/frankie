'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, RULES } = require('../src/core/decision');
const { planComparison, mergeComparison } = require('../src/core/goalAudit');

const gate0 = { aspects: [{ id: 'H4', missingInfo: [{ item: 'Formát výstupu', critical: true }] }], h1Goal: { statement: 'H1 cíl' } };

function comparison(rel) {
  const pairs = Object.entries(rel).map(([pair, relation]) => ({ pair, relation, differences: relation === 'CRITICAL_CONFLICT' ? [{ description: 'jiný typ výsledku', critical: true }] : [], rationale: '', origin: 'model' }));
  return { goals: { explicit: 'E', h1: 'H1 cíl', audit: 'Auditovaný cíl' }, pairs, consistency: [] };
}
const audit = (o = {}) => ({ derivable: true, confidence: 'high', statement: 'Auditovaný cíl', uncertainties: [], ...o });

test('A1: cíl nebyl zadán, je odvoditelný → jeden odvozený kontrakt', () => {
  const d = decide({ explicitGoal: null, audit: audit(), comparison: comparison({ h1_vs_audit: 'EQUIVALENT' }), gate0 });
  assert.equal(d.code, 'A'); assert.equal(d.rule, 'A1'); assert.equal(d.proceed, true);
  assert.deepEqual(d.branches.map((b) => b.basis), ['audit']);
});

test('A1: nekritický rozdíl H1↔audit stále umožní pokračovat', () => {
  const d = decide({ explicitGoal: null, audit: audit(), comparison: comparison({ h1_vs_audit: 'NONCRITICAL_DIFFERENCE' }), gate0 });
  assert.equal(d.rule, 'A1');
});

test('A2: neodvoditelný cíl → STOP / CLARIFICATION s konkrétní otázkou', () => {
  for (const a of [audit({ derivable: false, uncertainties: ['Není jasné, o jaký text jde'] }), audit({ confidence: 'low' })]) {
    const d = decide({ explicitGoal: null, audit: a, comparison: comparison({ h1_vs_audit: 'EQUIVALENT' }), gate0 });
    assert.equal(d.code, 'A'); assert.equal(d.rule, 'A2'); assert.equal(d.proceed, false);
    assert.equal(d.outcome, 'CLARIFICATION_REQUIRED');
    assert.match(d.question, /nelze spolehlivě odvodit/);
    assert.match(d.question, /Formát výstupu/);
  }
});

test('A3: H1 a audit v kritickém rozporu → D', () => {
  const d = decide({ explicitGoal: null, audit: audit(), comparison: comparison({ h1_vs_audit: 'CRITICAL_CONFLICT' }), gate0 });
  assert.equal(d.code, 'D'); assert.equal(d.rule, 'A3'); assert.equal(d.proceed, false);
});

test('B1: explicitní cíl významově shodný s auditem i H1 → jeden sjednocený kontrakt', () => {
  const d = decide({ explicitGoal: 'E', audit: audit(), comparison: comparison({ explicit_vs_audit: 'EQUIVALENT', explicit_vs_h1: 'EQUIVALENT', h1_vs_audit: 'EQUIVALENT' }), gate0 });
  assert.equal(d.code, 'B'); assert.equal(d.branches.length, 1); assert.equal(d.branches[0].authority, 'user_explicit');
});

test('C1: nekritický rozdíl → dvě větve, explicitní cíl má vyšší autoritu', () => {
  const d = decide({ explicitGoal: 'E', audit: audit(), comparison: comparison({ explicit_vs_audit: 'NONCRITICAL_DIFFERENCE', explicit_vs_h1: 'EQUIVALENT', h1_vs_audit: 'NONCRITICAL_DIFFERENCE' }), gate0 });
  assert.equal(d.code, 'C');
  assert.deepEqual(d.branches.map((b) => [b.role, b.basis, b.authority]), [['primary', 'explicit', 'user_explicit'], ['alternative', 'audit', 'audit_alternative']]);
});

test('C1: když se liší jen H1, alternativou je H1', () => {
  const d = decide({ explicitGoal: 'E', audit: audit(), comparison: comparison({ explicit_vs_audit: 'EQUIVALENT', explicit_vs_h1: 'NONCRITICAL_DIFFERENCE', h1_vs_audit: 'NONCRITICAL_DIFFERENCE' }), gate0 });
  assert.equal(d.code, 'C'); assert.equal(d.branches[1].basis, 'h1');
});

test('D1: kritický nebo nejasný rozpor → STOP s otázkou zaměřenou na rozpor', () => {
  for (const rel of ['CRITICAL_CONFLICT', 'UNCLEAR']) {
    const d = decide({ explicitGoal: 'Přeložit do němčiny', audit: audit(), comparison: comparison({ explicit_vs_audit: rel, explicit_vs_h1: 'EQUIVALENT', h1_vs_audit: 'EQUIVALENT' }), gate0 });
    assert.equal(d.code, 'D'); assert.equal(d.proceed, false);
    assert.match(d.question, /Přeložit do němčiny/);
    assert.match(d.question, /Auditovaný cíl/);
  }
});

test('Rozhodovací tabulka je úplná a bez procentních prahů', () => {
  assert.deepEqual(RULES.map((r) => r.id), ['A1', 'A2', 'A3', 'D1', 'B1', 'C1']);
  assert.ok(!JSON.stringify(RULES).match(/%|0\.85|85/));
});

test('Porovnání: doslovná shoda = algoritmus; jinak model; kritický rozdíl vynutí CRITICAL', () => {
  const plan = planComparison({ explicitGoal: 'Spočítat  PRŮMĚR', h1Statement: 'spočítat průměr', auditStatement: 'Vypočítat aritmetický průměr' });
  assert.deepEqual(plan.algorithmic.map((p) => [p.pair, p.origin]), [['explicit_vs_h1', 'algorithm']]);
  assert.deepEqual(plan.forModel.map((p) => p.pair), ['explicit_vs_audit', 'h1_vs_audit']);
  const merged = mergeComparison(plan, { pairs: [
    { pair: 'explicit_vs_audit', relation: 'NONCRITICAL_DIFFERENCE', differences: [{ description: 'x', critical: true }], rationale: '' },
  ] });
  const ea = merged.pairs.find((p) => p.pair === 'explicit_vs_audit');
  assert.equal(ea.relation, 'CRITICAL_CONFLICT');
  assert.equal(ea.origin, 'model+algorithm_consistency');
  const ha = merged.pairs.find((p) => p.pair === 'h1_vs_audit');
  assert.equal(ha.relation, 'UNCLEAR'); // model dvojici nevrátil
  assert.equal(ha.origin, 'algorithm_fallback');
});
