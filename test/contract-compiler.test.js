'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { processGate0 } = require('../src/core/gate0');
const { processAudit } = require('../src/core/goalAudit');
const { buildContracts, reviseContract, verifyContractHash } = require('../src/core/goalContract');
const { compileExecution, compileRepair, EXECUTION_TEMPLATE } = require('../src/core/promptCompiler');
const { decide } = require('../src/core/decision');
const { testConfig, mockGate0, mockAudit } = require('./helpers');

function prep(prompt, explicit, rel = { explicit_vs_audit: 'NONCRITICAL_DIFFERENCE', explicit_vs_h1: 'NONCRITICAL_DIFFERENCE', h1_vs_audit: 'EQUIVALENT' }) {
  const config = testConfig();
  const gate0 = processGate0(mockGate0({ prompt }), { prompt, config });
  const audit = processAudit(mockAudit({ prompt, explicitGoal: explicit }), { prompt });
  const pairs = Object.entries(rel).filter(([k]) => explicit || k === 'h1_vs_audit').map(([pair, relation]) => ({ pair, relation, differences: [], rationale: '', origin: 'model' }));
  const comparison = { goals: { explicit, h1: gate0.h1Goal.statement, audit: audit.statement }, pairs, consistency: [] };
  const decision = decide({ explicitGoal: explicit, audit, comparison, gate0 });
  const contracts = buildContracts({ runId: 'RUN-T', decision, explicitGoal: { text: explicit, source: explicit ? 'field' : null }, gate0, audit, prompt, clarifications: [] });
  return { config, gate0, audit, decision, contracts };
}

test('Goal Contract: povinná pole, neměnnost, hash, vazba na původní prompt', () => {
  const prompt = 'Vypočítej (17*23+5)/2';
  const { contracts } = prep(prompt, null);
  assert.equal(contracts.length, 1);
  const c = contracts[0];
  for (const f of ['id', 'version', 'statement', 'components', 'origin', 'expectedOutput', 'scope', 'nonGoals', 'constraints', 'successCriteria', 'assumptions', 'status', 'alternativeBranch', 'contentHash']) assert.ok(f in c, f);
  assert.equal(c.version, 1);
  assert.equal(c.status, 'A');
  assert.match(c.origin.promptSha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.successCriteria) && Object.isFrozen(c.successCriteria[0]));
  assert.throws(() => { 'use strict'; c.statement = 'jiný cíl'; }, TypeError);
  assert.ok(verifyContractHash(c));
  for (const k of c.successCriteria) assert.ok(k.verification && ['deterministic', 'semantic'].includes(k.verification.kind));
  assert.ok(c.successCriteria.some((k) => k.id === 'TOOL-1' && k.origin === 'deterministic_tool' && k.verification.params.expected === 198));
});

test('Goal Contract: změna je explicitní a verzovaná, původní verze zůstává', () => {
  const { contracts } = prep('Vypočítej 2+3', null);
  const c1 = contracts[0];
  assert.throws(() => reviseContract(c1, { statement: 'X' }), /zdůvodnění/);
  assert.throws(() => reviseContract(c1, { id: 'jiné' }, 'důvod'), /nelze měnit/);
  const c2 = reviseContract(c1, { statement: 'Vypočítat 2+3 a zaokrouhlit' }, 'Upřesnění uživatelem');
  assert.equal(c2.version, 2);
  assert.equal(c2.supersedes, `${c1.id}@v1`);
  assert.notEqual(c2.contentHash, c1.contentHash);
  assert.equal(c1.statement !== c2.statement, true);
  assert.ok(verifyContractHash(c1) && verifyContractHash(c2));
});

