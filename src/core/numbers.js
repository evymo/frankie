'use strict';
/**
 * Jeden výklad „výsledného čísla“ pro verifikátor (number_equals) i orákl benchmarku (bench/oracle.js).
 * Pořadí: 1. poslední SILNĚ ohlášený výsledek („výsledek / odpověď / správně je / zaplatíte / výsledkem je“)
 *         2. jinak poslední z kandidátů „celkem N“ a „= N“ podle pořadí v textu (pozdější „=“ přebije „celkem“)
 *         3. jinak poslední číslo v textu.
 * Kontrola ani mezivýsledek za „=“ silné ohlášení nepřebijí; „= 12 * 23“ je výraz, ne výsledek; číslo je vždy celé
 * (žádné couvání o číslici); tisíce jen mezerou mezi trojicemi; nový řádek čísla nespojí; znak mínus U+2212 = „-“.
 */

// Číslo: tisíce jen mezerou/nbsp mezi trojicemi číslic (1 234,56) — nikdy přes nový řádek.
const NUM = String.raw`-?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?!\d)|-?\d+(?:[.,]\d+)?`;
// Celé číslo (žádné couvání o číslici) a ne výraz („= 12 * 23“): za ním nesmí být číslice ani operátor.
const COMPLETE = String.raw`(${NUM})(?!\d)(?![ \t]*[*×·/+\-−^])`;
const CONNECT = String.raw`(?:[ \t]+(?:výpočtu|příkladu|je|jsou|činí|bude|zní|tedy))*[^\p{L}\d\n]{0,12}?`;
// Silné ohlášení: samostatné slovo (ne „mezivýsledek“); „výsledkem“ (instrumentál) jen se sponou („Výsledkem je …“).
const STRONG_SRC = String.raw`(?<!\p{L})(?:výsledek|odpověď|zaplatíte|zaplatím|správně je|správný výsledek|správný číselný výsledek|výsledkem(?=[ \t]+(?:je|jsou|bude)(?!\p{L})))(?!\p{L})${CONNECT}${COMPLETE}`;
// Slabé ohlášení: „celkem N“ — pozdější „= M“ má přednost („celkem 396, vyděleno dvěma = 198“).
const WEAK_SRC = String.raw`(?<!\p{L})celkem(?!\p{L})${CONNECT}${COMPLETE}`;
const AFTER_EQ_SRC = String.raw`=[^\d\n=]{0,12}?${COMPLETE}`;

const MINUS = /[−﹣－]/g;
const toNumber = (s) => Number(String(s).replace(MINUS, '-').replace(/[   ]/g, '').replace(',', '.'));

/** Text s normalizovaným znakem mínus a bez čísel odrážek („2. krok“, „3) …“) na začátku řádku. */
function withoutListIndices(text) {
  return String(text || '').replace(MINUS, '-').replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
}

function pick(text, src, flags) {
  return [...String(text).matchAll(new RegExp(src, flags))].map((m) => ({ value: toNumber(m[1]), at: m.index })).filter((x) => Number.isFinite(x.value));
}

/** Čísla v textu v pořadí výskytu (bez čísel odrážek). */
function numbers(text) {
  return pick(withoutListIndices(text), `(${NUM})`, 'g').map((x) => x.value);
}

/** Výsledné číslo textu: { value, how } nebo null. */
function finalNumber(text) {
  const t = withoutListIndices(text);
  const strong = pick(t, STRONG_SRC, 'giu');
  if (strong.length) return { value: strong[strong.length - 1].value, how: 'výslovný výsledek' };
  const rest = [...pick(t, WEAK_SRC, 'giu').map((x) => ({ ...x, how: '„celkem“' })), ...pick(t, AFTER_EQ_SRC, 'gu').map((x) => ({ ...x, how: 'za „=“' }))]
    .sort((a, b) => a.at - b.at);
  if (rest.length) return { value: rest[rest.length - 1].value, how: rest[rest.length - 1].how };
  const nums = numbers(t);
  return nums.length ? { value: nums[nums.length - 1], how: 'poslední číslo' } : null;
}

/** Je text čistě jedno číslo („201“, „234,60“)? Vrací číslo nebo null. */
function pureNumber(text) {
  const s = String(text == null ? '' : text).replace(MINUS, '-').trim();
  return new RegExp(`^(?:${NUM})$`).test(s) ? toNumber(s) : null;
}

/**
 * Přepíše v textu čísla, pro která `isForeign(n)` vrací true, na `replacement`. Čísla odrážek na začátku řádku
 * nechá být. Vrací { text, replaced: [čísla] }.
 */
function replaceNumbers(text, isForeign, replacement) {
  const replaced = [];
  const out = String(text == null ? '' : text).replace(MINUS, '-').split('\n').map((line) => {
    const m = line.match(/^[ \t]*\d+[.)][ \t]+/);
    const head = m ? m[0] : '';
    const body = line.slice(head.length).replace(new RegExp(NUM, 'g'), (tok) => {
      const n = toNumber(tok);
      if (!Number.isFinite(n) || !isForeign(n)) return tok;
      replaced.push(n);
      return String(replacement);
    });
    return head + body;
  }).join('\n');
  return { text: out, replaced };
}

module.exports = { NUM, toNumber, withoutListIndices, numbers, finalNumber, pureNumber, replaceNumbers };
