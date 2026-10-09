'use strict';
/**
 * Gate 0: jedno AI volání pro všech deset hledisek + deterministické zpracování:
 *  - ověření citací (důkazy) proti původnímu zadání,
 *  - H7/H8 přepsány systémovými fakty z konfigurace (AI tvrzení zůstává jen jako „aiClaim“),
 *  - deterministické detektory (injection, citlivá data, operace) → minimální priority,
 *  - dynamické pořadí priorit.
 */
const { ASPECTS, PRIORITIES, maxPriority } = require('./aspects');
const { isQuoteIn, clone } = require('./util');
const { detectInjection, detectSensitiveData, detectOperations } = require('./detectors');
const { TOOLS } = require('../tools');

function placeholderAspect(id) {
  return {
    id, finding: 'Model toto hledisko nevrátil.', priority: 'P1', priorityRationale: 'Chybějící analýza = neznámé riziko.',
    evidence: [], assumptions: [], unknowns: ['Hledisko nebylo analyzováno'], missingInfo: [], recommendation: 'Zpracovat opatrně.',
    scope: '', nonGoals: [], contradictions: [], dependencies: [], dataSensitivity: 'none', missingFromModel: true,
  };
}

/** Systémová fakta o schopnostech a oprávněních — autoritou je konfigurace, ne AI. */
function systemFacts(config, modelOut, detectedOps) {
  const caps = config.capabilities || {};
  const required = Array.from(new Set(modelOut.requiredCapabilities || []));
  const available = required.filter((c) => caps[c] === true);
  const unavailable = required.filter((c) => caps[c] !== true);
  const allowedCats = new Set(config.permissions.allowedOperationCategories);
  const ops = [...(modelOut.requestedOperations || []).map((o) => ({ ...o, source: 'model' })), ...detectedOps];
  const seen = new Set();
  const operations = [];
  for (const o of ops) {
    const key = o.category + '|' + o.operation;
    if (seen.has(key)) continue;
    seen.add(key);
    operations.push({ ...o, allowed: allowedCats.has(o.category) });
  }
  return {
    capabilitiesConfig: caps,
    requiredCapabilities: required,
    availableCapabilities: available,
    unavailableCapabilities: unavailable,
    operations,
    blockedOperations: operations.filter((o) => !o.allowed),
  };
}

/** Validace návrhů deterministických nástrojů: známý nástroj + vstup doslovně v zadání + zkušební běh. */
function validateToolCandidates(candidates, prompt) {
  return (candidates || []).map((c) => {
    const r = { ...c, accepted: false, reason: '' };
    if (!TOOLS[c.tool]) r.reason = 'Neznámý nástroj';
    else if (!c.input || !isQuoteIn(c.input, prompt)) r.reason = 'Vstup nástroje není doslovně obsažen v zadání';
    else {
      try { TOOLS[c.tool].run(c.input); r.accepted = true; r.reason = 'Ověřeno zkušebním během'; } catch (e) { r.reason = 'Nástroj selhal: ' + e.message; }
    }
    return r;
  });
}

