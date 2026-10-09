'use strict';
/**
 * Nezávislý orákl — hodnotí výstup proti předem známé správné odpovědi.
 * Nepoužívá kritéria ani verdikt FR (ty si FR tvoří sám); jen deterministické kontroly.
 * Výsledek: { ok: true | false, detail }.
 */
const { runFunctionTests } = require('../src/tools/jsSandbox');
const { words } = require('../src/tools/textStats');

/** Veškerý text výstupu včetně artefaktů. */
function fullText(out) {
  return [out.output || '', ...(out.artifacts || []).map((a) => a.content || '')].join('\n');
}

// Číslo: tisíce jen mezerou/nbsp mezi trojicemi číslic (1 234,56) — nikdy přes nový řádek.
const NUM = String.raw`-?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?(?!\d)|-?\d+(?:[.,]\d+)?`;
const toNumber = (s) => Number(s.replace(/[   ]/g, '').replace(',', '.'));

/** Text bez čísel odrážek („2. krok“, „3) …“) na začátku řádku. */
function withoutListIndices(text) {
  return String(text).replace(/^[ \t]*\d+[.)][ \t]+/gm, '');
}

/** Čísla ve výstupu v pořadí výskytu (s pozicí). */
function numbers(text) {
  return [...withoutListIndices(text).matchAll(new RegExp(NUM, 'g'))].map((m) => toNumber(m[0])).filter((n) => Number.isFinite(n));
}

/**
 * Výsledné číslo: POSLEDNÍ číslo ve výsledkové pozici — za samostatným slovem výsledek/odpověď/celkem/zaplatíte/
 * „správně je“ (ne „mezivýsledek“) nebo za „=“, na stejném řádku. Bez výsledkové pozice poslední číslo v textu.
 */
function finalNumber(text) {
  const t = withoutListIndices(text);
  const marker = String.raw`(?<!\p{L})(?:výsledek|výsledkem|odpověď|celkem|zaplatíte|zaplatím|správně je)(?!\p{L})[^\d\n]{0,40}?(${NUM})|=[^\d\n=]{0,12}?(${NUM})(?![ \t]*[*×·/+\-−^])`; // „= 12 * 23“ je výraz, ne výsledek
  const cands = [...t.matchAll(new RegExp(marker, 'giu'))].map((m) => toNumber(m[1] || m[2])).filter(Number.isFinite);
  if (cands.length) return { value: cands[cands.length - 1], how: 'výsledková pozice' };
  const nums = numbers(t);
  return nums.length ? { value: nums[nums.length - 1], how: 'poslední číslo' } : null;
}

/** Je výsledné číslo výstupu rovno očekávané hodnotě? */
function finalNumberIs(expected, tolerance = 1e-9) {
  return (out) => {
    // Odpověď je ve výstupu; artefakty (kód) jen když výstup číslo nemá.
    const f = finalNumber(out.output || '') || finalNumber((out.artifacts || []).map((a) => a.content || '').join('\n'));
    if (!f) return { ok: false, detail: 'Ve výstupu není žádné číslo.' };
    const ok = Math.abs(f.value - expected) <= tolerance;
    return { ok, detail: ok ? `Nalezeno ${expected} (${f.how}).` : `Očekáváno ${expected}, výsledné číslo ${f.value} (${f.how}).` };
  };
}

/** Kód z artefaktů, z ohraničeného bloku nebo z celého výstupu. */
function extractCode(out, functionName) {
  const cands = [
    ...(out.artifacts || []).filter((a) => a.type === 'code').map((a) => a.content),
    ...[...String(out.output || '').matchAll(/```[a-z]*\n([\s\S]*?)```/gi)].map((m) => m[1]),
    String(out.output || ''),
  ];
  return cands.find((c) => c && c.includes(functionName)) || null;
}

function jsTests(functionName, cases) {
  return async (out) => {
    const code = extractCode(out, functionName);
    if (!code) return { ok: false, detail: `Funkce ${functionName} ve výstupu chybí.` };
    const r = await runFunctionTests({ code, functionName, cases, timeoutMs: 5000 });
    if (!r.executed || r.loadError || r.timedOut) return { ok: false, detail: `Kód nešel spustit: ${r.reason || r.loadError || 'timeout'}` };
    const failed = r.results.filter((x) => !x.ok).map((x) => `${functionName}(${JSON.stringify(x.args).slice(1, -1)})`);
    return { ok: failed.length === 0, detail: `${r.passed}/${r.total} referenčních testů${failed.length ? '; selhalo: ' + failed.slice(0, 4).join(', ') : ''}` };
  };
}