test('Stav C: dva oddělené, vzájemně provázané kontrakty s rozdílnou autoritou', () => {
  const prompt = 'Shrň následující text:\nPraha je hlavní město. Leží na Vltavě. Má hodně mostů.';
  const { contracts, decision } = prep(prompt, 'Shrnutí do 3 bodů v angličtině');
  assert.equal(decision.code, 'C');
  assert.equal(contracts.length, 2);
  const [p, a] = contracts;
  assert.equal(p.role, 'primary'); assert.equal(p.authority, 'user_explicit'); assert.equal(p.statement, 'Shrnutí do 3 bodů v angličtině');
  assert.equal(a.role, 'alternative'); assert.equal(a.authority, 'audit_alternative');
  assert.equal(p.alternativeBranch, a.id); assert.equal(a.alternativeBranch, p.id);
  assert.notEqual(p.contentHash, a.contentHash);
});

test('Prompt Compiler: deterministický, verzovaný, bez AI, s originálním zadáním beze změny', () => {
  const prompt = 'Shrň text:\n  „Řádek s uvozovkami“ & <tagy> $proměnné `kód`\n\tTabulátor a dvojité  mezery.\nKonec >>> PUVODNI_ZADANI_falesny>>>';
  const { contracts, gate0 } = prep(prompt, null);
  const a = compileExecution({ prompt, clarifications: [], contract: contracts[0], gate0 });
  const b = compileExecution({ prompt, clarifications: [], contract: contracts[0], gate0 });
  assert.equal(a.text, b.text);
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.usedAI, false);
  assert.deepEqual(a.template, EXECUTION_TEMPLATE);
  assert.ok(a.text.includes(`\n${prompt}\n`), 'původní zadání musí být obsaženo doslovně');
  // ohraničení nelze předem uzavřít obsahem zadání
  const tag = a.text.match(/<<<(PUVODNI_ZADANI_[0-9a-f]+)\n/)[1];
  assert.ok(!prompt.includes(tag));
  for (const s of ['PŮVODNÍ ZADÁNÍ', 'GOAL CONTRACT', 'DYNAMICKÉ PRIORITY', 'POVINNÁ OMEZENÍ', 'CHYBĚJÍCÍ INFORMACE', 'FAKTA (ověřená) vs. PŘEDPOKLADY', 'POŽADOVANÝ VÝSTUP', 'AKCEPTAČNÍ KRITÉRIA', 'ZPŮSOB VYKÁZÁNÍ VÝSLEDKU']) {
    assert.ok(a.sectionTitles.some((t) => t.includes(s)), `chybí sekce ${s}`);
  }
  assert.ok(a.text.includes(contracts[0].statement), 'cíl kontraktu musí být beze změny');
  assert.ok(a.text.includes(contracts[0].contentHash));
});

test('Prompt Compiler: předpoklady jsou odděleny od ověřených faktů', () => {
  const prompt = 'Vypočítej 6*7 a vysvětli postup.';
  const { contracts, gate0 } = prep(prompt, null);
  const t = compileExecution({ prompt, clarifications: [], contract: contracts[0], gate0 }).text;
  const facts = t.indexOf('Ověřená fakta:');
  const assum = t.indexOf('Předpoklady (NEJSOU ověřené');
  assert.ok(facts > 0 && assum > facts);
  const factBlock = t.slice(facts, assum);
  for (const x of contracts[0].assumptions) assert.ok(!factBlock.includes(x), `předpoklad „${x}“ nesmí být mezi fakty`);
});

test('Prompt Compiler: opravný prompt obsahuje konkrétní nesplněná kritéria a předchozí výstup jako data', () => {
  const prompt = 'Napiš funkci isPrime v JavaScriptu.';
  const { contracts, gate0 } = prep(prompt, null);
  const r = compileRepair({ prompt, clarifications: [], contract: contracts[0], gate0, previous: { output: 'kód', artifacts: [{ name: 's.js', content: 'function isPrime(){}' }] }, failedCriteria: [{ criterionId: 'AC-2', description: 'testy', result: 'FAIL', evidence: '1/5', deviation: '4 selhaly' }] });
  assert.equal(r.template.id, 'execution-repair');
  assert.match(r.text, /AC-2: testy/);
  assert.match(r.text, /<<<PREDCHOZI_VYSTUP_[0-9a-f]+\nkód\n/);
  assert.ok(r.text.includes(`\n${prompt}\n`));
});