function processGate0(modelOut, { prompt, config }) {
  const raw = clone(modelOut);
  const byId = new Map((modelOut.aspects || []).map((a) => [a.id, a]));
  const injection = detectInjection(prompt);
  const sensitive = detectSensitiveData(prompt);
  const detectedOps = detectOperations(prompt);
  const facts = systemFacts(config, modelOut, detectedOps);
  const adjustments = [];

  const aspects = ASPECTS.map((def) => {
    const src = byId.get(def.id) ? clone(byId.get(def.id)) : placeholderAspect(def.id);
    const a = {
      ...src,
      name: def.name,
      aiPriority: src.priority,
      evidence: (src.evidence || []).map((q) => ({ quote: q, verified: isQuoteIn(q, prompt) })),
      nonGoals: src.nonGoals || [], contradictions: src.contradictions || [], dependencies: src.dependencies || [],
      scope: src.scope || '', dataSensitivity: src.dataSensitivity || 'none',
    };
    delete a.priority;
    a.finalPriority = a.aiPriority;
    return a;
  });
  const get = (id) => aspects.find((a) => a.id === id);
  const floor = (id, p, rule) => {
    const a = get(id);
    const np = maxPriority(a.finalPriority, p);
    if (np !== a.finalPriority) { adjustments.push({ aspect: id, from: a.finalPriority, to: np, rule }); a.finalPriority = np; }
  };

  // H7 — schopnosti určuje konfigurace.
  const h7 = get('H7');
  h7.aiClaim = h7.finding;
  h7.systemFacts = { required: facts.requiredCapabilities, available: facts.availableCapabilities, unavailable: facts.unavailableCapabilities };
  h7.finding = facts.unavailableCapabilities.length
    ? `Systémová konfigurace: nedostupné schopnosti ${facts.unavailableCapabilities.join(', ')}. Dostupné: ${facts.availableCapabilities.join(', ') || '—'}.`
    : `Systémová konfigurace: všechny požadované schopnosti jsou dostupné (${facts.availableCapabilities.join(', ') || 'žádné zvláštní'}).`;
  if (facts.unavailableCapabilities.length) floor('H7', 'P0', 'Požadovaná schopnost není v konfiguraci dostupná');

  // H8 — oprávnění určuje konfigurace.
  const h8 = get('H8');
  h8.aiClaim = h8.finding;
  h8.systemFacts = { operations: facts.operations, blocked: facts.blockedOperations };
  h8.finding = facts.blockedOperations.length
    ? `Systémová konfigurace: blokované operace — ${facts.blockedOperations.map((o) => `${o.operation} [${o.category}]`).join('; ')}. Nebudou provedeny.`
    : 'Systémová konfigurace: všechny požadované operace spadají do povolených kategorií.';
  if (facts.blockedOperations.length) floor('H8', 'P0', 'Zadání požaduje operaci mimo oprávnění');

  // H9 — injection a citlivá data (deterministicky).
  const h9 = get('H9');
  h9.detectors = { injection, sensitiveData: sensitive, modelInjectionSuspected: !!modelOut.injectionSuspected };
  if (injection.suspected || modelOut.injectionSuspected) floor('H9', 'P0', `Podezření na prompt injection (${injection.hits.map((h) => h.pattern).join(', ') || 'model'})`);
  if (sensitive.level === 'high') floor('H9', 'P0', `Vysoce citlivá data v zadání (${sensitive.kinds.join(', ')})`);
  else if (sensitive.level === 'medium') floor('H9', 'P1', `Osobní údaje v zadání (${sensitive.kinds.join(', ')})`);
  if (sensitive.level !== 'none') {
    const h3 = get('H3');
    const order = ['none', 'low', 'medium', 'high'];
    if (order.indexOf(h3.dataSensitivity) < order.indexOf(sensitive.level)) {
      adjustments.push({ aspect: 'H3', field: 'dataSensitivity', from: h3.dataSensitivity, to: sensitive.level, rule: 'Detektor citlivých dat' });
      h3.dataSensitivity = sensitive.level;
    }
  }

  // H4 — kritické chybějící informace.
  const h4 = get('H4');
  if ((h4.missingInfo || []).some((m) => m.critical)) floor('H4', 'P1', 'Kritická chybějící informace');

  // Neověřené citace snižují důvěru — evidujeme, priority nesnižujeme.
  const unverifiedEvidence = aspects.flatMap((a) => a.evidence.filter((e) => !e.verified).map((e) => ({ aspect: a.id, quote: e.quote })));

  const dynamicPriorities = [...aspects]
    .sort((x, y) => PRIORITIES.indexOf(x.finalPriority) - PRIORITIES.indexOf(y.finalPriority) || ASPECTS.findIndex((d) => d.id === x.id) - ASPECTS.findIndex((d) => d.id === y.id))
    .map((a) => ({ id: a.id, name: a.name, priority: a.finalPriority }));

  return {
    taskType: modelOut.taskType,
    aspects,
    h1Goal: clone(modelOut.h1Goal),
    systemFacts: facts,
    toolCandidates: validateToolCandidates(modelOut.toolCandidates, prompt),
    detectors: { injection, sensitiveData: sensitive, operations: detectedOps },
    adjustments,
    unverifiedEvidence,
    dynamicPriorities,
    raw,
  };
}

module.exports = { processGate0, validateToolCandidates, systemFacts };
