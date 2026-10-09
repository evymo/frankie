'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeVerdict, verify, repairDecision } = require('../src/core/verifier');
const { runDeterministic, normalizeCriterion } = require('../src/core/criteria');
const { testConfig } = require('./helpers');

const R = (result, mandatory = true) => ({ result, mandatory });

test('Verdikt: PASS jen když jsou prokázána všechna povinná kritéria', () => {
  assert.equal(computeVerdict([R('PASS'), R('PASS'), R('FAIL', false)]).verdict, 'PASS');
  assert.equal(computeVerdict([R('PASS'), R('UNVERIFIED')]).verdict, 'UNVERIFIED');
  assert.equal(computeVerdict([R('PASS'), R('FAIL')]).verdict, 'PARTIAL');
  assert.equal(computeVerdict([R('FAIL'), R('UNVERIFIED')]).verdict, 'FAIL');
  assert.equal(computeVerdict([R('FAIL')]).verdict, 'FAIL');
  assert.equal(computeVerdict([R('PASS', false)]).verdict, 'UNVERIFIED'); // žádné povinné = nic neprokázáno
});

const ctx = { contract: { blockedOperations: [] }, config: testConfig() };
const crit = (type, params = {}) => ({ verification: { kind: 'deterministic', type, params } });

test('Deterministické kontroly: number_equals, json_valid, json_equals, json_schema, max_words, contains, regex', async () => {
  assert.equal((await runDeterministic(crit('number_equals', { expected: 198 }), { output: 'Výsledek: 198' }, ctx)).result, 'PASS');
  assert.equal((await runDeterministic(crit('number_equals', { expected: 198 }), { output: 'Výsledek: 199' }, ctx)).result, 'FAIL');
  assert.equal((await runDeterministic(crit('json_valid'), { output: '```json\n[{"a":1}]\n```' }, ctx)).result, 'PASS');
  assert.equal((await runDeterministic(crit('json_valid'), { output: 'není json' }, ctx)).result, 'FAIL');
  assert.equal((await runDeterministic(crit('json_equals', { expected: [{ a: 1 }] }), { output: '[{"a":1}]' }, ctx)).result, 'PASS');
  assert.equal((await runDeterministic(crit('json_equals', { expected: [{ a: 1 }] }), { output: '[{"a":2}]' }, ctx)).result, 'FAIL');
  assert.equal((await runDeterministic(crit('json_schema', { schema: { type: 'array', items: { type: 'object', required: ['a'] } } }), { output: '[{"b":1}]' }, ctx)).result, 'FAIL');
  assert.equal((await runDeterministic(crit('max_words', { n: 3 }), { output: 'jedna dvě tři čtyři' }, ctx)).result, 'FAIL');
  assert.equal((await runDeterministic(crit('contains', { text: 'Praha' }), { output: 'hlavní město praha' }, ctx)).result, 'PASS');
  assert.equal((await runDeterministic(crit('regex', { pattern: '^\\d+$' }), { output: '42' }, ctx)).result, 'PASS');
});

test('Deterministická kontrola json_rows_subset: řádky jen z převodu, žádný dvakrát, aspoň jeden', async () => {
  const rows = { expected: [{ jmeno: 'Ana', vek: 25 }, { jmeno: 'Bob', vek: 40 }, { jmeno: 'Bob', vek: 40 }] };
  const r = async (output) => (await runDeterministic(crit('json_rows_subset', rows), { output }, ctx)).result;
  assert.equal(await r('[{"vek":40,"jmeno":"Bob"}]'), 'PASS', 'pořadí klíčů nevadí');
  assert.equal(await r('[{"jmeno":"Bob","vek":40},{"jmeno":"Bob","vek":40}]'), 'PASS', 'duplicitní řádek, který je v převodu dvakrát');
  assert.equal(await r('[{"jmeno":"Ana","vek":25},{"jmeno":"Ana","vek":25}]'), 'FAIL', 'řádek použitý víckrát, než je v převodu');
  assert.equal(await r('[{"jmeno":"Ana","vek":"25"}]'), 'FAIL', 'jiný typ hodnoty (jako json_equals)');
  assert.equal(await r('[{"jmeno":"Eva","vek":30}]'), 'FAIL', 'vymyšlený řádek');
  assert.equal(await r('[]'), 'FAIL', 'prázdné pole');
  assert.equal(await r('{"jmeno":"Ana","vek":25}'), 'FAIL', 'objekt místo pole');
  assert.equal(await r('není json'), 'FAIL');
});