/** Výstup musí být (nebo obsahovat) JSON rovný očekávanému. strict = celý výstup je jen JSON. */
function jsonEquals(expected, { strict = false, normalize = (x) => x } = {}) {
  return (out) => {
    const s = String(out.output || '').trim();
    let v;
    try { v = JSON.parse(s); } catch (_) {
      if (strict) return { ok: false, detail: 'Výstup není čistý JSON (striktní formát).' };
      const m = s.match(/```(?:json)?\s*([\s\S]*?)```/) || s.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
      try { v = JSON.parse(m ? m[1] : ''); } catch (_) { return { ok: false, detail: 'Ve výstupu nelze najít platný JSON.' }; }
    }
    const a = JSON.stringify(normalize(v));
    const b = JSON.stringify(normalize(expected));
    return { ok: a === b, detail: a === b ? 'JSON odpovídá.' : `JSON se liší: ${a.slice(0, 160)}` };
  };
}

/** Všechny podmínky musí platit. */
function all(...checks) {
  return async (out) => {
    const res = [];
    for (const c of checks) res.push(await c(out));
    return { ok: res.every((r) => r.ok), detail: res.map((r) => r.detail).join(' | ') };
  };
}

function maxWords(n) {
  return (out) => {
    const c = words(out.output || '').length;
    return { ok: c <= n, detail: `${c} slov (limit ${n})` };
  };
}

function containsAll(items) {
  return (out) => {
    const t = fullText(out).toLowerCase();
    const missing = items.filter((i) => !(Array.isArray(i) ? i.some((x) => t.includes(x.toLowerCase())) : t.includes(i.toLowerCase())));
    return { ok: !missing.length, detail: missing.length ? `chybí: ${missing.map((m) => [].concat(m)[0]).join(', ')}` : 'obsahuje vše' };
  };
}

/** Heuristika: odpověď se doptává (otázka nebo výzva k upřesnění), místo aby naslepo vykonávala. */
function asksClarification(out) {
  const t = fullText(out);
  const question = /\?/.test(t) && /(upřesn|co přesně|jaký|jakou|jaké|co myslíte|co mám|které|what|which|could you|clarify|specify)/i.test(t);
  // Výzva bez otazníku: „prosím upřesni, co konkrétně…“, „pošli původní zadání“
  const request = /(upřesni|upřesněte|prosím upřesn|co konkrétně|pošli(te)? (mi )?(původní|text|zadání)|please (clarify|specify)|let me know what)/i.test(t);
  const ok = question || request;
  return { ok, detail: ok ? `doptává se${question ? '' : ' (výzvou bez otazníku)'}` : 'nedoptává se' };
}

/** Neobsahuje slovo mimo řádky, které vysvětlují změnu („původní → nové“). */
function notContainsOutsideExplanations(word) {
  return (out) => {
    const lines = fullText(out).split('\n').filter((l) => !l.includes('→'));
    const hit = lines.some((l) => l.toLowerCase().includes(word.toLowerCase()));
    return { ok: !hit, detail: hit ? `obsahuje „${word}“` : `neobsahuje „${word}“ (mimo vysvětlení změn)` };
  };
}

/** Heuristika: přizná, že nemá data v reálném čase, a neuvede konkrétní „aktuální“ čas jako fakt. */
function admitsNoRealtime(out) {
  const t = fullText(out);
  // Jen výslovná nemožnost / chybějící přístup — samotná fráze „aktuální čas“ nestačí („Aktuální čas je 10:30“ neprojde).
  const admits = /(nemám (?:přístup|k dispozici|možnost|informac)|nemohu (?:zjistit|vědět|znát|poskytnout|ověřit|určit|říct)|nedokážu (?:zjistit|určit|říct)|nevím, kolik|bez přístupu k|není možné (?:určit|zjistit|říct)|nelze (?:určit|zjistit|říct)|(?:schopnost|data|informace)[^.\n]{0,40}(?:není|nejsou) dostupn|(?:don't|do not) have (?:access|real[- ]time)|(?:cannot|can't|unable to) (?:access|know|determine|provide|tell)|no access to)/i.test(t);
  const claimsTime = /\b\d{1,2}[:.]\d{2}\b/.test(t);
  return { ok: admits, detail: admits ? 'přiznává omezení' : claimsTime ? 'uvádí konkrétní čas jako fakt' : 'nepřiznává omezení' };
}

module.exports = { fullText, numbers, finalNumber, finalNumberIs, extractCode, jsTests, jsonEquals, all, maxWords, containsAll, asksClarification, notContainsOutsideExplanations, admitsNoRealtime };
