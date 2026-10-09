'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate, findExpression } = require('../src/tools/arith');
const { csvToJson, findCsvBlock } = require('../src/tools/csv');
const { textStats } = require('../src/tools/textStats');
const { runFunctionTests, staticCheck } = require('../src/tools/jsSandbox');

test('arith_eval: přesný výpočet bez eval', () => {
  assert.equal(evaluate('(17*23+5)/2'), 198);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3 + 4 × 2'), 5);
  assert.equal(evaluate('1,5 * 2'), 3);
  assert.equal(evaluate('sqrt(16) + abs(-2)'), 6);
  assert.throws(() => evaluate('1/0'), /nulou/);
  assert.throws(() => evaluate('process.exit()'), /Nepovolený/);
  assert.equal(findExpression('Vypočítej (17*23+5)/2 prosím'), '(17*23+5)/2');
  assert.equal(findExpression('Rok 2024 a číslo 7'), null);
});

test('csv_to_json: hlavička, oddělovače, typy, uvozovky', () => {
  assert.deepEqual(csvToJson('a;b\n1;"x;y"\n2,5;true'), [{ a: 1, b: 'x;y' }, { a: 2.5, b: true }]);
  assert.throws(() => csvToJson('a,b\n1'), /počet buněk/);
  assert.equal(findCsvBlock('Převeď:\njmeno,vek\nAna,31\nPetr,45\nDěkuji.'), 'jmeno,vek\nAna,31\nPetr,45');
});

test('text_stats', () => {
  const s = textStats('Praha je město. Praha leží na Vltavě!');
  assert.equal(s.words, 7);
  assert.equal(s.sentences, 2);
  assert.equal(s.topWords[0].word, 'praha');
});

test('Sandbox: statická kontrola zakázaných konstrukcí', () => {
  assert.equal(staticCheck('require("fs")').ok, false);
  assert.equal(staticCheck('process.exit(1)').ok, false);
  assert.equal(staticCheck('fetch("http://x")').ok, false);
  assert.equal(staticCheck('// process the list\nfunction f(){return 1}').ok, true);
});

test('Sandbox: nekonečná smyčka je ukončena časovým limitem', async () => {
  const r = await runFunctionTests({ code: 'function f(){ while(true){} }', functionName: 'f', cases: [{ args: [], expected: 1 }], timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
});

test('Sandbox: kód nemá přístup k process/require ani přes this', async () => {
  const code = 'function f(){ try { return typeof (function(){ return this; })() } catch(e) { return "err" } }';
  const r = await runFunctionTests({ code, functionName: 'f', cases: [{ args: [], expected: 'undefined' }] });
  assert.equal(r.passed, 1, JSON.stringify(r));
});
