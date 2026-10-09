'use strict';
/**
 * Bezpečný vyhodnocovač aritmetických výrazů (bez eval): + - * / ^ ( ), unární minus,
 * desetinná tečka i čárka, × ÷, funkce sqrt/abs/round. Rekurzivní sestup.
 */

function tokenize(src) {
  const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/·/g, '*');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = s.slice(i).match(/^\d+(?:[.,]\d+)?/);
    if (num) { tokens.push({ t: 'num', v: parseFloat(num[0].replace(',', '.')) }); i += num[0].length; continue; }
    const fn = s.slice(i).match(/^(sqrt|abs|round)/i);
    if (fn) { tokens.push({ t: 'fn', v: fn[0].toLowerCase() }); i += fn[0].length; continue; }
    if ('+-*/^()'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`Nepovolený znak ve výrazu: „${c}“`);
  }
  return tokens;
}

function evaluate(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (v) => {
    const tk = tokens[pos];
    if (!tk || (v && tk.v !== v)) throw new Error(`Očekáváno „${v}“`);
    pos++;
    return tk;
  };
  function expr() {
    let v = term();
    while (peek() && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function term() {
    let v = power();
    while (peek() && (peek().v === '*' || peek().v === '/')) {
      const op = eat().v;
      const r = power();
      if (op === '/' && r === 0) throw new Error('Dělení nulou');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function power() {
    const b = unary();
    if (peek() && peek().v === '^') { eat('^'); return Math.pow(b, power()); }
    return b;
  }
  function unary() {
    if (peek() && peek().v === '-') { eat('-'); return -unary(); }
    if (peek() && peek().v === '+') { eat('+'); return unary(); }
    return primary();
  }
  function primary() {
    const tk = peek();
    if (!tk) throw new Error('Neočekávaný konec výrazu');
    if (tk.t === 'num') { pos++; return tk.v; }
    if (tk.t === 'fn') {
      pos++; eat('(');
      const v = expr();
      eat(')');
      return tk.v === 'sqrt' ? Math.sqrt(v) : tk.v === 'abs' ? Math.abs(v) : Math.round(v);
    }
    if (tk.v === '(') { eat('('); const v = expr(); eat(')'); return v; }
    throw new Error(`Neočekávaný token „${tk.v}“`);
  }
  if (!tokens.length) throw new Error('Prázdný výraz');
  const v = expr();
  if (pos !== tokens.length) throw new Error('Nadbytečné znaky ve výrazu');
  if (!Number.isFinite(v)) throw new Error('Výsledek není konečné číslo');
  return Math.round(v * 1e12) / 1e12;
}

/** Najde v textu nejdelší kandidát na aritmetický výraz (pro mock a nástrojový plán). */
function findExpression(text) {
  const re = /[\d(][\d\s.,()+\-*/^×÷]*[\d)]/g;
  let best = null;
  for (const m of String(text || '').matchAll(re)) {
    const cand = m[0].trim();
    if (!/[+\-*/^×÷]/.test(cand.replace(/^-/, ''))) continue;
    try { evaluate(cand); } catch (_) { continue; }
    if (!best || cand.length > best.length) best = cand;
  }
  return best;
}

module.exports = { evaluate, findExpression };
