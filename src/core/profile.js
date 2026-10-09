'use strict';
/**
 * Charakteristika úlohy (task profile) — deterministicky, BEZ AI volání, jen z textu zadání, explicitního cíle
 * a deterministických detektorů. Nejde o lexikální podobnost: profil popisuje POVAHU požadavku
 * (typ, očekávaný artefakt, omezení, kontext, ověřitelnost, jazyk, potřebné schopnosti, rizika).
 *
 * Podobnost je kvalitativní: klíčové znaky (typ + artefakt) se musí shodovat, ostatní znaky se vypíší jako
 * shodné / odlišné. Žádná procenta ani prahy pravděpodobnosti.
 */
const { stripDiacritics } = require('./util');
const { guessTaskType, detectInjection, detectSensitiveData, detectOperations } = require('./detectors');
const { findExpression } = require('../tools/arith');
const { findCsvBlock } = require('../tools/csv');

const PROFILE_VERSION = 'task-profile/1';
const KEY_FEATURES = ['kind', 'artifact'];
const FEATURE_ORDER = ['kind', 'artifact', 'language', 'constraints', 'context', 'verifiability', 'needs', 'risks', 'explicitGoal', 'size'];

const FEATURE_LABEL = {
  kind: 'povaha požadavku', artifact: 'očekávaný artefakt', language: 'jazyk zadání', constraints: 'omezení',
  context: 'kontext / vstupy', verifiability: 'ověřitelnost', needs: 'potřebné schopnosti', risks: 'rizika',
  explicitGoal: 'explicitní cíl', size: 'rozsah zadání',
};

const CS_WORDS = /\b(a|je|se|na|v|ve|do|pro|ktery|ktera|ktere|jak|co|to|tento|tato|vypocitej|napis|shrn|preved|udelej|prosim|jsem|chci)\b/g;
const EN_WORDS = /\b(the|and|is|are|of|to|in|for|what|how|please|write|summarize|convert|calculate|you|do|this|with)\b/g;

/** Hrubé, deterministické určení jazyka textu (cs / en / other). */
function detectLanguage(text) {
  const s = String(text || '');
  const diac = (s.match(/[áčďéěíňóřšťúůýž]/gi) || []).length;
  const plain = stripDiacritics(s.toLowerCase());
  const cs = (plain.match(CS_WORDS) || []).length + diac;
  const en = (plain.match(EN_WORDS) || []).length;
  if (!cs && !en) return 'other';
  return cs >= en ? 'cs' : 'en';
}

function constraintsOf(t) {
  const out = new Set();
  if (/\b\d+\s*(slov|vet|bod|odstav|words?|sentences?|points?|bullets?)/.test(t) || /(maximaln|nejvyse|minimaln|alespon|at most|at least)\s*\d+/.test(t)) out.add('length');
  if (/\b(json|tabulk|odrazk|v bodech|markdown|csv|xml|yaml|table|bullet)/.test(t)) out.add('format');
  if (/(v anglictin|anglicky|in english|nemecky|v nemcin|in german|francouzsky|v cestin|cesky|in czech)/.test(t)) out.add('language_target');
  if (/(formaln|neformaln|strucn|podrobn|odborn|pro deti|jednoduse|concise|formal|detailed)/.test(t)) out.add('style');
  return [...out].sort();
}

