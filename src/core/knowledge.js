'use strict';
/**
 * Knowledge Base (KB) — lokální zkušenosti o účinnosti H-sestav. Ukládá se do data/kb (mimo Git).
 *
 * Ukládá METODU, nikoli fakta z úloh: kategorický profil úlohy, použitou H-sestavu, diagnózu (ID kritérií,
 * typy kontrol, třídy příčin), kandidátní doporučení, řízená srovnání a pozorování. Neukládá text zadání ani
 * výstupy — jen SHA-256 zadání a ID běhů. Do nové úlohy se tak nemůže přenést faktický obsah cizí úlohy.
 *
 * Důvěryhodnost doporučení (computeStatus) zvyšují VÝHRADNĚ reálná řízená srovnání proti stejnému zamčenému
 * Goal Contract, stejným kritériím a stejné verzi hodnotitele. Simulace (mock) se eviduje, ale nezapočítává.
 * Nekontrolovaná pozorování mohou důvěru jen snížit (korelace není důkaz zlepšení).
 */
const fs = require('fs');
const path = require('path');
const { nowIso, newId, canonicalJson, clone } = require('./util');
const { DEFAULT_SET, validateSet, setRef } = require('./aspectSets');
const { compareProfiles, satisfies } = require('./profile');

const KB_SCHEMA = 'fr-kb/1';
const STATUS_RANK = { verified: 4, supported: 3, candidate: 2, contested: 1, refuted: 0 };
const STATUS_LABEL = {
  candidate: 'kandidát (hypotéza, neověřeno)',
  supported: 'předběžně podpořeno (1 reálné srovnání)',
  verified: 'ověřeno opakovaným reálným srovnáním',
  contested: 'sporné (protichůdné nebo varovné důkazy)',
  refuted: 'vyvráceno',
};
const MIN_VERIFY_WINS = 2; // tvrdé minimum: jediný úspěch nikdy není „ověřeno“

function emptyKb() {
  return { schemaVersion: KB_SCHEMA, createdAt: nowIso(), updatedAt: nowIso(), aspectSets: {}, experiences: [], recommendations: [], comparisons: [], log: [] };
}

/** Migrace mezi verzemi úložiště. Neznámá (budoucí) verze = fail-closed: KB se nepoužije ani nepřepíše. */
function migrate(data) {
  if (!data || typeof data !== 'object') return emptyKb();
  if (data.schemaVersion === KB_SCHEMA) {
    for (const k of ['experiences', 'recommendations', 'comparisons', 'log']) if (!Array.isArray(data[k])) data[k] = [];
    if (!data.aspectSets || typeof data.aspectSets !== 'object') data.aspectSets = {};
    return data;
  }
  throw new Error(`Neznámá verze Knowledge Base „${data.schemaVersion}“ — KB se nepoužije ani nepřepíše.`);
}

function tally(rec) {
  const real = rec.evidence.comparisons.filter((c) => c.counted);
  return {
    wins: real.filter((c) => c.effect === 'support').length,
    losses: real.filter((c) => c.effect === 'against').length,
    neutral: real.filter((c) => c.effect === 'neutral').length,
    simulated: rec.evidence.comparisons.filter((c) => c.simulated).length,
    notCounted: rec.evidence.comparisons.filter((c) => !c.counted && !c.simulated).length,
    warnings: rec.evidence.observations.filter((o) => o.effect === 'warning').length,
    observations: rec.evidence.observations.length,
  };
}

/** Stav důvěryhodnosti — čistá funkce nad evidencí. */
function computeStatus(rec, { verifyMinWins = MIN_VERIFY_WINS } = {}) {
  const t = tally(rec);
  if (t.losses && t.losses >= t.wins) return 'refuted';
  if (t.losses || t.warnings >= 2) return 'contested';
  if (t.wins >= Math.max(MIN_VERIFY_WINS, verifyMinWins)) return 'verified';
  if (t.wins >= 1) return 'supported';
  return 'candidate';
}

function evidenceText(rec) {
  const t = tally(rec);
  const parts = [`${t.wins} podpůrných a ${t.losses} vyvracejících reálných srovnání`];
  if (t.neutral) parts.push(`${t.neutral} bez rozdílu`);
  if (t.simulated) parts.push(`${t.simulated} simulovaných (nezapočítáno)`);
  if (t.notCounted) parts.push(`${t.notCounted} nezapočitatelných (změněné podmínky / vnější příčina)`);
  if (t.observations) parts.push(`${t.observations} pozorování při použití, z toho ${t.warnings} varovných`);
  return parts.join(', ');
}

class KnowledgeBase {
  /** @param {{file?:string|null, config?:object}} opts  file=null → jen v paměti (testy, dočasně). */
  constructor({ file = null, config = {} } = {}) {
    this.file = file;
    this.cfg = (config && config.learning) || {};
    this.error = null;
    this.data = this._load();
  }

