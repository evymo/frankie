'use strict';
/**
 * H-sestavy — verzované a hashované kombinace analytických hledisek pro Gate 0.
 *
 * Invarianty (vynucuje validateSet, nelze je „naučit“ jinak):
 *  - každá sestava obsahuje všechna systémová hlediska (H1, H7, H8, H9);
 *  - strop priority (cap) smí mít jen adaptivní hledisko; systémovým lze prioritu jen zvýšit;
 *  - známá jsou jen hlediska z ASPECTS a z katalogu (žádný volný text z cizích úloh).
 * Sestava mění, NA CO se analýza ptá a jak silně se zjištění promítnou do Execution Contract.
 * Nikdy nemění Goal Contract, akceptační kritéria, oprávnění ani limity.
 */
const { ASPECTS, CORE_ASPECT_IDS, PRIORITIES, aspectDef } = require('./aspects');
const { sha256, canonicalJson, clone } = require('./util');

const SET_SCHEMA = 'fr-aspect-set/1';

function setContent(set) {
  return {
    aspects: set.aspects.map((a) => `${a.id}@${a.version}`),
    floors: set.floors || {},
    caps: set.caps || {},
  };
}

function hashSet(set) {
  return sha256(canonicalJson(setContent(set)));
}

function setRef(set) {
  return { id: set.id, version: set.version, hash: set.hash };
}

function refLabel(ref) {
  return ref ? `${ref.id}@v${ref.version}` : '—';
}

/** Kontrola invariantů. Vrací seznam problémů (prázdný = platná sestava). */
function validateSet(set) {
  const errs = [];
  const ids = (set.aspects || []).map((a) => a.id);
  for (const core of CORE_ASPECT_IDS) if (!ids.includes(core)) errs.push(`Chybí systémové hledisko ${core}.`);
  if (new Set(ids).size !== ids.length) errs.push('Duplicitní hlediska.');
  for (const a of set.aspects || []) {
    const def = aspectDef(a.id);
    if (!def) errs.push(`Neznámé hledisko ${a.id}.`);
    else if (def.version !== a.version) errs.push(`Neznámá verze ${a.id}@${a.version}.`);
  }
  for (const [id, p] of Object.entries(set.floors || {})) {
    if (!ids.includes(id)) errs.push(`Minimální priorita pro hledisko mimo sestavu: ${id}.`);
    if (!PRIORITIES.includes(p)) errs.push(`Neplatná priorita ${p}.`);
  }
  for (const [id, p] of Object.entries(set.caps || {})) {
    if (!ids.includes(id)) errs.push(`Strop priority pro hledisko mimo sestavu: ${id}.`);
    if (CORE_ASPECT_IDS.includes(id)) errs.push(`Systémovému hledisku ${id} nelze omezit prioritu.`);
    if (!PRIORITIES.includes(p)) errs.push(`Neplatná priorita ${p}.`);
  }
  if (set.hash && set.hash !== hashSet(set)) errs.push('Hash sestavy neodpovídá obsahu.');
  return errs;
}

function finalizeSet(set) {
  const s = { schemaVersion: SET_SCHEMA, ...set };
  s.hash = hashSet(s);
  const errs = validateSet(s);
  if (errs.length) throw new Error(`Neplatná H-sestava: ${errs.join(' ')}`);
  return s;
}

const DEFAULT_SET = finalizeSet({
  id: 'HS-default',
  version: 1,
  label: 'Výchozí univerzální sestava H1–H10',
  aspects: ASPECTS.map((a) => ({ id: a.id, version: a.version })),
  floors: {},
  caps: {},
  origin: { kind: 'builtin', note: 'Bezpečná výchozí sestava v0.3.1.' },
  parent: null,
  change: null,
});

/** Definice hledisek sestavy v jejím pořadí (pro šablonu Gate 0, zpracování a UI). */
function resolveAspects(set) {
  return set.aspects.map((a) => {
    const def = aspectDef(a.id);
    return { id: def.id, name: def.name, question: def.question, kind: def.kind, version: def.version };
  });
}

function describeChange(change) {
  const parts = [];
  if (change.add) parts.push(`přidat ${change.add.join(', ')}`);
  if (change.remove) parts.push(`odebrat ${change.remove.join(', ')}`);
  if (change.floor) parts.push(Object.entries(change.floor).map(([k, v]) => `min. priorita ${k} ≥ ${v}`).join(', '));
  if (change.cap) parts.push(Object.entries(change.cap).map(([k, v]) => `strop priority ${k} ≤ ${v}`).join(', '));
  return parts.join('; ');
}

/**
 * Odvozená sestava = rodič + JEDNA řízená změna (add | remove | floor | cap).
 * ID je odvozeno z hashe obsahu, takže stejná změna vede vždy ke stejné sestavě.
 */
function deriveSet(parent, change, origin) {
  const keys = Object.keys(change).filter((k) => change[k]);
  if (keys.length !== 1) throw new Error('Odvozená H-sestava smí obsahovat právě jednu změnu.');
  const aspects = clone(parent.aspects);
  const floors = clone(parent.floors || {});
  const caps = clone(parent.caps || {});
  if (change.add) for (const id of change.add) { const d = aspectDef(id); if (d && !aspects.some((a) => a.id === id)) aspects.push({ id, version: d.version }); }
  if (change.remove) {
    for (const id of change.remove) {
      if (CORE_ASPECT_IDS.includes(id)) throw new Error(`Systémové hledisko ${id} nelze odebrat.`);
      const i = aspects.findIndex((a) => a.id === id);
      if (i >= 0) aspects.splice(i, 1);
      delete floors[id]; delete caps[id];
    }
  }
  if (change.floor) Object.assign(floors, change.floor);
  if (change.cap) Object.assign(caps, change.cap);
  const draft = { aspects, floors, caps };
  const hash = hashSet(draft);
  return finalizeSet({
    id: `HS-${hash.slice(0, 10)}`,
    version: 1,
    label: describeChange(change),
    aspects, floors, caps,
    origin: clone(origin || {}),
    parent: setRef(parent),
    change: clone(change),
  });
}

module.exports = { DEFAULT_SET, SET_SCHEMA, validateSet, finalizeSet, hashSet, setRef, refLabel, resolveAspects, deriveSet, describeChange };
