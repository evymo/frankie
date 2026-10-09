'use strict';
/**
 * Goal Audit: zpracování nezávislého auditu (izolované volání bez H1) a kvalitativní porovnání
 * explicitního cíle, H1 a auditovaného cíle. Původ každého štítku vztahu je evidován:
 * „algorithm“ (shodné normalizované znění) nebo „model“ (sémantický úsudek).
 */
const { isQuoteIn, clone, normalizeForMatch } = require('./util');
const { normalizeCriterion } = require('./criteria');

function processAudit(modelOut, { prompt }) {
  const a = clone(modelOut);
  return {
    ...a,
    evidence: (a.evidence || []).map((q) => ({ quote: q, verified: isQuoteIn(q, prompt) })),
    acceptanceCriteria: (a.acceptanceCriteria || []).map((c, i) => normalizeCriterion(c, `AC-${i + 1}`, 'audit_model')),
    explicitGoalCriteria: (a.explicitGoalCriteria || []).map((c, i) => normalizeCriterion(c, `EC-${i + 1}`, 'audit_model')),
    raw: clone(modelOut),
  };
}

const LABELS = { explicit: 'explicitní cíl uživatele', h1: 'definice cíle z H1', audit: 'nezávisle auditovaný cíl' };

/** Které dvojice je třeba porovnat a které rozhodne algoritmus sám (doslovná shoda po normalizaci). */
function planComparison({ explicitGoal, h1Statement, auditStatement }) {
  const goals = { explicit: explicitGoal || null, h1: h1Statement, audit: auditStatement };
  const wanted = explicitGoal ? [['explicit', 'audit'], ['explicit', 'h1'], ['h1', 'audit']] : [['h1', 'audit']];
  const algorithmic = [];
  const forModel = [];
  for (const [x, y] of wanted) {
    const pair = `${x}_vs_${y}`;
    if (normalizeForMatch(goals[x]) === normalizeForMatch(goals[y])) {
      algorithmic.push({ pair, relation: 'EQUIVALENT', differences: [], rationale: 'Normalizované znění je totožné.', origin: 'algorithm' });
    } else {
      forModel.push({ pair, a: goals[x], b: goals[y], aLabel: LABELS[x], bLabel: LABELS[y] });
    }
  }
  return { goals, algorithmic, forModel };
}

/** Sloučí výsledky; konzistenční pravidlo: kritický rozdíl ⇒ vztah nejméně CRITICAL_CONFLICT. */
function mergeComparison(plan, modelOut) {
  const consistency = [];
  const byPair = new Map((modelOut && modelOut.pairs || []).map((p) => [p.pair, p]));
  const pairs = [...plan.algorithmic];
  for (const fm of plan.forModel) {
    const m = byPair.get(fm.pair);
    if (!m) {
      pairs.push({ pair: fm.pair, relation: 'UNCLEAR', differences: [], rationale: 'Model tuto dvojici nevrátil.', origin: 'algorithm_fallback' });
      consistency.push({ pair: fm.pair, rule: 'Chybějící posouzení ⇒ UNCLEAR' });
      continue;
    }
    const p = { ...clone(m), origin: 'model' };
    if ((p.differences || []).some((d) => d.critical) && p.relation !== 'CRITICAL_CONFLICT') {
      consistency.push({ pair: p.pair, from: p.relation, to: 'CRITICAL_CONFLICT', rule: 'Kritický rozdíl ⇒ CRITICAL_CONFLICT' });
      p.relation = 'CRITICAL_CONFLICT';
      p.origin = 'model+algorithm_consistency';
    }
    pairs.push(p);
  }
  const order = ['explicit_vs_audit', 'explicit_vs_h1', 'h1_vs_audit'];
  pairs.sort((x, y) => order.indexOf(x.pair) - order.indexOf(y.pair));
  return { goals: plan.goals, pairs, consistency };
}

function relationOf(comparison, pair) {
  const p = comparison.pairs.find((x) => x.pair === pair);
  return p ? p.relation : null;
}

module.exports = { processAudit, planComparison, mergeComparison, relationOf, LABELS };
