'use strict';
/**
 * Knowledge Base (KB) — sdílené zkušenosti o účinnosti H-sestav.
 *
 * Úložiště (fr-kb/2): adresář knowledge/ v repozitáři, JEDEN SOUBOR NA ZÁZNAM, záznamy se nikdy nepřepisují
 * (append-only). Kolegové si zkušenosti vyměňují přes git pull/push bez konfliktů: každý záznam má jedinečné ID,
 * stav důvěryhodnosti se neukládá, ale dopočítá se při načtení (computeStatus) ze všech srovnání a pozorování.
 * Doporučení se stejnou sestavou a podmínkami použitelnosti (vzniklá nezávisle u různých lidí) se při načtení
 * sloučí pod nejstarší záznam.
 *
 * Repozitář je VEŘEJNÝ — KB ukládá jen METODU: kategorický profil úlohy, H-sestavy, diagnózu (ID kritérií,
 * typy kontrol, třídy příčin), kandidáty, řízená srovnání a pozorování. Neukládá text zadání, výstupy ani hash
 * zadání; běh je jen ID. Do nové úlohy se tak nemůže přenést faktický obsah cizí úlohy.
 *
 * Důvěryhodnost doporučení zvyšují VÝHRADNĚ reálná řízená srovnání proti stejnému zamčenému Goal Contract,
 * stejným kritériím a stejné verzi hodnotitele. Simulace (mock) se eviduje, ale nezapočítává.
 * Nekontrolovaná pozorování mohou důvěru jen snížit (korelace není důkaz zlepšení).
 */
const fs = require('fs');
const path = require('path');
const { nowIso, newId, canonicalJson, clone } = require('./util');
const { DEFAULT_SET, validateSet, setRef } = require('./aspectSets');
const { compareProfiles, satisfies } = require('./profile');

const KB_SCHEMA = 'fr-kb/2';
const LEGACY_SCHEMA = 'fr-kb/1';
const KINDS = { sets: 'sets', recommendations: 'recommendations', proposals: 'proposals', experiences: 'experiences', comparisons: 'comparisons', observations: 'observations' };
const STATUS_RANK = { verified: 4, supported: 3, candidate: 2, contested: 1, refuted: 0 };
const STATUS_LABEL = {
  candidate: 'kandidát (hypotéza, neověřeno)',
  supported: 'předběžně podpořeno (1 reálné srovnání)',
  verified: 'ověřeno opakovaným reálným srovnáním',
  contested: 'sporné (protichůdné nebo varovné důkazy)',
  refuted: 'vyvráceno',
};
const MIN_VERIFY_WINS = 2; // tvrdé minimum: jediný úspěch nikdy není „ověřeno“
const ID_RE = /^[A-Za-z0-9-]+$/;

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

function emptyData() {
  // recDefs = uložené definice doporučení; recommendations = odvozený, sloučený pohled se stavem
  return { schemaVersion: KB_SCHEMA, aspectSets: {}, experiences: [], recDefs: [], recommendations: [], proposals: [], comparisons: [], observations: [], aliases: {} };
}

/** Odstraní z experience údaje, které do veřejného repozitáře nepatří. */
function sanitizeExperience(exp) {
  const e = clone(exp);
  delete e.promptSha256;
  return e;
}

class KnowledgeBase {
  /**
   * @param {{dir?:string|null, config?:object}} opts  dir = adresář knowledge/ (null → jen v paměti: testy, dočasně).
   */
  constructor({ dir = null, config = {} } = {}) {
    this.dir = dir;
    this.cfg = (config && config.learning) || {};
    this.error = null;
    this.pending = [];
    this.manifest = null;
    this.data = emptyData();
    this.reload();
  }

  available() { return !this.error; }

  /* ---------- úložiště: jeden soubor na záznam ---------- */
  _file(kind, id) {
    if (!ID_RE.test(String(id))) throw new Error(`Neplatné ID záznamu KB: ${id}`);
    return path.join(this.dir, kind, `${id}.json`);
  }

