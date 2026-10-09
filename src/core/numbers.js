'use strict';
/**
 * Jeden výklad „výsledného čísla“ pro verifikátor (number_equals) i orákl benchmarku (bench/oracle.js).
 * Pořadí: 1. poslední VÝSLOVNÝ výsledek → 2. poslední číslo za „=“ → 3. poslední číslo v textu.
 * Kontrola ani mezivýsledek za „=“ výslovný výsledek nepřebijí; „= 12 * 23“ je výraz, ne výsledek;
 * číslo je vždy celé (žádné couvání o číslici); tisíce jen mezerou mezi trojicemi; nový řádek čísla nespojí.
 */

// Číslo: tisíce jen mezerou/nbsp mezi trojicemi číslic (1 234,56) — nikdy přes nový řádek.
const NUM = String.raw`-?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?!\d)|-?\d+(?:[.,]\d+)?`;
// Celé číslo (žádné couvání o číslici) a ne výraz („= 12 * 23“): za ním nesmí být číslice ani operátor.
const COMPLETE = String.raw`(${NUM})(?!\d)(?![ \t]*[*×·/+\-−^])`;
// Výslovný výsledek: samostatné slovo (ne „mezivýsledek“), mezi ním a číslem jen spojky a interpunkce
// („vydělíme výsledek číslem 2“ ohlášení odpovědi není).
const EXPLICIT_SRC = String.raw`(?<!\p{L})(?:výsledek|výsledkem|odpověď|celkem|zaplatíte|zaplatím|správně je|správný výsledek|správný číselný výsledek)(?!\p{L})(?:[ \t]+(?:výpočtu|příkladu|je|jsou|činí|bude|zní|tedy))*[^\p{L}\d\n]{0,12}?${COMPLETE}`;
const AFTER_EQ_SRC = String.raw`=[^\d\n=]{0,12}?${COMPLETE}`;

const toNumber = (s) => Number(String(s).replace(/[   ]/g, '').replace(',', '.'));

/** Text bez čísel odrážek („2. krok“, „3) …“) na začátku řádku. */
function withoutListIndices(text) {
  return String(text || '').replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
}

function pick(text, src, flags) {
  return [...String(text).matchAll(new RegExp(src, flags))].map((m) => toNumber(m[1])).filter(Number.isFinite);
}

/** Čísla v textu v pořadí výskytu (bez čísel odrážek). */
function numbers(text) {
  return pick(withoutListIndices(text), `(${NUM})`, 'g');
}

/** Poslední výslovně ohlášený výsledek, nebo null (bez záložních pravidel). */
function explicitResult(text) {
  const v = pick(withoutListIndices(text), EXPLICIT_SRC, 'giu');
  return v.length ? v[v.length - 1] : null;
}

/** Výsledné číslo textu: { value, how } nebo null. */
function finalNumber(text) {
  const t = withoutListIndices(text);
  const explicit = pick(t, EXPLICIT_SRC, 'giu');
  if (explicit.length) return { value: explicit[explicit.length - 1], how: 'výslovný výsledek' };
  const eq = pick(t, AFTER_EQ_SRC, 'gu');
  if (eq.length) return { value: eq[eq.length - 1], how: 'za „=“' };
  const nums = numbers(t);
  return nums.length ? { value: nums[nums.length - 1], how: 'poslední číslo' } : null;
}

/** Je text čistě jedno číslo („201“, „234,60“)? Vrací číslo nebo null. */
function pureNumber(text) {
  const s = String(text == null ? '' : text).trim();
  return new RegExp(`^(?:${NUM})$`).test(s) ? toNumber(s) : null;
}

module.exports = { NUM, toNumber, withoutListIndices, numbers, explicitResult, finalNumber, pureNumber };
