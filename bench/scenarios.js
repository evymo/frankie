'use strict';
/**
 * Testovací scénáře FR vs. samostatný dotaz na model.
 *
 * Skupiny:
 *  good        — úloha s jednoznačně správnou odpovědí; čekáme PASS u FR i dobrý výsledek modelu.
 *  trap        — úlohy, kde modely často chybují (počítání znaků, procenta, okrajové případy, striktní formát, čeština).
 *  alternative — rozhodovací větve FR: A2 (neodvoditelné → STOP), B1 (explicitní cíl sedí), D1/C1 (rozpor cílů),
 *                poctivost u nedostupných dat.
 *  learning    — řízená chyba: první exekuci podvrhneme známou chybou; měříme, zda ji FR odhalí a skutečný model
 *                ji v opravném průchodu podle zpětné vazby opraví (princip učení v rámci běhu).
 *
 * expect.decisions — přijatelná rozhodnutí FR; expect.stop — FR se má zastavit s otázkou.
 * oracle — nezávislá kontrola správnosti (ne kritéria FR); rawOracle — jiná kontrola pro čistý dotaz.
 */
const O = require('./oracle');

const ISPRIME_CASES = [
  { args: [0], expected: false }, { args: [1], expected: false }, { args: [2], expected: true }, { args: [3], expected: true },
  { args: [4], expected: false }, { args: [17], expected: true }, { args: [25], expected: false }, { args: [97], expected: true },
  { args: [7919], expected: true }, { args: [-7], expected: false }, { args: [1.5], expected: false }, { args: [1000003], expected: true },
];

const DURATION_CASES = [
  { args: ['1h30m'], expected: 5400 }, { args: ['45s'], expected: 45 }, { args: ['2h5s'], expected: 7205 },
  { args: ['10m'], expected: 600 }, { args: ['1h2m3s'], expected: 3723 }, { args: ['1h'], expected: 3600 },
  { args: [''], expected: null }, { args: ['abc'], expected: null }, { args: ['5x'], expected: null },
];

const COMPANY_TEXT = 'Společnost Vltava Robotics byla založena v roce 2014 v Brně dvojicí inženýrů z VUT. Firma se zaměřuje na autonomní skladové roboty, které dokážou samostatně vychystávat objednávky bez pevně instalovaných kolejnic. V současnosti zaměstnává 85 lidí, z toho většinu tvoří vývojáři a technici. Její roboty používá přes třicet logistických center v pěti zemích střední Evropy. V loňském roce firma získala investici ve výši 120 milionů korun od skupiny regionálních investorů a plánuje otevřít druhou pobočku ve Vídni. Zakladatelé zdůrazňují, že klíčem k úspěchu je rychlá iterace prototypů a úzká spolupráce se zákazníky, kteří se podílejí na testování každé nové verze softwaru.';

const MATH_PROMPT = 'Vypočítej (17*23+5)/2 a vysvětli postup.';
const ISPRIME_PROMPT = 'Napiš v JavaScriptu funkci isPrime(n), která vrátí true, pokud je n prvočíslo, jinak false. Pro necelá čísla, čísla menší než 2 a záporná čísla vrať false.';
const SUMMARY_PROMPT = `Shrň následující text česky maximálně 40 slovy. Shrnutí musí zachovat rok založení, sídlo firmy a počet zaměstnanců.\n\n${COMPANY_TEXT}`;
const TRANSLATE_PROMPT = 'Přelož do angličtiny: „Dobré ráno, jak se máte?“';

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(typeof v[k] === 'string' ? v[k].trim() : v[k])])) : v);

/** Podvržený výsledek první exekuce (schéma EXECUTION). */
function injected(output, artifacts = [], outputFormat = 'text') {
  return { status: 'completed', output, outputFormat, artifacts, completedOperations: ['generate'], blockedOperations: [], assumptionsUsed: [], criteriaSelfReport: [], notes: '' };
}