  _readKind(kind) {
    const d = path.join(this.dir, kind);
    if (!fs.existsSync(d)) return [];
    const out = [];
    for (const n of fs.readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
      try { out.push(JSON.parse(fs.readFileSync(path.join(d, n), 'utf8'))); } catch (e) { throw new Error(`Poškozený záznam ${kind}/${n}: ${e.message}`); }
    }
    return out;
  }

  /** Znovu načte KB z disku (např. po git pull kolegy). Neuložené záznamy v paměti se zachovají. */
  reload() {
    this.error = null;
    if (!this.dir) { this._assemble(this.data); return; }
    try {
      const mf = path.join(this.dir, 'kb.json');
      this.manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : null;
      if (this.manifest && this.manifest.schemaVersion !== KB_SCHEMA) throw new Error(`Neznámá verze Knowledge Base „${this.manifest.schemaVersion}“ — KB se nepoužije ani nepřepíše.`);
      const raw = emptyData();
      for (const s of this._readKind(KINDS.sets)) raw.aspectSets[s.id] = s;
      raw.recDefs = this._readKind(KINDS.recommendations);
      raw.proposals = this._readKind(KINDS.proposals);
      raw.experiences = this._readKind(KINDS.experiences);
      raw.comparisons = this._readKind(KINDS.comparisons);
      raw.observations = this._readKind(KINDS.observations);
      for (const p of this.pending) this._mergeRecord(raw, p.kind, p.record);
      this._assemble(raw);
      this.data = raw;
    } catch (e) {
      this.error = `Knowledge Base nelze načíst: ${e.message}`;
      this.data = emptyData();
      this._assemble(this.data);
    }
  }

  _mergeRecord(raw, kind, rec) {
    if (kind === KINDS.sets) { raw.aspectSets[rec.id] = rec; return; }
    const list = kind === KINDS.recommendations ? raw.recDefs : raw[kind];
    if (!list.some((x) => x.id === rec.id)) list.push(rec);
  }

  /**
   * Sestaví odvozený pohled: sloučí duplicitní doporučení (stejný klíč), připojí návrhy, srovnání a pozorování
   * a dopočítá stav. Žádný z těchto údajů se neukládá zpět — je vždy odvozený ze záznamů.
   */
  _assemble(raw) {
    raw.aliases = {};
    const byKey = new Map();
    const defs = [...raw.recDefs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    const canon = [];
    for (const d of defs) {
      const c = byKey.get(d.key);
      if (c) { raw.aliases[d.id] = c.id; continue; }
      const r = { ...d, proposals: [], evidence: { comparisons: [], observations: [] }, status: 'candidate' };
      byKey.set(d.key, r);
      canon.push(r);
    }
    const find = (id) => canon.find((r) => r.id === (raw.aliases[id] || id));
    for (const p of raw.proposals) { const r = find(p.recommendationId); if (r) r.proposals.push(p); }
    for (const c of raw.comparisons) {
      const r = find(c.recommendationId);
      if (r) r.evidence.comparisons.push({ comparisonId: c.id, baseRunId: c.baseRunId, experimentRunId: c.experimentRunId, effect: c.effect, counted: c.counted, simulated: c.simulated, quality: c.quality, at: c.at });
    }
    for (const o of raw.observations) { const r = find(o.recommendationId); if (r) r.evidence.observations.push(o); }
    for (const r of canon) {
      r.proposals.sort((a, b) => String(a.at).localeCompare(String(b.at)));
      r.origin = r.proposals[0] ? { runId: r.proposals[0].runId, simulated: !!r.proposals[0].simulated } : (r.origin || { runId: null, simulated: false });
      r.status = computeStatus(r, { verifyMinWins: this.cfg.verifyMinWins });
      r.updatedAt = [r.createdAt, ...r.proposals.map((p) => p.at), ...r.evidence.comparisons.map((c) => c.at), ...r.evidence.observations.map((o) => o.at)].filter(Boolean).sort().pop();
    }
    raw.recommendations = canon;
  }

  _add(kind, record) {
    if (this.error) throw new Error(this.error);
    this.pending.push({ kind, record });
    this._mergeRecord(this.data, kind, record);
    this._assemble(this.data);
  }

  /** Zapíše nové záznamy (každý do vlastního souboru, existující se nepřepisují). */
  save() {
    if (this.error) throw new Error(this.error);
    if (!this.dir) { const n = this.pending.length; this.pending = []; return { saved: true, storage: 'paměť (bez souboru)', written: n }; }
    fs.mkdirSync(this.dir, { recursive: true });
    const mf = path.join(this.dir, 'kb.json');
    if (!fs.existsSync(mf)) {
      fs.writeFileSync(mf, JSON.stringify({ schemaVersion: KB_SCHEMA, description: 'Sdílená Knowledge Base FRANKENSTEIN — jeden soubor na záznam, append-only. Viz knowledge/README.md.', createdAt: nowIso() }, null, 2) + '\n', 'utf8');
    }
    let written = 0;
    for (const { kind, record } of this.pending) {
      const f = this._file(kind, record.id);
      if (fs.existsSync(f)) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(record, null, 2) + '\n', 'utf8');
      fs.renameSync(`${f}.tmp`, f);
      written++;
    }
    this.pending = [];
    return { saved: true, storage: `knowledge/ v repozitáři (${written} nových souborů; sdílení přes git commit + push)`, written };
  }