test('Testy kódu v sandboxu: správný kód PASS, chybný FAIL', async () => {
  const p = { functionName: 'add', cases: [{ args: [1, 2], expected: 3 }, { args: [0, 0], expected: 0 }] };
  const good = await runDeterministic(crit('js_function_tests', p), { output: '', artifacts: [{ name: 'a.js', type: 'code', language: 'javascript', content: 'function add(a,b){return a+b}' }] }, ctx);
  assert.equal(good.result, 'PASS', good.evidence);
  const bad = await runDeterministic(crit('js_function_tests', p), { output: '```js\nfunction add(a,b){return a-b}\n```', artifacts: [] }, ctx);
  assert.equal(bad.result, 'FAIL');
});

test('SYS-2: tvrzení o provedení blokované operace je FAIL', async () => {
  const c = { contract: { blockedOperations: [{ operation: 'odeslání zprávy / komunikace navenek: „pošli“', category: 'external_communication' }] }, config: testConfig() };
  assert.equal((await runDeterministic(crit('no_blocked_claims'), { output: 'Výsledek je 144. E-mail byl odeslán.' }, c)).result, 'FAIL');
  assert.equal((await runDeterministic(crit('no_blocked_claims'), { output: 'Výsledek je 144. E-mail nebyl odeslán — operace je blokovaná.' }, c)).result, 'PASS');
  assert.equal((await runDeterministic(crit('no_blocked_claims'), { output: 'Výsledek je 144. Neodeslal jsem nic.' }, c)).result, 'PASS');
  assert.equal((await runDeterministic(crit('blocked_scope'), { output: 'x' }, c)).result, 'FAIL');
});

test('Neplatná deterministická kontrola se převede na sémantickou (s evidencí důvodu)', () => {
  const n = normalizeCriterion({ description: 'x', mandatory: true, check: { type: 'number_equals', params: { expected: 'abc' } } }, 'AC-1', 'audit_model');
  assert.equal(n.verification.kind, 'semantic');
  assert.match(n.downgraded, /expected/);
  const u = normalizeCriterion({ description: 'x', mandatory: true, check: { type: 'eval_code' } }, 'AC-2', 'audit_model');
  assert.equal(u.verification.kind, 'semantic');
});

test('Sémantický hodnotitel: PASS bez citace z výstupu je snížen na UNVERIFIED; nevidí poznámky executoru', async () => {
  const contract = { id: 'GC', version: 1, statement: 'cíl', blockedOperations: [], successCriteria: [
    { id: 'S1', description: 'věrné shrnutí', mandatory: true, verification: { kind: 'semantic', type: 'semantic', params: {} }, origin: 'audit_model' },
    { id: 'S2', description: 'srozumitelné', mandatory: true, verification: { kind: 'semantic', type: 'semantic', params: {} }, origin: 'audit_model' },
  ] };
  let seenInput = null;
  const callModel = async (req) => { seenInput = req.input; return { ok: true, callId: 'C1', simulated: false, data: { results: [
    { criterionId: 'S1', result: 'PASS', evidence: 'Praha leží na Vltavě', deviation: '' },
    { criterionId: 'S2', result: 'PASS', evidence: 'citace, která ve výstupu není', deviation: '' },
  ] } }; };
  const v = await verify({ contract, execution: { status: 'completed', output: 'Praha leží na Vltavě.', artifacts: [], notes: 'TAJNÉ UVAŽOVÁNÍ' }, callModel, config: testConfig(), canCallModel: () => true });
  assert.equal(v.criteria[0].result, 'PASS');
  assert.equal(v.criteria[1].result, 'UNVERIFIED');
  assert.equal(v.criteria[1].downgradedFrom, 'PASS');
  assert.equal(v.verdict, 'UNVERIFIED');
  assert.ok(!JSON.stringify(seenInput).includes('TAJNÉ UVAŽOVÁNÍ'));
});

test('Citace hodnotitele: komentář s citacemi v uvozovkách je doložitelný jen pokud jsou VŠECHNY citace ve výstupu', () => {
  const { evidenceSupported } = require('../src/core/verifier');
  const out = 'Praha je hlavní město České republiky na Vltavě. Je na seznamu UNESCO.';
  assert.equal(evidenceSupported('Praha je hlavní město', out).ok, true);
  assert.equal(evidenceSupported('Výstup obsahuje „hlavní město České republiky“ a „seznamu UNESCO“.', out).ok, true);
  const bad = evidenceSupported('Výstup obsahuje „hlavní město“ a „1,3 milionu obyvatel“.', out);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['1,3 milionu obyvatel']);
  assert.equal(evidenceSupported('Shrnutí je věrné a úplné.', out).ok, false);
});

