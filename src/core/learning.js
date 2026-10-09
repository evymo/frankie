'use strict';
/**
 * Učicí smyčka — čisté deterministické funkce (bez AI):
 *  1) diagnoseBranch: příčina každé odchylky (oprávnění/schopnost, chybějící vstup, chyba exekuce,
 *     podezření na vadu hodnotitele, nedostupné ověření, simulace, interpretace/strategie);
 *  2) proposeHypotheses: kandidátní změny H-sestavy — JEN z příčiny „interpretace/strategie“ (obohacení),
 *     nebo z reálného úspěchu (redukce hledisek, která se do promptu nepropsala);
 *  3) compareExperiment: řízené srovnání proti stejnému zamčenému Goal Contract, kritériím a hodnotiteli.
 * Z neúspěchu se nikdy automaticky neusuzuje, že všechna použitá H byla špatná.
 */
const { sha256, canonicalJson } = require('./util');
const { ASPECT_CATALOG } = require('./aspects');
const { deriveSet, describeChange } = require('./aspectSets');
const { detectLanguage } = require('./profile');
const { evaluatorOf } = require('./evaluator');

const CAUSES = {
  permission_or_capability: { label: 'oprávnění / nedostupná schopnost', hFeedback: false },
  missing_input: { label: 'nedostatečné vstupy', hFeedback: false },
  execution_error: { label: 'chyba exekuce', hFeedback: false },
  evaluator_suspect: { label: 'podezření na vadu hodnotitele', hFeedback: false },
  evaluation_unavailable: { label: 'ověření neproběhlo', hFeedback: false },
  simulation: { label: 'simulace (mock) — není důkaz', hFeedback: false },
  interpretation_or_strategy: { label: 'interpretace / analytická strategie', hFeedback: true },
};

const SIGNAL_OF_TYPE = {
  max_words: 'format', min_words: 'format', json_valid: 'format', json_schema: 'format', json_equals: 'format', json_rows_subset: 'format',
  regex: 'format', contains: 'format', not_contains: 'format', code_artifact_present: 'format', nonempty: 'format',
  js_function_tests: 'tests', number_equals: 'tests', semantic: 'semantic_goal',
};
const SIGNAL_LABEL = { format: 'formální omezení / formát', tests: 'testy / přesný výpočet', semantic_goal: 'sémantické naplnění cíle', language: 'jazyk odpovědi' };

function lastAttempt(branch) {
  return branch.attempts[branch.attempts.length - 1];
}

function criticalMissing(gate0) {
  return (gate0 && gate0.aspects || []).filter((a) => ['H3', 'H4'].includes(a.id)).flatMap((a) => (a.missingInfo || []).filter((m) => m.critical).map((m) => m.item));
}

function causeOf(row, { contract, execution, gate0 }) {
  const crit = contract.successCriteria.find((x) => x.id === row.criterionId);
  const type = crit ? crit.verification.type : 'semantic';
  const R = (cause, reason) => ({ cause, reason, type });
  if (execution.status === 'error') return R('execution_error', `Exekuce selhala: ${execution.error || 'bez výsledku'}.`);
  if (row.criterionId === 'SYS-2') return R('execution_error', 'Vykonávací model vykázal blokovanou operaci (SYS-2) — bezpečnostní problém pro člověka, ne pro H-sestavu.');
  if (type === 'blocked_scope') {
    const ops = contract.blockedOperations || [];
    if (ops.length && ops.every((o) => o.literalSupport === false)) return R('evaluator_suspect', 'SYS-4: blokovaná operace nemá doslovnou oporu v zadání — známé falešné hodnocení (PASSPORT v0.3.1 §6.1).');
    return R('permission_or_capability', 'Zadání požaduje operaci mimo oprávnění — změna analytické sestavy to nevyřeší.');
  }
  if (row.result === 'UNVERIFIED' && row.simulated) return R('simulation', 'Sémantické hodnocení bylo jen simulované (mock).');
  if (row.downgradedFrom === 'PASS') return R('evaluator_suspect', 'Hodnotitel uvedl PASS, ale jeho citace nebyla ve výstupu nalezena — nelze odlišit vadu výstupu od vady hodnocení.');
  if (row.result === 'UNVERIFIED') return R('evaluation_unavailable', row.evidence || 'Kritérium nebylo možné ověřit.');
  if (row.simulated) return R('simulation', 'Nesplnění určil simulovaný (mock) hodnotitel.');
  if (['blocked', 'unsupported'].includes(execution.status) || (type === 'semantic' && (contract.unavailableCapabilities || []).length)) {
    return R('permission_or_capability', `Úloha naráží na nedostupné schopnosti nebo blokaci (${(contract.unavailableCapabilities || []).join(', ') || execution.status}).`);
  }
  const missing = criticalMissing(gate0);
  if (type === 'semantic' && missing.length) return R('missing_input', `Gate 0 evidovala kritické chybějící vstupy (${missing.slice(0, 3).join('; ')}).`);
  return R('interpretation_or_strategy', 'Obsahové kritérium nesplněno při dostupných vstupech i oprávněních.');
}

