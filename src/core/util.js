'use strict';
const crypto = require('crypto');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/** Stabilní JSON (seřazené klíče) — základ pro hash kontraktů a promptů. */
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function clone(o) {
  return o === undefined ? undefined : JSON.parse(JSON.stringify(o));
}

function newId(prefix) {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normalizace pro porovnání citací: malá písmena, sjednocené mezery a uvozovky. */
function normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[„“”"«»]/g, '"')
    .replace(/[‚‘’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isQuoteIn(quote, text) {
  const q = normalizeForMatch(quote);
  if (!q) return false;
  return normalizeForMatch(text).includes(q);
}

/** Vyjme JSON z odpovědi modelu (holý JSON nebo ```json blok). */
function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch (_) { /* pokračuj */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (_) { /* pokračuj */ } }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(s.slice(first, last + 1)); } catch (_) { /* nic */ }
  }
  return undefined;
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + `… [zkráceno, celkem ${s.length} znaků]` : s;
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

module.exports = {
  sha256, canonicalJson, deepFreeze, clone, newId, nowIso, stripDiacritics,
  normalizeForMatch, isQuoteIn, extractJson, truncate, deepEqual,
};