  _load() {
    if (!this.file || !fs.existsSync(this.file)) return emptyKb();
    try {
      return migrate(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (e) {
      this.error = `Knowledge Base nelze načíst: ${e.message}`;
      return emptyKb();
    }
  }

  available() { return !this.error; }

  save() {
    if (this.error) throw new Error(this.error);
    this.data.updatedAt = nowIso();
    if (!this.file) return { saved: true, storage: 'paměť (bez souboru)' };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return { saved: true, storage: `lokální soubor data/kb/${path.basename(this.file)}` };
  }

  log(action, ref) {
    this.data.log.push({ at: nowIso(), action, ref });
    if (this.data.log.length > 300) this.data.log.splice(0, this.data.log.length - 300);
  }

  getSet(id) {
    if (!id || id === DEFAULT_SET.id) return DEFAULT_SET;
    const s = this.data.aspectSets[id];
    return s && !validateSet(s).length ? s : null;
  }

  putSet(set) {
    if (set.id === DEFAULT_SET.id) return;
    const errs = validateSet(set);
    if (errs.length) throw new Error(`H-sestavu nelze uložit: ${errs.join(' ')}`);
    if (!this.data.aspectSets[set.id]) this.data.aspectSets[set.id] = clone(set);
  }

  recordExperience(exp) {
    const rec = { id: newId('EXP'), at: nowIso(), ...clone(exp) };
    this.data.experiences.push(rec);
    const max = Math.max(50, this.cfg.maxExperiences || 1000);
    if (this.data.experiences.length > max) this.data.experiences.splice(0, this.data.experiences.length - max);
    this.log('experience', rec.id);
    return rec;
  }

  recommendation(id) {
    return this.data.recommendations.find((r) => r.id === id) || null;
  }

  /** Nový kandidát, nebo (při shodě sestavy a podmínek použitelnosti) jen evidence dalšího návrhu. Návrh sám důvěru nezvyšuje. */
  upsertRecommendation(h) {
    this.putSet(h.candidateSet);
    const key = `${h.candidateSet.hash}|${canonicalJson(h.applicability)}`;
    const existing = this.data.recommendations.find((r) => r.key === key);
    const proposal = { at: nowIso(), runId: h.origin.runId, simulated: !!h.origin.simulated, signal: h.signal || null };
    if (existing) {
      existing.proposals.push(proposal);
      existing.updatedAt = nowIso();
      this.log('proposal', existing.id);
      return { rec: existing, isNew: false };
    }
    const rec = {
      id: newId('REC'),
      key,
      version: 1,
      kind: h.kind,
      change: clone(h.change),
      changeText: h.changeText,
      baseSet: setRef(h.baseSet),
      candidateSet: setRef(h.candidateSet),
      applicability: clone(h.applicability),
      originProfile: clone(h.originProfile),
      rationale: h.rationale,
      origin: clone(h.origin),
      proposals: [proposal],
      evidence: { comparisons: [], observations: [] },
      status: 'candidate',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.data.recommendations.push(rec);
    this.log('candidate', rec.id);
    return { rec, isNew: true };
  }

  hasComparison(baseRunId, candidateSetHash) {
    return this.data.comparisons.some((c) => c.baseRunId === baseRunId && c.candidateSet.hash === candidateSetHash);
  }

  /** Řízené srovnání; přepočítá stav doporučení (jen započitatelná reálná srovnání). */
  recordComparison(cmp) {
    const row = { id: newId('CMP'), at: nowIso(), ...clone(cmp) };
    this.data.comparisons.push(row);
    const rec = this.recommendation(cmp.recommendationId);
    if (rec) {
      const before = rec.status;
      rec.evidence.comparisons.push({ comparisonId: row.id, baseRunId: row.baseRunId, experimentRunId: row.experimentRunId, effect: row.effect, counted: row.counted, simulated: row.simulated, quality: row.quality, at: row.at });
      rec.status = computeStatus(rec, { verifyMinWins: this.cfg.verifyMinWins });
      rec.updatedAt = nowIso();
      row.statusChange = { from: before, to: rec.status };
    }
    this.log('comparison', row.id);
    return row;
  }

  /** Nekontrolované pozorování při aktivním použití doporučení (může důvěru jen snížit). */
  recordObservation(recId, obs) {
    const rec = this.recommendation(recId);
    if (!rec) return null;
    const before = rec.status;
    const row = { at: nowIso(), ...clone(obs) };
    rec.evidence.observations.push(row);
    rec.status = computeStatus(rec, { verifyMinWins: this.cfg.verifyMinWins });
    rec.updatedAt = nowIso();
    this.log('observation', rec.id);
    return { ...row, statusChange: { from: before, to: rec.status } };
  }

  /**
   * Výběr H-sestavy pro nový profil. Aktivně se použije JEN „ověřené“ doporučení se silnou shodou charakteristiky.
   * Ostatní související doporučení se vypíší jako „doporučeno, nepoužito“ s důvodem.
   */
  select(profile, { mode = 'auto' } = {}) {
    const rows = [];
    for (const rec of this.data.recommendations) {
      const sat = satisfies(profile, rec.applicability);
      const match = compareProfiles(profile, { features: rec.originProfile });
      if (!match.keyMatch && !sat.ok) continue; // nesouvisející úloha — nezobrazuje se ani nepřebírá
      const set = this.getSet(rec.candidateSet.id);
      let whyNot = null;
      if (!sat.ok) whyNot = `Nesplněny podmínky použitelnosti: ${sat.misses.join('; ')}.`;
      else if (match.level !== 'strong') whyNot = `Charakteristika se liší ve více znacích (${match.mismatched.map((m) => m.label).join(', ')}).`;
      else if (rec.status !== 'verified') whyNot = `Stav „${STATUS_LABEL[rec.status]}“ — aktivně se používá jen ověřená zkušenost.`;
      else if (!set) whyNot = 'H-sestava doporučení v KB chybí nebo je neplatná.';
      else if (mode === 'default') whyNot = 'Uživatel pro tento běh zvolil výchozí sestavu.';
      rows.push({ rec, set, sat, match, eligible: !whyNot, whyNot, t: tally(rec) });
    }
    rows.sort((a, b) => (b.eligible - a.eligible) || (STATUS_RANK[b.rec.status] - STATUS_RANK[a.rec.status]) || (b.t.wins - a.t.wins) || String(b.rec.updatedAt).localeCompare(String(a.rec.updatedAt)));
    const chosen = rows.find((r) => r.eligible) || null;
    const candidates = rows.slice(0, 8).map((r) => ({
      recommendationId: r.rec.id,
      kind: r.rec.kind,
      changeText: r.rec.changeText,
      candidateSet: r.rec.candidateSet,
      status: r.rec.status,
      statusLabel: STATUS_LABEL[r.rec.status],
      evidence: evidenceText(r.rec),
      matchLevel: r.match.level,
      matched: r.match.matched.map((m) => `${m.label}: ${m.a}`),
      mismatched: r.match.mismatched.map((m) => `${m.label}: ${m.a} (zkušenost: ${m.b})`),
      applied: chosen === r,
      whyNot: chosen === r ? null : (r.whyNot || 'Vybráno jiné, lépe doložené doporučení (v jednom běhu se mění jen jedna sestava).'),
    }));
    if (!chosen) {
      return {
        mode: 'default', set: DEFAULT_SET, appliedRecommendationId: null, candidates,
        reason: this.error ? `${this.error} Použita bezpečná výchozí sestava.`
          : candidates.length ? 'Žádná související zkušenost není ověřená a použitelná — použita bezpečná výchozí sestava.'
            : 'Pro tuto charakteristiku nejsou v KB žádné zkušenosti — použita bezpečná výchozí sestava.',
      };
    }
    return {
      mode: 'applied', set: chosen.set, appliedRecommendationId: chosen.rec.id, candidates,
      reason: `Použita ověřená zkušenost ${chosen.rec.id} (${chosen.rec.changeText}); ${evidenceText(chosen.rec)}. Shoda charakteristiky: ${chosen.match.matched.length} znaků shodných, ${chosen.match.mismatched.length} odlišných.`,
    };
  }

  summary() {
    return {
      schemaVersion: this.data.schemaVersion,
      available: this.available(),
      error: this.error,
      storage: this.file ? 'data/kb (lokálně, mimo Git)' : 'paměť',
      updatedAt: this.data.updatedAt,
      counts: { experiences: this.data.experiences.length, recommendations: this.data.recommendations.length, comparisons: this.data.comparisons.length, aspectSets: Object.keys(this.data.aspectSets).length },
      recommendations: this.data.recommendations.map((r) => ({
        id: r.id, kind: r.kind, changeText: r.changeText, status: r.status, statusLabel: STATUS_LABEL[r.status], evidence: evidenceText(r), tally: tally(r),
        candidateSet: r.candidateSet, baseSet: r.baseSet, applicability: r.applicability, rationale: r.rationale,
        originRunId: r.origin.runId, originSimulated: !!r.origin.simulated, proposals: r.proposals.length, createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
      comparisons: this.data.comparisons.slice(-30).reverse().map((c) => ({ id: c.id, at: c.at, recommendationId: c.recommendationId, baseRunId: c.baseRunId, experimentRunId: c.experimentRunId, quality: c.quality, effect: c.effect, counted: c.counted, simulated: c.simulated, note: c.note })),
      aspectSets: Object.values(this.data.aspectSets).map((s) => ({ id: s.id, version: s.version, hash: s.hash, label: s.label, aspects: s.aspects.map((a) => a.id), floors: s.floors, caps: s.caps, parent: s.parent })),
    };
  }
}

module.exports = { KnowledgeBase, computeStatus, tally, evidenceText, migrate, KB_SCHEMA, STATUS_LABEL, STATUS_RANK, MIN_VERIFY_WINS };