/** Diagnóza poslední verifikace větve. */
function diagnoseBranch({ run, branch }) {
  const contract = run.contracts.find((c) => c.id === branch.contractId);
  const att = lastAttempt(branch);
  const execution = att.execution;
  const verification = att.verification;
  const simulated = !!(run.provider && run.provider.simulated);
  const items = [];
  for (const row of verification.criteria) {
    if (row.result === 'PASS') continue;
    if (!row.mandatory && row.result !== 'FAIL') continue;
    const c = causeOf(row, { contract, execution, gate0: run.gate0 });
    items.push({ criterionId: row.criterionId, mandatory: row.mandatory, result: row.result, checkType: c.type, cause: c.cause, causeLabel: CAUSES[c.cause].label, reason: c.reason, signal: c.cause === 'interpretation_or_strategy' ? (SIGNAL_OF_TYPE[c.type] || null) : null });
  }
  const signals = Array.from(new Set(items.filter((i) => i.mandatory && i.signal).map((i) => i.signal)));
  const language = { prompt: detectLanguage(run.input.prompt), output: execution.output ? detectLanguage(execution.output) : null };
  if (signals.length && language.output && language.output !== language.prompt && String(execution.output).length >= 20) signals.push('language');
  const mandatoryItems = items.filter((i) => i.mandatory);
  const counts = {};
  for (const i of mandatoryItems) counts[i.cause] = (counts[i.cause] || 0) + 1;
  const hFeedback = mandatoryItems.some((i) => CAUSES[i.cause].hFeedback);
  let summary;
  if (verification.verdict === 'PASS') summary = 'Všechna povinná kritéria splněna.';
  else if (!mandatoryItems.length) summary = 'Povinná kritéria bez odchylky; odchylky jen u volitelných.';
  else if (hFeedback) summary = `Část odchylek připisuje FR interpretaci / analytické strategii (${signals.map((s) => SIGNAL_LABEL[s]).join(', ') || 'bez specifického signálu'}); ostatní příčiny H-sestavě nepřipisuje.`;
  else summary = `Odchylky mají vnější příčinu (${Object.keys(counts).map((k) => CAUSES[k].label).join(', ')}) — H-sestavě se nepřipisují.`;
  return {
    branchId: branch.id, contractId: contract.id, verdict: verification.verdict, evaluator: evaluatorOf(verification),
    evidenceGrade: simulated ? 'simulated' : 'real', items, counts, hFeedback, signals, language, summary,
  };
}

function applicabilityFor(profile, signal) {
  const f = profile.features;
  const requires = {};
  if (signal === 'format') {
    const c = f.constraints.filter((x) => ['length', 'format'].includes(x));
    if (c.length) requires.constraints = c;
  }
  if (signal === 'tests') requires.verifiability = ['deterministic'];
  if (signal === 'language') requires.language = [f.language];
  return { key: { kind: f.kind, artifact: f.artifact }, requires };
}

/**
 * Kandidátní změny H-sestavy (max. 2 na běh, každá = jedna řízená změna).
 * Obohacení jen z příčiny „interpretace/strategie“; redukce jen z reálného úspěchu.
 */