const SCENARIOS = [
  // ── good ──────────────────────────────────────────────────────────────────────────────
  { id: 'S01', group: 'good', title: 'Výpočet s vysvětlením', prompt: MATH_PROMPT,
    expect: { decisions: ['A1'] }, oracle: O.finalNumberIs(198) },
  { id: 'S02', group: 'good', title: 'Program isPrime (12 referenčních testů)', prompt: ISPRIME_PROMPT,
    expect: { decisions: ['A1'] }, oracle: O.jsTests('isPrime', ISPRIME_CASES) },
  { id: 'S03', group: 'good', title: 'CSV → JSON (deterministický nástroj FR)',
    prompt: 'Převeď následující CSV na JSON pole objektů; číselné hodnoty jako čísla:\n\nname,age,city\nAnna,31,Praha\nBořek,45,Brno\nCyril,27,Ostrava',
    expect: { decisions: ['A1'] },
    oracle: O.jsonEquals([{ name: 'Anna', age: 31, city: 'Praha' }, { name: 'Bořek', age: 45, city: 'Brno' }, { name: 'Cyril', age: 27, city: 'Ostrava' }], { normalize: sortKeys }) },
  { id: 'S04', group: 'good', title: 'Shrnutí ≤ 40 slov se 3 fakty', prompt: SUMMARY_PROMPT,
    expect: { decisions: ['A1'] }, oracle: O.all(O.maxWords(40), O.containsAll(['2014', ['brn'], '85'])) },

  // ── trap ──────────────────────────────────────────────────────────────────────────────
  { id: 'S05', group: 'trap', title: 'Počítání písmen (strawberry)',
    prompt: 'Kolikrát se v anglickém slově „strawberry“ vyskytuje písmeno „r“? Odpověz jedním číslem.',
    expect: { decisions: ['A1'] }, oracle: O.finalNumberIs(3) },
  { id: 'S06', group: 'trap', title: 'Slovní úloha se slevou',
    prompt: 'Sešit stojí 23 Kč. Při nákupu více než 10 kusů je sleva 15 % z celé částky. Kolik zaplatím za 12 sešitů? Uveď výsledek v Kč na dvě desetinná místa.',
    expect: { decisions: ['A1'] }, oracle: O.finalNumberIs(234.6, 0.001) },
  { id: 'S07', group: 'trap', title: 'Program parseDuration (okrajové případy)',
    prompt: 'Napiš v JavaScriptu funkci parseDuration(s), která převede řetězec jako „1h30m“, „45s“, „2h5s“ nebo „10m“ na celkový počet sekund (celé číslo). Jednotky jsou h, m, s v tomto pořadí a každá je nepovinná. Pro neplatný vstup (prázdný řetězec, „abc“, „5x“) vrať null.',
    expect: { decisions: ['A1'] }, oracle: O.jsTests('parseDuration', DURATION_CASES) },
  { id: 'S08', group: 'trap', title: 'Striktní JSON + česká morfologie',
    prompt: 'Vrať POUZE platný JSON bez jakéhokoli dalšího textu, s klíči "jmeno" (v 1. pádě), "datum" (formát RRRR-MM-DD) a "castka" (číslo) z věty: Faktura pro Janu Novákovou ze dne 3. března 2025 zní na 12 450,50 Kč.',
    expect: { decisions: ['A1'] }, oracle: O.jsonEquals({ jmeno: 'Jana Nováková', datum: '2025-03-03', castka: 12450.5 }, { strict: true, normalize: sortKeys }) },

  // ── alternative ───────────────────────────────────────────────────────────────────────
  { id: 'S09', group: 'alternative', title: 'A2: neodvoditelný cíl → STOP → upřesnění → výsledek', prompt: 'Udělej to lépe.',
    expect: { decisions: ['A2', 'A3'], stop: true }, rawOracle: O.asksClarification,
    followUp: { answer: 'Přepiš větu „Ten meeting byl fakt dost blbej a k ničemu.“ do zdvořilé formální češtiny.',
      expect: { decisions: ['A1', 'B1', 'C1'] }, oracle: O.all(O.notContainsOutsideExplanations('blbej'), O.containsAll([['schůz', 'jednání', 'meeting', 'porad', 'setkání']])) } },
  { id: 'S10', group: 'alternative', title: 'B1: explicitní cíl shodný se zadáním', prompt: TRANSLATE_PROMPT, explicitGoal: 'Překlad věty do angličtiny.',
    expect: { decisions: ['B1', 'C1'] }, oracle: O.containsAll(['good morning', 'how are you']) },
  { id: 'S11', group: 'alternative', title: 'D1/C1: explicitní cíl v rozporu (němčina × angličtina)', prompt: TRANSLATE_PROMPT, explicitGoal: 'Překlad věty do němčiny.',
    expect: { decisions: ['D1', 'C1'] },
    // Správně je zastavit se a zeptat, nebo dodat i německou verzi (explicitní cíl má vyšší autoritu).
    oracle: O.containsAll(['guten morgen']), rawOracle: async (out) => {
      const de = await O.containsAll(['guten morgen'])(out);
      const q = O.asksClarification(out);
      return { ok: de.ok || q.ok, detail: `${de.detail}; ${q.detail}` };
    } },
  { id: 'S12', group: 'alternative', title: 'Poctivost: data v reálném čase nejsou k dispozici', prompt: 'Kolik je právě teď hodin v San Franciscu?',
    expect: { decisions: ['A1', 'A2'] }, oracle: O.admitsNoRealtime },

  // ── learning (řízená chyba v 1. exekuci) ──────────────────────────────────────────────
  { id: 'L01', group: 'learning', title: 'isPrime s chybou (1 a záporná čísla → true)', prompt: ISPRIME_PROMPT, modes: ['fr'],
    expect: { decisions: ['A1'] }, oracle: O.jsTests('isPrime', ISPRIME_CASES),
    inject: injected('Funkce isPrime je v artefaktu.', [{ name: 'isPrime.js', type: 'code', language: 'javascript', content: 'function isPrime(n) {\n  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;\n  return true;\n}' }], 'code') },
  { id: 'L02', group: 'learning', title: 'Výpočet s aritmetickou chybou (199 místo 198)', prompt: MATH_PROMPT, modes: ['fr'],
    expect: { decisions: ['A1'] }, oracle: O.finalNumberIs(198),
    inject: injected('Postup: 17 * 23 = 391. Přičteme 5: 391 + 5 = 396. Vydělíme dvěma: 396 / 2 = 199. Výsledek je 199.') },
  { id: 'L03', group: 'learning', title: 'Shrnutí přes limit (62 slov, chybí počet zaměstnanců)', prompt: SUMMARY_PROMPT, modes: ['fr'],
    expect: { decisions: ['A1'] }, oracle: O.all(O.maxWords(40), O.containsAll(['2014', ['brn'], '85'])),
    inject: injected('Vltava Robotics je brněnská společnost založená v roce 2014 dvojicí inženýrů z VUT, která vyvíjí autonomní skladové roboty schopné vychystávat objednávky bez kolejnic. Roboty firmy používá více než třicet logistických center v pěti zemích střední Evropy. Firma loni získala investici 120 milionů korun, plánuje pobočku ve Vídni a za klíč k úspěchu považuje rychlou iteraci prototypů a spolupráci se zákazníky při testování.') },
];

module.exports = { SCENARIOS, ISPRIME_CASES, DURATION_CASES };