function contextOf(prompt, t) {
  if (findCsvBlock(prompt) || /```/.test(prompt) || /:\s*\n\s*\S[\s\S]{40,}/.test(prompt)) return 'inline_data';
  if (/(tento projekt|tohoto projektu|tento soubor|prilozen|v priloze|attached|this project|this file|nasledujici soubor|https?:\/\/)/.test(t)) return 'external_ref';
  return 'none';
}

function needsOf(t) {
  const out = new Set();
  if (/(kolik je hodin|aktualn|dnes|ted\b|prave ted|realtime|current|right now|today|kurz|pocasi)/.test(t)) out.add('realtime');
  if (/(https?:\/\/|internet|na webu|web\b|google|vyhledej|search)/.test(t)) out.add('web');
  if (/(soubor|slozk|adresar|disk\b|file|folder)/.test(t)) out.add('files');
  return [...out].sort();
}

function artifactOf(kind, t) {
  if (/(html|webov|web app|aplikac|hra\b|hru\b|game)/.test(t) && /(napis|vytvor|naprogramuj|udelej|create|build|write)/.test(t)) return 'html';
  if (/\bjson\b/.test(t) || kind === 'structured_transformation') return 'json';
  if (kind === 'code') return 'code';
  if (kind === 'math') return 'number';
  if (/(odrazk|v bodech|seznam|bullet|list of)/.test(t)) return 'list';
  return 'text';
}

function kindOf(text, t) {
  const k = guessTaskType(text);
  if (k === 'other' && /^(ahoj|cau|dobry den|hello|hi|hey|how do you do|jak se mas|diky|dekuji|thanks)\b/.test(t.trim())) return 'conversation';
  return k;
}

/**
 * @returns {{version, features:{…}, labels}}  — features jsou kategorické hodnoty (řetězce nebo seřazená pole).
 */
function profileTask({ prompt, explicitGoal, clarifications }) {
  const text = [prompt, explicitGoal || '', ...(clarifications || []).map((c) => c.answer)].join('\n');
  const t = stripDiacritics(text.toLowerCase());
  const kind = kindOf(text, t);
  const risks = [];
  if (detectInjection(text).suspected) risks.push('injection');
  if (detectSensitiveData(text).level !== 'none') risks.push('pii');
  if (detectOperations(text).length) risks.push('blocked_ops');
  const constraints = constraintsOf(t);
  const deterministic = !!findExpression(text) || !!findCsvBlock(prompt) || kind === 'code' || constraints.includes('length');
  const len = String(prompt || '').length;
  const features = {
    kind,
    artifact: artifactOf(kind, t),
    language: detectLanguage(prompt),
    constraints,
    context: contextOf(String(prompt || ''), t),
    verifiability: deterministic ? 'deterministic' : 'semantic',
    needs: needsOf(t),
    risks: risks.sort(),
    explicitGoal: explicitGoal ? 'yes' : 'no',
    size: len < 80 ? 'short' : len < 600 ? 'medium' : 'long',
  };
  return { version: PROFILE_VERSION, features };
}

function fmt(v) {
  return Array.isArray(v) ? (v.length ? v.join(', ') : '—') : String(v);
}

/**
 * Kvalitativní porovnání dvou profilů.
 * level: 'strong' (klíčové znaky shodné, nejvýše 2 odlišné ostatní), 'related' (klíčové shodné, víc odlišností), 'none'.
 */
function compareProfiles(a, b) {
  const matched = [];
  const mismatched = [];
  for (const k of FEATURE_ORDER) {
    const va = a.features[k];
    const vb = b.features[k];
    const same = Array.isArray(va) ? JSON.stringify(va) === JSON.stringify(vb || []) : va === vb;
    (same ? matched : mismatched).push({ feature: k, label: FEATURE_LABEL[k], a: fmt(va), b: fmt(vb), key: KEY_FEATURES.includes(k) });
  }
  const keyMatch = !mismatched.some((m) => m.key);
  const level = !keyMatch ? 'none' : mismatched.length <= 2 ? 'strong' : 'related';
  return { level, keyMatch, matched, mismatched };
}

/** Splňuje profil podmínky použitelnosti doporučení? (klíčové znaky + požadované znaky hypotézy) */
function satisfies(profile, applicability) {
  const misses = [];
  for (const [k, v] of Object.entries(applicability.key || {})) if (profile.features[k] !== v) misses.push(`${FEATURE_LABEL[k]}: ${fmt(profile.features[k])} ≠ ${v}`);
  for (const [k, vals] of Object.entries(applicability.requires || {})) {
    const have = profile.features[k];
    for (const v of vals) if (!(Array.isArray(have) ? have.includes(v) : have === v)) misses.push(`${FEATURE_LABEL[k]}: chybí „${v}“`);
  }
  return { ok: !misses.length, misses };
}

module.exports = { profileTask, compareProfiles, satisfies, detectLanguage, PROFILE_VERSION, KEY_FEATURES, FEATURE_LABEL, FEATURE_ORDER };