function proposeHypotheses({ diagnoses, profile, aspectSet, gate0, runId, simulated }) {
  const out = [];
  const seen = new Set();
  const origin = { runId, simulated: !!simulated, causes: diagnoses.flatMap((d) => d.items.filter((i) => i.mandatory).map((i) => i.cause)) };
  const push = (kind, change, signal, rationale) => {
    const k = canonicalJson(change);
    if (seen.has(k) || out.length >= 2) return;
    seen.add(k);
    const candidateSet = deriveSet(aspectSet, change, { kind: 'hypothesis', runId, signal });
    out.push({ kind, change, changeText: describeChange(change), signal, rationale, baseSet: aspectSet, candidateSet, applicability: applicabilityFor(profile, signal), originProfile: profile.features, origin: { ...origin, signal } });
  };
  const fb = diagnoses.filter((d) => d.hFeedback);
  for (const signal of ['format', 'tests', 'semantic_goal', 'language']) {
    const ds = fb.filter((d) => d.signals.includes(signal));
    if (!ds.length) continue;
    const crits = ds.flatMap((d) => d.items.filter((i) => i.signal === signal).map((i) => `${d.branchId}/${i.criterionId} (${i.checkType})`));
    const def = ASPECT_CATALOG.find((a) => a.signal === signal);
    if (!def) continue;
    const inSet = aspectSet.aspects.some((a) => a.id === def.id);
    const why = `Hypotéza z diagnózy běhu ${runId}: nesplněno ${crits.join(', ') || SIGNAL_LABEL[signal]} s příčinou „interpretace / analytická strategie“. ${def.origin}`;
    if (!inSet) push('enrichment', { add: [def.id] }, signal, `${why} Návrh: přidat hledisko ${def.id} „${def.name}“ (${def.question})`);
    else if ((aspectSet.floors || {})[def.id] !== 'P1' && (aspectSet.floors || {})[def.id] !== 'P0') push('enrichment', { floor: { [def.id]: 'P1' } }, signal, `${why} Hledisko ${def.id} už sestava obsahuje — návrh: zvýšit jeho minimální prioritu na P1, aby se vždy propsalo do Execution Contract.`);
  }
  const allPass = diagnoses.length && diagnoses.every((d) => d.verdict === 'PASS');
  if (!out.length && allPass && !simulated && gate0) {
    const unused = gate0.aspects.filter((a) => a.kind === 'adaptive' && a.finalPriority === 'P3' && !(aspectSet.floors || {})[a.id]).map((a) => a.id);
    if (unused.length) {
      push('reduction', { remove: unused }, 'reduction', `Úspěšný reálný běh ${runId}: adaptivní hlediska ${unused.join(', ')} skončila s prioritou P3 a do Execution Contract se nepropsala. Hypotéza: stejná kvalita s menší analytickou režií. Ověří jen řízené srovnání (shodná kvalita + méně hledisek).`);
    }
  }
  return out;
}

const RESULT_RANK = { PASS: 2, UNVERIFIED: 1, FAIL: 0 };

function criteriaHash(contract) {
  return sha256(canonicalJson(contract.successCriteria.filter((c) => c.mandatory).map((c) => ({ id: c.id, description: c.description, verification: c.verification }))));
}

function gate0Usage(run) {
  const calls = (run.telemetry && run.telemetry.calls || []).filter((c) => c.task === 'gate0' && c.status === 'ok');
  return calls.length ? { inputTokens: calls[calls.length - 1].inputTokens, outputTokens: calls[calls.length - 1].outputTokens } : null;
}

/**
 * Řízené srovnání: původní běh (základní sestava) vs. experimentální běh (kandidátní sestava) nad TÝMŽ zamčeným
 * Goal Contract. Započítá se jen reálné srovnání se shodnými podmínkami a bez vnější příčiny odchylek.
 */