test('Sémantický hodnotitel dostává původní zadání (pro posouzení věrnosti)', async () => {
  const contract = { id: 'GC', version: 1, statement: 'c', blockedOperations: [], successCriteria: [{ id: 'S1', description: 'věrné', mandatory: true, verification: { kind: 'semantic', type: 'semantic', params: {} } }] };
  let seen = '';
  const callModel = async (req) => { seen = req.prompt; return { ok: true, callId: 'C1', simulated: true, data: { results: [{ criterionId: 'S1', result: 'PASS', evidence: 'x y z', deviation: '' }] } }; };
  await verify({ contract, execution: { status: 'completed', output: 'x y z', artifacts: [] }, callModel, config: testConfig(), canCallModel: () => true, prompt: 'PŮVODNÍ TEXT K SHRNUTÍ' });
  assert.match(seen, /<<<PUVODNI_ZADANI_[0-9a-f]+\nPŮVODNÍ TEXT K SHRNUTÍ\n/);
});

test('Simulované sémantické hodnocení (mock) nikdy nevytvoří PASS', async () => {
  const contract = { id: 'GC', version: 1, statement: 'c', blockedOperations: [], successCriteria: [{ id: 'S1', description: 'x', mandatory: true, verification: { kind: 'semantic', type: 'semantic', params: {} } }] };
  const callModel = async () => ({ ok: true, callId: 'C1', simulated: true, data: { results: [{ criterionId: 'S1', result: 'PASS', evidence: 'abc', deviation: '' }] } });
  const v = await verify({ contract, execution: { status: 'completed', output: 'abc', artifacts: [] }, callModel, config: testConfig(), canCallModel: () => true });
  assert.equal(v.criteria[0].result, 'UNVERIFIED');
  assert.equal(v.criteria[0].downgradedFrom, 'PASS');
  assert.equal(v.verdict, 'UNVERIFIED');
});

test('Sémantická kritéria bez dostupného volání (limit) zůstávají UNVERIFIED', async () => {
  const contract = { id: 'GC', version: 1, statement: 'c', blockedOperations: [], successCriteria: [{ id: 'S1', description: 'x', mandatory: true, verification: { kind: 'semantic', type: 'semantic', params: {} } }] };
  const v = await verify({ contract, execution: { status: 'completed', output: 'x', artifacts: [] }, callModel: async () => { throw new Error('nemá být voláno'); }, config: testConfig(), canCallModel: () => false });
  assert.equal(v.criteria[0].result, 'UNVERIFIED');
  assert.equal(v.verdict, 'UNVERIFIED');
});

test('Oprava: max. jeden průchod; ne při blokaci, SYS-2, PASS, UNVERIFIED nebo překročení limitu', () => {
  const contract = { successCriteria: [{ id: 'A', verification: { kind: 'deterministic' } }, { id: 'SYS-4', repairable: false, verification: { kind: 'deterministic' } }] };
  const ver = (verdict, failed = ['A']) => ({ verdict, criteria: failed.map((id) => ({ criterionId: id, result: 'FAIL' })) });
  const ex = { status: 'completed' };
  assert.equal(repairDecision({ verification: ver('FAIL'), execution: ex, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 5 }).repair, true);
  assert.equal(repairDecision({ verification: ver('FAIL'), execution: ex, contract, repairsUsed: 1, maxRepairs: 1, callsRemaining: 5 }).repair, false);
  assert.equal(repairDecision({ verification: ver('FAIL'), execution: ex, contract, repairsUsed: 1, maxRepairs: 5, callsRemaining: 5 }).repair, false, 'tvrdý strop 1 i při chybné konfiguraci');
  assert.equal(repairDecision({ verification: ver('PASS', []), execution: ex, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 5 }).repair, false);
  assert.equal(repairDecision({ verification: ver('UNVERIFIED', []), execution: ex, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 5 }).repair, false);
  assert.equal(repairDecision({ verification: ver('FAIL'), execution: { status: 'blocked' }, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 5 }).repair, false);
  assert.equal(repairDecision({ verification: ver('FAIL', ['SYS-2']), execution: ex, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 5 }).repair, false);
  assert.equal(repairDecision({ verification: ver('PARTIAL', ['SYS-4']), execution: ex, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 5 }).repair, false);
  assert.equal(repairDecision({ verification: ver('FAIL'), execution: ex, contract, repairsUsed: 0, maxRepairs: 1, callsRemaining: 0 }).repair, false);
});
