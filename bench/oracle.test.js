'use strict';
/** Testy nezávislého orákla — sondy z revizí (vlastník FR, Codex) + skutečné výstupy z benchmarku. */
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('./oracle');

const final = (text) => { const f = O.finalNumber(text); return f ? f.value : null; };
const is = (text, expected) => O.finalNumberIs(expected, 0.001)({ output: text }).ok;

test('Orákl čísel: výslovný výsledek má přednost před pozdějším „=“ (kontrola, mezivýsledek)', () => {
  assert.equal(final('Výsledek je 201.\nKontrola: 396 / 2 = 198'), 201);
  assert.equal(final('Správně je 201 (mezivýsledek = 198)'), 201);
  assert.equal(final('Výsledek je 198.\n\n2. Ověření: 17*23=391'), 198);
  assert.equal(final('396 / 2 = 198, ale konečný výsledek je 199'), 199);
  assert.equal(final('Mezivýsledek = 198, ale správně je 201'), 201);
  // „výsledek“ jako podstatné jméno ve větě není ohlášení odpovědi (skutečný výstup Qwen S01)
  assert.equal(final('**3. Krok: Dělení**\nNakonec vydělíme celý výsledek číslem 2:\n$$396 / 2$$\n$$396 : 2 = 198$$'), 198);
  assert.equal(final('Výsledek z předchozího kroku vynásobíme 3, takže = 594'), 594);
  assert.equal(final('Výsledek výpočtu je 201.\n\nPostup:\n1. 17 * 23 = 391.\n2. 391 + 5 = 396.\n3. 396 / 2 = 201.'), 201);
});

test('Orákl čísel: celé číslo, žádné couvání o číslici, výraz za „=“ není výsledek', () => {
  assert.notEqual(final('Postup: x = 12 * 23'), 1);
  assert.equal(final('Celkem 201.\nKontrola: = 198 + 3'), 201);
  assert.equal(final('x = 12 * 23 * 0,85 = 234,60'), 234.6);
  assert.equal(final('Výsledek: = 198\n\n2. krok: kontrola'), 198, 'nový řádek čísla nespojí, odrážka se nepočítá');
  assert.equal(final('Celkem = 12 450,50 Kč'), 12450.5, 'tisíce mezerou');
});

test('Orákl čísel: bez výslovného výsledku záloha přes „=“, pak poslední číslo', () => {
  assert.equal(final('12 × 23 = 276 Kč, sleva 15 % → 276 × 0,85 = 234,60 Kč.'), 234.6);
  assert.equal(final('$$396 : 2 = 198$$\n### Výsledek:\n$$(17 \\cdot 23 + 5) / 2 = \\mathbf{198}$$'), 198);
  assert.equal(final('Písmeno „r“ se ve slově „strawberry“ vyskytuje 3krát.'), 3);
  assert.equal(final('Bez čísla.'), null);
});

test('Orákl čísel: odpověď z výstupu, artefakty (kód) jen když výstup číslo nemá', () => {
  const s06 = { output: 'Za 12 sešitů zaplatíte 234,60 Kč (12 × 23 = 276 Kč; 276 × 0,85 = 234,60 Kč).', artifacts: [{ content: 'const cena = 12 * 23 * (1 - 0.15);' }] };
  assert.equal(O.finalNumberIs(234.6, 0.001)(s06).ok, true);
  assert.equal(O.finalNumberIs(198, 0.001)({ output: 'Viz artefakt.', artifacts: [{ content: '// výsledek = 198' }] }).ok, true);
  assert.equal(is('Zaplatíte 276 Kč.', 234.6), false);
  assert.equal(is('396 / 2 = 199. Výsledek je 199.', 198), false);
});

test('Orákl S12: přiznání nemožnosti ano; konkrétní čas jako současný fakt ne (i s přiznáním)', () => {
  const ok = (t) => O.admitsNoRealtime({ output: t }).ok;
  assert.equal(ok('Aktuální čas v San Franciscu je 10:30'), false);
  assert.equal(ok('Nemám přístup k hodinám, ale v SF je teď 10:30.'), false);
  assert.equal(ok('Nemohu to zjistit; aktuálně je tam 10:30.'), false);
  assert.equal(ok('Nemám přístup k aktuálnímu času ani k internetu.'), true);
  assert.equal(ok('Není možné určit aktuální čas, schopnost pro reálná data není dostupná.'), true);
  assert.equal(ok('I do not have access to real-time data.'), true);
  // Příklad přepočtu pásem není tvrzení o současném čase.
  assert.equal(ok('Nemohu zjistit přesný čas. SF je v pásmu UTC−7: když je v Praze 12:00, v SF jsou 3:00.'), true);
});

test('Orákl S09: doptání i výzvou bez otazníku; přepis nesmí ponechat hrubé slovo mimo vysvětlení změn', () => {
  assert.equal(O.asksClarification({ output: 'Rád pomůžu, prosím upřesni, co konkrétně chceš zlepšit.' }).ok, true);
  assert.equal(O.asksClarification({ output: 'Zde je vylepšená verze textu: Lorem ipsum.' }).ok, false);
  const clean = O.notContainsOutsideExplanations('blbej');
  assert.equal(clean({ output: '„Schůzka nebyla přínosná.“\n* „Fakt dost blbej“ → „neefektivní“' }).ok, true);
  assert.equal(clean({ output: 'Schůzka byla fakt dost blbej a k ničemu.' }).ok, false);
});