  /** Jednorázový převod z dřívějšího lokálního souboru data/kb/fr-kb.json (fr-kb/1). Původní soubor se nemění. */
  importLegacy(file) {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old.schemaVersion !== LEGACY_SCHEMA) throw new Error(`Nečekaná verze ${old.schemaVersion}`);
    for (const s of Object.values(old.aspectSets || {})) this.putSet(s);
    for (const e of old.experiences || []) this._add(KINDS.experiences, sanitizeExperience(e));
    for (const r of old.recommendations || []) {
      this._add(KINDS.recommendations, { id: r.id, key: r.key, version: r.version || 1, kind: r.kind, change: r.change, changeText: r.changeText, baseSet: r.baseSet, candidateSet: r.candidateSet, applicability: r.applicability, originProfile: r.originProfile, rationale: r.rationale, createdAt: r.createdAt });
      (r.proposals || []).forEach((p) => this._add(KINDS.proposals, { id: newId('PRP'), recommendationId: r.id, at: p.at, runId: p.runId, simulated: !!p.simulated, signal: p.signal || null }));
      (r.evidence && r.evidence.observations || []).forEach((o) => this._add(KINDS.observations, { id: newId('OBS'), ...clone(o), recommendationId: r.id }));
    }
    for (const c of old.comparisons || []) this._add(KINDS.comparisons, clone(c));
    return this.save();
  }

  /* ---------- záznamy ---------- */
  getSet(id) {
    if (!id || id === DEFAULT_SET.id) return DEFAULT_SET;
    const s = this.data.aspectSets[id];
    return s && !validateSet(s).length ? s : null;
  }

  putSet(set) {
    if (set.id === DEFAULT_SET.id) return;
    const errs = validateSet(set);
    if (errs.length) throw new Error(`H-sestavu nelze uložit: ${errs.join(' ')}`);
    if (!this.data.aspectSets[set.id]) this._add(KINDS.sets, clone(set));
  }

  recordExperience(exp) {
    const rec = { id: newId('EXP'), at: nowIso(), ...sanitizeExperience(exp) };
    this._add(KINDS.experiences, rec);
    return rec;
  }

  recommendation(id) {
    const real = this.data.aliases[id] || id;
    return this.data.recommendations.find((r) => r.id === real) || null;
  }

  /** Nový kandidát, nebo (při shodě sestavy a podmínek použitelnosti) jen evidence dalšího návrhu. Návrh sám důvěru nezvyšuje. */
  upsertRecommendation(h) {
    this.putSet(h.candidateSet);
    const key = `${h.candidateSet.hash}|${canonicalJson(h.applicability)}`;
    let rec = this.data.recommendations.find((r) => r.key === key);
    const isNew = !rec;
    if (isNew) {
      const def = {
        id: newId('REC'), key, version: 1, kind: h.kind, change: clone(h.change), changeText: h.changeText,
        baseSet: setRef(h.baseSet), candidateSet: setRef(h.candidateSet), applicability: clone(h.applicability),
        originProfile: clone(h.originProfile), rationale: h.rationale, createdAt: nowIso(),
      };
      this._add(KINDS.recommendations, def);
      rec = this.recommendation(def.id);
    }
    this._add(KINDS.proposals, { id: newId('PRP'), recommendationId: rec.id, at: nowIso(), runId: h.origin.runId, simulated: !!h.origin.simulated, signal: h.signal || null, rationale: h.rationale });
    return { rec: this.recommendation(rec.id), isNew };
  }

  hasComparison(baseRunId, candidateSetHash) {
    return this.data.comparisons.some((c) => c.baseRunId === baseRunId && c.candidateSet && c.candidateSet.hash === candidateSetHash);
  }

  /** Řízené srovnání; stav doporučení se přepočítá (jen započitatelná reálná srovnání). */
  recordComparison(cmp) {
    const before = (this.recommendation(cmp.recommendationId) || {}).status || null;
    const row = { id: newId('CMP'), at: nowIso(), ...clone(cmp) };
    this._add(KINDS.comparisons, row);
    const rec = this.recommendation(cmp.recommendationId);
    return { ...row, statusChange: rec ? { from: before, to: rec.status } : null };
  }

  /** Nekontrolované pozorování při aktivním použití doporučení (může důvěru jen snížit). */
  recordObservation(recId, obs) {
    const rec = this.recommendation(recId);
    if (!rec) return null;
    const before = rec.status;
    const row = { id: newId('OBS'), at: nowIso(), ...clone(obs), recommendationId: rec.id };
    this._add(KINDS.observations, row);
    return { ...row, statusChange: { from: before, to: this.recommendation(rec.id).status } };
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
      schemaVersion: KB_SCHEMA,
      available: this.available(),
      error: this.error,
      storage: this.dir ? 'knowledge/ v repozitáři (sdílené přes Git, bez textů úloh)' : 'paměť',
      unsaved: this.pending.length,
      counts: { experiences: this.data.experiences.length, recommendations: this.data.recommendations.length, comparisons: this.data.comparisons.length, aspectSets: Object.keys(this.data.aspectSets).length },
      recommendations: this.data.recommendations.map((r) => ({
        id: r.id, kind: r.kind, changeText: r.changeText, status: r.status, statusLabel: STATUS_LABEL[r.status], evidence: evidenceText(r), tally: tally(r),
        candidateSet: r.candidateSet, baseSet: r.baseSet, applicability: r.applicability, rationale: r.rationale,
        originRunId: r.origin.runId, originSimulated: !!r.origin.simulated, proposals: r.proposals.length, createdAt: r.createdAt, updatedAt: r.updatedAt,
      })),
      comparisons: this.data.comparisons.slice(-30).reverse().map((c) => ({ id: c.id, at: c.at, recommendationId: this.data.aliases[c.recommendationId] || c.recommendationId, baseRunId: c.baseRunId, experimentRunId: c.experimentRunId, quality: c.quality, effect: c.effect, counted: c.counted, simulated: c.simulated, note: c.note })),
      aspectSets: Object.values(this.data.aspectSets).map((s) => ({ id: s.id, version: s.version, hash: s.hash, label: s.label, aspects: s.aspects.map((a) => a.id), floors: s.floors, caps: s.caps, parent: s.parent })),
    };
  }
}

module.exports = { KnowledgeBase, computeStatus, tally, evidenceText, sanitizeExperience, KB_SCHEMA, LEGACY_SCHEMA, STATUS_LABEL, STATUS_RANK, MIN_VERIFY_WINS };