function compareExperiment({ baseRun, expRun, rec }) {
  const lockedId = expRun.experiment.lockedContract.id;
  const bb = baseRun.branches.find((b) => b.contractId === lockedId);
  const eb = expRun.branches.find((b) => b.contractId === lockedId);
  const bc = baseRun.contracts.find((c) => c.id === lockedId);
  const ec = expRun.contracts.find((c) => c.id === lockedId);
  const bv = lastAttempt(bb).verification;
  const ev = lastAttempt(eb).verification;
  const bcp = lastAttempt(bb).compiledPrompt;
  const ecp = lastAttempt(eb).compiledPrompt;
  const conditions = {
    sameGoalContract: bc.contentHash === ec.contentHash,
    sameMandatoryCriteria: criteriaHash(bc) === criteriaHash(ec),
    sameEvaluator: evaluatorOf(bv) === evaluatorOf(ev),
    sameTemplates: !!(bcp && ecp && bcp.template.version === ecp.template.version && baseRun.gate0.template.version === expRun.gate0.template.version),
    sameProviderModel: baseRun.provider.id === expRun.provider.id && baseRun.provider.model === expRun.provider.model,
    baseUsedBaseSet: !!(baseRun.gate0.aspectSet && baseRun.gate0.aspectSet.hash === rec.baseSet.hash),
    expUsedCandidateSet: !!(expRun.gate0.aspectSet && expRun.gate0.aspectSet.hash === rec.candidateSet.hash),
  };
  const perCriterion = bv.criteria.filter((c) => c.mandatory).map((c) => {
    const e = ev.criteria.find((x) => x.criterionId === c.criterionId);
    return { criterionId: c.criterionId, base: c.result, experiment: e ? e.result : 'MISSING' };
  });
  const improved = perCriterion.filter((p) => (RESULT_RANK[p.experiment] ?? -1) > (RESULT_RANK[p.base] ?? -1)).map((p) => p.criterionId);
  const regressed = perCriterion.filter((p) => (RESULT_RANK[p.experiment] ?? -1) < (RESULT_RANK[p.base] ?? -1)).map((p) => p.criterionId);
  const quality = improved.length && !regressed.length ? 'better' : regressed.length && !improved.length ? 'worse' : improved.length ? 'mixed' : 'equal';
  const simulated = !!(baseRun.provider.simulated || expRun.provider.simulated);
  const external = [baseRun, expRun].flatMap((r) => (r.learning && r.learning.diagnosis || []).filter((d) => d.contractId === lockedId))
    .flatMap((d) => d.items.filter((i) => i.mandatory && ['permission_or_capability', 'execution_error', 'evaluator_suspect', 'evaluation_unavailable'].includes(i.cause)));
  const fewerAspects = expRun.gate0.aspects.length < baseRun.gate0.aspects.length;
  let effect = 'neutral';
  if (rec.kind === 'reduction') effect = quality === 'worse' || quality === 'mixed' ? (quality === 'worse' ? 'against' : 'neutral') : fewerAspects ? 'support' : 'neutral';
  else effect = quality === 'better' ? 'support' : quality === 'worse' ? 'against' : 'neutral';
  const failedConditions = Object.entries(conditions).filter(([, v]) => !v).map(([k]) => k);
  const counted = !simulated && !failedConditions.length && !external.length;
  let note;
  if (simulated) note = 'SIMULACE (mock): srovnání prověřuje jen mechanismus — do důvěryhodnosti se nezapočítává a nedokládá kvalitativní převahu.';
  else if (failedConditions.length) note = `Nezapočitatelné — liší se podmínky: ${failedConditions.join(', ')}.`;
  else if (external.length) note = `Nezapočitatelné — odchylky mají vnější příčinu (${Array.from(new Set(external.map((i) => i.causeLabel))).join(', ')}).`;
  else note = `Započítáno jako ${effect === 'support' ? 'podpora' : effect === 'against' ? 'vyvrácení' : 'bez rozdílu'} doporučení.`;
  return {
    recommendationId: rec.id, recommendationKind: rec.kind,
    baseRunId: baseRun.id, experimentRunId: expRun.id,
    lockedContract: { id: lockedId, contentHash: bc.contentHash }, mandatoryCriteriaHash: criteriaHash(bc),
    evaluator: { base: evaluatorOf(bv), experiment: evaluatorOf(ev) },
    baseSet: rec.baseSet, candidateSet: rec.candidateSet,
    verdicts: { base: bv.verdict, experiment: ev.verdict },
    perCriterion, improved, regressed, quality,
    cost: { baseAspects: baseRun.gate0.aspects.length, experimentAspects: expRun.gate0.aspects.length, baseGate0: gate0Usage(baseRun), experimentGate0: gate0Usage(expRun) },
    conditions, simulated, counted, effect, note,
  };
}

/** Pozorování při aktivním použití doporučení (bez kontrolní skupiny): důvěru může jen snížit. */
function observationFor({ run, diagnoses, recId }) {
  const simulated = !!run.provider.simulated;
  const strategyFail = diagnoses.some((d) => d.hFeedback);
  return {
    runId: run.id, recommendationId: recId, simulated,
    verdicts: diagnoses.map((d) => `${d.branchId}: ${d.verdict}`),
    effect: !simulated && strategyFail ? 'warning' : 'none',
    note: simulated ? 'Simulace — bez vlivu na důvěryhodnost.'
      : strategyFail ? 'Při použití doporučení selhala obsahová kritéria z příčiny interpretace/strategie — varovný signál (snižuje důvěru).'
        : 'Bez varovného signálu. Úspěch bez kontrolní skupiny důvěru NEZVYŠUJE (korelace není důkaz).',
  };
}

module.exports = { diagnoseBranch, proposeHypotheses, compareExperiment, observationFor, criteriaHash, CAUSES, SIGNAL_LABEL };
