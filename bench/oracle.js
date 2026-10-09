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

/** Čísla ve výstupu, včetně českého zápisu (1 234,56). */
function numbers(text) {
  return [...String(text).matchAll(/-?\d[\d\s ]*(?:[.,]\d+)?/g)]
    .map((m) => Number(m[0].replace(/[\s ]/g, '').replace(',', '.')))
    .filter((n) => Number.isFinite(n));
}

/** Je hodnota posledním (výsledným) číslem, případně přítomna ve větě s „výsledek/celkem/=“? */
function finalNumberIs(expected, tolerance = 1e-9) {
  return (out) => {
    const t = fullText(out);
    const nums = numbers(t);
    if (!nums.length) return { ok: false, detail: 'Ve výstupu není žádné číslo.' };
    const hit = (n) => Math.abs(n - expected) <= tolerance;
    const last = nums[nums.length - 1];
    const marked = [...t.matchAll(/(?:výsledek|odpověď|celkem|zaplatíte|zaplatím|je|=)\s*[:=]?\s*\**\s*(-?\d[\d\s ]*(?:[.,]\d+)?)/gi)]
      .map((m) => Number(m[1].replace(/[\s ]/g, '').replace(',', '.')));
    if (hit(last) || marked.some(hit)) return { ok: true, detail: `Nalezeno ${expected}.` };
    return { ok: false, detail: `Očekáváno ${expected}, poslední číslo ve výstupu ${last}.` };
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
  const admits = /(nemám přístup|nemohu|nedokážu|nemám k dispozici|reálném čase|aktuální(ho)? čas|nevím, kolik|don't have|do not have|cannot|can't|no access|real[- ]time)/i.test(t);
  return { ok: admits, detail: admits ? 'přiznává omezení' : 'tváří se, že čas zná' };
}

module.exports = { fullText, numbers, finalNumberIs, extractCode, jsTests, jsonEquals, all, maxWords, containsAll, asksClarification, notContainsOutsideExplanations, admitsNoRealtime };
