'use strict';
/**
 * Rozhodovací brána A/B/C/D — čistá deterministická funkce nad validovanými strukturami.
 * Vstupem jsou kvalitativní štítky vztahů (žádná procenta ani prahy). Původ štítků je v comparison.pairs[].origin.
 */
const { relationOf } = require('./goalAudit');

const RULES = [
  { id: 'A1', when: 'Bez explicitního cíle; audit: odvoditelný s jistotou ≥ medium; H1↔audit EQUIVALENT/NONCRITICAL', code: 'A', proceed: true },
  { id: 'A2', when: 'Bez explicitního cíle; audit: neodvoditelný nebo nízká jistota', code: 'A', proceed: false },
  { id: 'A3', when: 'Bez explicitního cíle; H1↔audit CRITICAL/UNCLEAR', code: 'D', proceed: false },
  { id: 'D1', when: 'Explicitní cíl; explicit↔audit nebo explicit↔H1 CRITICAL/UNCLEAR', code: 'D', proceed: false },
  { id: 'B1', when: 'Explicitní cíl; explicit↔audit i explicit↔H1 EQUIVALENT', code: 'B', proceed: true },
  { id: 'C1', when: 'Explicitní cíl; alespoň jeden vztah NONCRITICAL, žádný kritický', code: 'C', proceed: true },
];

const BAD = new Set(['CRITICAL_CONFLICT', 'UNCLEAR']);

function diffsOf(comparison, pair) {
  const p = comparison.pairs.find((x) => x.pair === pair);
  return p ? (p.differences || []) : [];
}

function clarificationQuestion(kind, ctx) {
  const { comparison, audit, gate0, explicitGoal } = ctx;
  if (kind === 'not_derivable') {
    const missing = [
      ...(audit.uncertainties || []),
      ...((gate0.aspects.find((a) => a.id === 'H4') || {}).missingInfo || []).filter((m) => m.critical).map((m) => m.item),
    ];
    const uniq = Array.from(new Set(missing)).slice(0, 4);
    return `Cíl zadání nelze spolehlivě odvodit. Upřesněte prosím, jaký konkrétní výsledek očekáváte${uniq.length ? ' — zejména: ' + uniq.map((u, i) => `(${i + 1}) ${u}`).join('; ') : ''}.`;
  }
  const pairs = kind === 'h1_audit' ? ['h1_vs_audit'] : ['explicit_vs_audit', 'explicit_vs_h1'];
  const conflicts = pairs.flatMap((p) => diffsOf(comparison, p).map((d) => d.description));
  const uniq = Array.from(new Set(conflicts)).slice(0, 3);
  const a = kind === 'h1_audit' ? comparison.goals.h1 : explicitGoal;
  const b = comparison.goals.audit;
  return `Zjistil jsem rozpor v cíli${uniq.length ? ': ' + uniq.join('; ') : ''}. Který výsledek očekáváte? (1) „${a}“, nebo (2) „${b}“? Případně cíl popište vlastními slovy.`;
}

/**
 * @returns {{code, rule, proceed, outcome, branches:[{role, basis, authority}], relations, reasons:[], question?}}
 */
function decide({ explicitGoal, audit, comparison, gate0 }) {
  const relations = {
    explicit_vs_audit: relationOf(comparison, 'explicit_vs_audit'),
    explicit_vs_h1: relationOf(comparison, 'explicit_vs_h1'),
    h1_vs_audit: relationOf(comparison, 'h1_vs_audit'),
  };
  const ctx = { comparison, audit, gate0, explicitGoal };
  const res = (ruleId, extra) => {
    const r = RULES.find((x) => x.id === ruleId);
    return { code: r.code, rule: r.id, ruleText: r.when, proceed: r.proceed, outcome: r.proceed ? 'PROCEED' : 'CLARIFICATION_REQUIRED', relations, branches: [], reasons: [], ...extra };
  };

  if (!explicitGoal) {
    const derivable = audit.derivable === true && audit.confidence !== 'low';
    if (!derivable) {
      return res('A2', { reasons: [`Audit: derivable=${audit.derivable}, confidence=${audit.confidence}.`], question: clarificationQuestion('not_derivable', ctx) });
    }
    if (BAD.has(relations.h1_vs_audit)) {
      return res('A3', { reasons: [`H1 ↔ audit: ${relations.h1_vs_audit}.`], question: clarificationQuestion('h1_audit', ctx) });
    }
    return res('A1', {
      reasons: [`Cíl odvozen auditem (jistota ${audit.confidence}); H1 ↔ audit: ${relations.h1_vs_audit}.`],
      branches: [{ role: 'primary', basis: 'audit', authority: 'derived_from_prompt' }],
    });
  }

  const ea = relations.explicit_vs_audit;
  const eh = relations.explicit_vs_h1;
  if (BAD.has(ea) || BAD.has(eh)) {
    return res('D1', { reasons: [`explicit ↔ audit: ${ea}; explicit ↔ H1: ${eh}.`], question: clarificationQuestion('explicit', ctx) });
  }
  if (ea === 'EQUIVALENT' && eh === 'EQUIVALENT') {
    return res('B1', {
      reasons: ['Explicitní cíl je významově shodný s auditem i s H1.'],
      branches: [{ role: 'primary', basis: 'explicit', authority: 'user_explicit' }],
    });
  }
  const altBasis = ea === 'NONCRITICAL_DIFFERENCE' ? 'audit' : 'h1';
  return res('C1', {
    reasons: [`explicit ↔ audit: ${ea}; explicit ↔ H1: ${eh}. Explicitní cíl má vyšší autoritu; alternativa (${altBasis}) se řeší v oddělené větvi.`],
    branches: [
      { role: 'primary', basis: 'explicit', authority: 'user_explicit' },
      { role: 'alternative', basis: altBasis, authority: altBasis === 'audit' ? 'audit_alternative' : 'h1_alternative' },
    ],
  });
}

module.exports = { decide, RULES };
