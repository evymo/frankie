'use strict';
/**
 * v0.4 — adaptivní H-learning. Deterministické testy TOKU (mechanismu), nikoli kvality reálného modelu:
 * mock nikdy nedokládá kvalitativní převahu sestavy; „ověřené“ záznamy níže jsou syntetické fixtures KB.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runMock, testConfig, mockGate0 } = require('./helpers');
const { KnowledgeBase, computeStatus } = require('../src/core/knowledge');
const { DEFAULT_SET, deriveSet, validateSet, finalizeSet, resolveAspects } = require('../src/core/aspectSets');
const { profileTask, compareProfiles } = require('../src/core/profile');
const { proposeHypotheses, diagnoseBranch } = require('../src/core/learning');
const { planExperiment, runPipeline, createRun } = require('../src/core/pipeline');
const { processGate0 } = require('../src/core/gate0');
const { gate0Schema } = require('../src/core/schemas');
const { validate } = require('../src/core/schema');
const { MockProvider } = require('../src/providers/mock');
const { CORE_ASPECT_IDS } = require('../src/core/aspects');

const SUMMARY_PROMPT = 'Shrň následující text maximálně do 40 slov:\nPraha je hlavní město České republiky. Leží na řece Vltavě. Má přes milion obyvatel.';
const SIMILAR_PROMPT = 'Shrň tento text nejvýše do 30 slov:\nBrno je druhé největší město České republiky. Je centrem jižní Moravy a sídlem soudů.';
const LONG_SUMMARY = { status: 'completed', output: 'Shrnutí: ' + 'slovo '.repeat(60), outputFormat: 'markdown', artifacts: [], completedOperations: [], blockedOperations: [], assumptionsUsed: [], criteriaSelfReport: [] };
const SHORT_SUMMARY = { status: 'completed', output: 'Shrnutí: Praha je hlavní město ČR na Vltavě s více než milionem obyvatel.', outputFormat: 'markdown', artifacts: [], completedOperations: [], blockedOperations: [], assumptionsUsed: [], criteriaSelfReport: [] };

/** Syntetická fixture: doporučení s danými (reálnými) srovnáními — simuluje, že by proběhly autorizované reálné experimenty. */
function seedRecommendation(kb, { prompt = SUMMARY_PROMPT, wins = 2 } = {}) {
  const profile = profileTask({ prompt });
  const cand = deriveSet(DEFAULT_SET, { add: ['HX-FORMAT'] }, { kind: 'fixture' });
  const { rec } = kb.upsertRecommendation({
    kind: 'enrichment', change: { add: ['HX-FORMAT'] }, changeText: 'přidat HX-FORMAT', signal: 'format', rationale: 'fixture',
    baseSet: DEFAULT_SET, candidateSet: cand, applicability: { key: { kind: profile.features.kind, artifact: profile.features.artifact }, requires: { constraints: ['length'] } },
    originProfile: profile.features, origin: { runId: 'RUN-FIXTURE', simulated: false },
  });
  for (let i = 0; i < wins; i++) {
    kb.recordComparison({ recommendationId: rec.id, baseRunId: `RUN-FX-${i}`, experimentRunId: `RUN-FXE-${i}`, candidateSet: cand, quality: 'better', effect: 'support', counted: true, simulated: false, note: 'fixture' });
  }
  return { rec, cand };
}

test('B — nová charakteristika bez zkušeností: bezpečná výchozí H-sestava H1–H10', async () => {
  const { run } = await runMock({ prompt: 'Vypočítej (17*23+5)/2' });
  assert.equal(run.learning.selection.mode, 'default');
  assert.equal(run.learning.selection.set.id, 'HS-default');
  assert.match(run.learning.selection.reason, /žádné zkušenosti/);
  assert.deepEqual(run.gate0.aspects.map((a) => a.id), ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']);
  assert.equal(run.gate0.aspectSet.hash, DEFAULT_SET.hash);
  assert.equal(run.branches[0].attempts[0].compiledPrompt.aspectTrace.aspectSet.id, 'HS-default');
  assert.ok(run.stateHistory.some((s) => s.state === 'PROFILE') && run.stateHistory.some((s) => s.state === 'LEARN'));
});

test('Profil zadání: deterministický, bez AI, kvalitativní shoda (klíčové znaky typ + artefakt)', () => {
  const a = profileTask({ prompt: SUMMARY_PROMPT });
  const b = profileTask({ prompt: SIMILAR_PROMPT });
  const c = profileTask({ prompt: 'Napiš funkci isPrime v JavaScriptu.' });
  assert.deepEqual(profileTask({ prompt: SUMMARY_PROMPT }), a, 'determinismus');
  assert.equal(a.features.kind, 'text_analysis');
  assert.deepEqual(a.features.constraints, ['length']);
  assert.equal(compareProfiles(a, b).level, 'strong');
  const ac = compareProfiles(a, c);
  assert.equal(ac.level, 'none');
  assert.ok(ac.mismatched.some((m) => m.feature === 'kind' && m.key));
  assert.equal(profileTask({ prompt: 'How do you do expert ?' }).features.language, 'en');
  assert.ok(profileTask({ prompt: 'Kolik je teď hodin v San Franciscu?' }).features.needs.includes('realtime'));
});

test('H-sestavy: systémové garance H1/H7/H8/H9 nelze odebrat ani omezit; jedna změna; hash', () => {
  assert.deepEqual(CORE_ASPECT_IDS, ['H1', 'H7', 'H8', 'H9']);
  assert.throws(() => deriveSet(DEFAULT_SET, { remove: ['H8'] }), /nelze odebrat/);
  assert.throws(() => deriveSet(DEFAULT_SET, { add: ['HX-FORMAT'], remove: ['H10'] }), /právě jednu změnu/);
  assert.throws(() => finalizeSet({ id: 'X', version: 1, aspects: DEFAULT_SET.aspects, floors: {}, caps: { H9: 'P3' } }), /nelze omezit/);
  assert.throws(() => finalizeSet({ id: 'X', version: 1, aspects: DEFAULT_SET.aspects.filter((a) => a.id !== 'H1'), floors: {}, caps: {} }), /H1/);
  const s1 = deriveSet(DEFAULT_SET, { add: ['HX-FORMAT'] }, {});
  const s2 = deriveSet(DEFAULT_SET, { add: ['HX-FORMAT'] }, { other: true });
  assert.equal(s1.id, s2.id, 'stejná změna = stejná sestava');
  assert.deepEqual(validateSet(s1), []);
  const tampered = { ...s1, floors: { H5: 'P0' } };
  assert.ok(validateSet(tampered).some((e) => /Hash/.test(e)));
});

test('Gate 0 podle H-sestavy: dynamické schéma, strop jen pro adaptivní H, systémové podlahy platí vždy', () => {
  const capped = deriveSet(DEFAULT_SET, { cap: { H4: 'P3' } }, {});
  const prompt = 'Udělej to.'; // H4 má kritickou chybějící informaci → systémová podlaha P1 přebije strop sestavy
  const ids = resolveAspects(capped).map((a) => a.id);
  const out = mockGate0({ prompt, aspects: resolveAspects(capped) });
  assert.deepEqual(validate(gate0Schema(ids), out), []);
  const g = processGate0(out, { prompt, config: testConfig(), aspectSet: capped });
  const h4 = g.aspects.find((a) => a.id === 'H4');
  assert.equal(h4.finalPriority, 'P1');
  assert.ok(g.adjustments.some((x) => x.aspect === 'H4' && /strop/.test(x.rule)));
  const withFmt = deriveSet(DEFAULT_SET, { add: ['HX-FORMAT'] }, {});
  const ids2 = resolveAspects(withFmt).map((a) => a.id);
  assert.equal(ids2.length, 11);
  assert.ok(validate(gate0Schema(ids2), mockGate0({ prompt: 'Spočítej 2+2' })).length > 0, 'výstup s 10 hledisky neprojde schématem sestavy s 11');
});

test('C — strukturovaný kandidát z diagnózy, doložený původ a srovnání proti TÉMUŽ zamčenému Goal Contract', async () => {
  const kb = new KnowledgeBase({ config: testConfig() });
  const { run: base } = await runMock({ prompt: SUMMARY_PROMPT, script: { execute: LONG_SUMMARY }, kb });
  assert.equal(base.branches[0].finalVerdict, 'PARTIAL');
  const d = base.learning.diagnosis[0];
  assert.ok(d.items.some((i) => i.criterionId === 'AC-2' && i.cause === 'interpretation_or_strategy' && i.signal === 'format'));
  assert.equal(base.learning.hypotheses.length, 1);
  const h = base.learning.hypotheses[0];
  assert.deepEqual(h.change, { add: ['HX-FORMAT'] });
  assert.equal(h.status, 'candidate');
  assert.equal(h.simulatedOrigin, true);
  assert.match(h.rationale, /AC-2/);
  const rec = kb.recommendation(h.recommendationId);
  assert.equal(rec.origin.runId, base.id);
  assert.equal(rec.baseSet.hash, DEFAULT_SET.hash);

  // experiment: stejný prompt, zamčený kontrakt, kandidátní sestava; jen jedna změna (H-sestava)
  const plan = planExperiment({ baseRun: base, kb, config: testConfig(), provider: new MockProvider(), recommendationId: rec.id });
  const { run: exp } = await runMock({ experiment: plan, script: { execute: SHORT_SUMMARY }, kb });
  assert.equal(exp.state, 'DONE');
  assert.equal(exp.input.prompt, base.input.prompt);
  assert.ok(!exp.stateHistory.some((s) => ['GOAL_AUDIT', 'DECISION'].includes(s.state)), 'cíl se znovu nevyjednává');
  assert.equal(exp.contracts[0].contentHash, base.contracts[0].contentHash);
  assert.equal(exp.gate0.aspectSet.hash, rec.candidateSet.hash);
  assert.ok(exp.gate0.aspects.some((a) => a.id === 'HX-FORMAT'));
  const cmp = exp.learning.comparison;
  assert.equal(cmp.conditions.sameGoalContract, true);
  assert.equal(cmp.conditions.sameMandatoryCriteria, true);
  assert.equal(cmp.conditions.sameEvaluator, true);
  assert.equal(cmp.quality, 'better');
  assert.ok(cmp.improved.includes('AC-2'));
  // F — simulace se nezapočítá
  assert.equal(cmp.simulated, true);
  assert.equal(cmp.counted, false);
  assert.match(cmp.note, /SIMULACE/);
  assert.equal(kb.recommendation(rec.id).status, 'candidate', 'mock nezvyšuje důvěryhodnost');
  // opakování téhož srovnání je odmítnuto; řetězení experimentů také
  assert.throws(() => planExperiment({ baseRun: base, kb, config: testConfig(), provider: new MockProvider(), recommendationId: rec.id }), /už proběhlo/);
  assert.throws(() => planExperiment({ baseRun: exp, kb, config: testConfig(), provider: new MockProvider(), recommendationId: rec.id }), /řetězení/);
});

test('C — experiment s pozměněným zamčeným kontraktem selže fail-closed', async () => {
  const kb = new KnowledgeBase({ config: testConfig() });
  const { run: base } = await runMock({ prompt: SUMMARY_PROMPT, script: { execute: LONG_SUMMARY }, kb });
  const recId = base.learning.hypotheses[0].recommendationId;
  const tampered = JSON.parse(JSON.stringify(base));
  tampered.contracts[0].successCriteria = tampered.contracts[0].successCriteria.filter((c) => c.id !== 'AC-2');
  const plan = planExperiment({ baseRun: tampered, kb, config: testConfig(), provider: new MockProvider(), recommendationId: recId });
  const { run } = await runMock({ experiment: plan, kb });
  assert.equal(run.state, 'FAILED');
  assert.equal(run.error.code, 'LOCKED_CONTRACT');
});

test('D — ověřená sestava je u podobné úlohy nalezena a SKUTEČNĚ ovlivní Gate 0 i Execution Contract; nesouvisející úloha ji nepřevezme', async () => {
  const kb = new KnowledgeBase({ config: testConfig() });
  const { rec, cand } = seedRecommendation(kb, { wins: 2 });
  assert.equal(kb.recommendation(rec.id).status, 'verified');
  let gate0Prompt = '';
  const script = { gate0: (input, req) => { gate0Prompt = req.prompt; return mockGate0(input); } };
  const { run } = await runMock({ prompt: SIMILAR_PROMPT, kb, script });
  const sel = run.learning.selection;
  assert.equal(sel.mode, 'applied');
  assert.equal(sel.appliedRecommendationId, rec.id);
  assert.equal(sel.set.hash, cand.hash);
  assert.match(sel.reason, /ověřená zkušenost/);
  const c = sel.candidates.find((x) => x.recommendationId === rec.id);
  assert.equal(c.applied, true);
  assert.ok(c.matched.length > 0 && Array.isArray(c.mismatched));
  // vazba: H-sestava → otázky Gate 0 → report → Execution Contract
  assert.match(gate0Prompt, /HX-FORMAT — Formální omezení výstupu/);
  assert.match(gate0Prompt, /analytická sestava HS-/);
  const hx = run.gate0.aspects.find((a) => a.id === 'HX-FORMAT');
  assert.ok(hx && hx.kind === 'adaptive');
  const cp = run.branches[0].attempts[0].compiledPrompt;
  assert.ok(cp.aspectTrace.included.some((a) => a.id === 'HX-FORMAT'));
  assert.match(cp.text, new RegExp(`Analytická sestava: ${cand.id}@v1`));
  assert.match(cp.text, /HX-FORMAT Formální omezení výstupu:/);
  // pozorování bez kontrolní skupiny důvěru nezvyšuje (a simulace ji ani nesnižuje)
  assert.equal(run.learning.observation.effect, 'none');
  assert.equal(run.learning.hypotheses.length, 0, 'při použití zkušenosti se negenerují další kandidáti (jedna změna)');
  assert.equal(kb.recommendation(rec.id).status, 'verified');

  // nesouvisející úloha
  const { run: other } = await runMock({ prompt: 'Napiš funkci isPrime v JavaScriptu.', kb });
  assert.equal(other.learning.selection.mode, 'default');
  assert.ok(!other.gate0.aspects.some((a) => a.id === 'HX-FORMAT'));
  assert.ok(!other.learning.selection.candidates.some((x) => x.recommendationId === rec.id));

  // uživatel si může vynutit výchozí sestavu
  const { run: forced } = await runMock({ prompt: SIMILAR_PROMPT, kb, learningMode: 'default' });
  assert.equal(forced.learning.selection.mode, 'default');
  assert.match(forced.learning.selection.candidates[0].whyNot, /výchozí sestavu/);
});

test('D — jediný úspěch (podpořeno) se jen doporučí, aktivně nepoužije', async () => {
  const kb = new KnowledgeBase({ config: testConfig() });
  const { rec } = seedRecommendation(kb, { wins: 1 });
  assert.equal(kb.recommendation(rec.id).status, 'supported');
  const { run } = await runMock({ prompt: SIMILAR_PROMPT, kb });
  assert.equal(run.learning.selection.mode, 'default');
  const c = run.learning.selection.candidates.find((x) => x.recommendationId === rec.id);
  assert.equal(c.applied, false);
  assert.match(c.whyNot, /jen ověřená/);
});

test('Důvěryhodnost: jen započitatelná reálná srovnání; min. 2 výhry; protichůdné důkazy ji snižují', () => {
  const R = (cmps, obs = []) => ({ evidence: { comparisons: cmps, observations: obs } });
  const win = { counted: true, effect: 'support' };
  const loss = { counted: true, effect: 'against' };
  const sim = { counted: false, simulated: true, effect: 'support' };
  assert.equal(computeStatus(R([])), 'candidate');
  assert.equal(computeStatus(R([sim, sim, sim])), 'candidate', 'simulace nikdy');
  assert.equal(computeStatus(R([win])), 'supported');
  assert.equal(computeStatus(R([win, win])), 'verified');
  assert.equal(computeStatus(R([win, win], [])), 'verified');
  assert.equal(computeStatus(R([win], []), { verifyMinWins: 1 }), 'supported', 'tvrdé minimum 2');
  assert.equal(computeStatus(R([win, win, loss])), 'contested');
  assert.equal(computeStatus(R([win, loss])), 'refuted');
  assert.equal(computeStatus(R([win, win], [{ effect: 'warning' }, { effect: 'warning' }])), 'contested');
});

test('E — neúspěch kvůli oprávnění se nepřipíše H-sestavě (žádná hypotéza)', async () => {
  const { run } = await runMock({ prompt: 'Spočítej 12*12 a výsledek pošli e-mailem na sef@firma.cz.' });
  assert.equal(run.branches[0].finalVerdict, 'PARTIAL');
  const d = run.learning.diagnosis[0];
  const sys4 = d.items.find((i) => i.criterionId === 'SYS-4');
  assert.equal(sys4.cause, 'permission_or_capability');
  assert.equal(d.hFeedback, false);
  assert.equal(run.learning.hypotheses.length, 0);
});

test('E — SYS-4 z operace vymyšlené modelem (PASSPORT §6.1): hodnotitel ≥ 1.1.0 ji nezapočte do verdiktu, diagnóza ji označí jako vadu hodnotitele', async () => {
  const prompt = 'Vytvoř jednoduchou webovou hru Člověče nezlob se jako jeden HTML soubor.';
  const g = mockGate0({ prompt });
  g.requestedOperations = [{ operation: 'zapsat soubory do pracovního adresáře', category: 'filesystem_write' }];
  const { run } = await runMock({ prompt, script: { gate0: g } });
  const c = run.contracts[0];
  assert.equal(c.evaluator, '1.2.0');
  assert.equal(c.blockedOperations[0].literalSupport, false);
  const sys4 = c.successCriteria.find((x) => x.id === 'SYS-4');
  assert.equal(sys4.mandatory, false);
  const v = run.branches[0].attempts.at(-1).verification;
  assert.equal(v.evaluator, '1.2.0');
  assert.notEqual(v.verdict, 'PARTIAL', 'SYS-4 bez opory verdikt neshodí');
  const item = run.learning.diagnosis[0].items.find((i) => i.criterionId === 'SYS-4');
  assert.equal(item.cause, 'evaluator_suspect');
  assert.equal(item.mandatory, false);
  // operace zůstává blokovaná a v promptu uvedená (autorita neslábne)
  assert.match(run.branches[0].attempts[0].compiledPrompt.text, /filesystem_write/);
});

test('E — reálný PASS s necitovatelným důkazem = podezření na hodnotitele, ne na H-sestavu', () => {
  const contract = { id: 'GC-1', successCriteria: [{ id: 'GOAL-1', mandatory: true, verification: { kind: 'semantic', type: 'semantic' } }], blockedOperations: [], unavailableCapabilities: [] };
  const run = {
    provider: { simulated: false }, input: { prompt: 'Shrň text.' }, contracts: [contract], gate0: { aspects: [] },
  };
  const branch = { id: 'B1', contractId: 'GC-1', attempts: [{ execution: { status: 'completed', output: 'Text výstupu.' }, verification: { verdict: 'UNVERIFIED', evaluator: '1.1.0', criteria: [{ criterionId: 'GOAL-1', mandatory: true, result: 'UNVERIFIED', downgradedFrom: 'PASS', simulated: false }] } }] };
  const d = diagnoseBranch({ run, branch });
  assert.equal(d.items[0].cause, 'evaluator_suspect');
  assert.equal(d.hFeedback, false);
  assert.equal(d.evidenceGrade, 'real');
});

test('Redukce: z reálného úspěchu vznikne jen kandidát (odebrat adaptivní H s P3), nikdy ze simulace', () => {
  const profile = profileTask({ prompt: 'Vypočítej 2+3' });
  const gate0 = processGate0(mockGate0({ prompt: 'Vypočítej 2+3' }), { prompt: 'Vypočítej 2+3', config: testConfig() });
  const pass = [{ branchId: 'B1', verdict: 'PASS', hFeedback: false, signals: [], items: [] }];
  const real = proposeHypotheses({ diagnoses: pass, profile, aspectSet: DEFAULT_SET, gate0, runId: 'RUN-R', simulated: false });
  assert.equal(real.length, 1);
  assert.equal(real[0].kind, 'reduction');
  assert.ok(real[0].change.remove.every((id) => !CORE_ASPECT_IDS.includes(id)));
  assert.ok(real[0].change.remove.includes('H10'));
  assert.deepEqual(proposeHypotheses({ diagnoses: pass, profile, aspectSet: DEFAULT_SET, gate0, runId: 'RUN-S', simulated: true }), []);
});

test('H — reálný experiment bez povolení v konfiguraci a bez potvrzení je odmítnut (žádná skrytá inference)', async () => {
  const kb = new KnowledgeBase({ config: testConfig() });
  const { run: base } = await runMock({ prompt: SUMMARY_PROMPT, script: { execute: LONG_SUMMARY }, kb });
  const recId = base.learning.hypotheses[0].recommendationId;
  const realLike = { id: 'mock', model: 'mock-deterministic-1', simulated: false };
  assert.throws(() => planExperiment({ baseRun: base, kb, config: testConfig(), provider: realLike, recommendationId: recId, confirmRealCalls: true }), (e) => e.code === 'NOT_AUTHORIZED' && /nejsou povolené/.test(e.message));
  const cfg = testConfig();
  cfg.learning = { ...cfg.learning, realExperiments: { enabled: true, maxPerDay: 1 } };
  assert.throws(() => planExperiment({ baseRun: base, kb, config: cfg, provider: realLike, recommendationId: recId }), (e) => e.code === 'NOT_AUTHORIZED' && /potvrzení/.test(e.message));
  const ok = planExperiment({ baseRun: base, kb, config: cfg, provider: realLike, recommendationId: recId, confirmRealCalls: true });
  assert.equal(ok.authorization.mode, 'real');
  const other = { id: 'claude-cli', model: 'claude-sonnet-5-5', simulated: false };
  assert.throws(() => planExperiment({ baseRun: base, kb, config: cfg, provider: other, recommendationId: recId, confirmRealCalls: true }), /stejný provider/);
});

/** Celý obsah adresáře KB jako text (pro kontrolu, že do veřejného repa nejde nic citlivého). */
function dirText(d) {
  if (!fs.existsSync(d)) return '';
  return fs.readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? dirText(path.join(d, e.name)) : fs.readFileSync(path.join(d, e.name), 'utf8'))).join('\n');
}

test('KB v repozitáři: jeden soubor na záznam, bez textu zadání, výstupu i hashe zadání; přežije znovunačtení; neznámá verze = fail-closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-kb-'));
  const kdir = path.join(dir, 'knowledge');
  try {
    const kb = new KnowledgeBase({ dir: kdir, config: testConfig() });
    const { run } = await runMock({ prompt: SUMMARY_PROMPT, script: { execute: LONG_SUMMARY }, kb });
    for (const k of ['kb.json', 'experiences', 'recommendations', 'proposals', 'sets']) assert.ok(fs.existsSync(path.join(kdir, k)), k);
    const raw = dirText(kdir);
    assert.ok(!raw.includes('Vltavě'), 'KB neobsahuje text zadání');
    assert.ok(!raw.includes('slovo slovo'), 'KB neobsahuje výstup');
    assert.ok(!raw.includes(run.input.promptSha256), 'KB neobsahuje hash zadání');
    const again = new KnowledgeBase({ dir: kdir, config: testConfig() });
    assert.equal(again.data.recommendations.length, 1);
    assert.equal(again.data.experiences.length, 1);
    assert.equal(again.data.recommendations[0].status, 'candidate', 'stav se dopočítá, neukládá');
    // záznamy se nepřepisují
    const recFile = fs.readdirSync(path.join(kdir, 'recommendations'))[0];
    const before = fs.readFileSync(path.join(kdir, 'recommendations', recFile), 'utf8');
    await runMock({ prompt: SUMMARY_PROMPT, script: { execute: LONG_SUMMARY }, kb: again });
    assert.equal(fs.readFileSync(path.join(kdir, 'recommendations', recFile), 'utf8'), before);
    assert.equal(fs.readdirSync(path.join(kdir, 'proposals')).length, 2, 'opakovaný návrh = nový záznam návrhu');

    fs.writeFileSync(path.join(kdir, 'kb.json'), JSON.stringify({ schemaVersion: 'fr-kb/99' }));
    const broken = new KnowledgeBase({ dir: kdir, config: testConfig() });
    assert.equal(broken.available(), false);
    const { run: r2 } = await runMock({ prompt: SUMMARY_PROMPT, kb: broken });
    assert.equal(r2.state, 'DONE');
    assert.equal(r2.learning.selection.mode, 'default');
    assert.equal(r2.learning.kbUpdate.saved, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(kdir, 'kb.json'), 'utf8')).schemaVersion, 'fr-kb/99', 'neznámá verze se nepřepíše');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KB kolegů: nezávisle vzniklé záznamy se po „git pull“ (sloučení adresářů) spojí bez konfliktu a důkazy se sečtou', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-kb-team-'));
  const A = path.join(dir, 'a');
  const B = path.join(dir, 'b');
  try {
    const ka = new KnowledgeBase({ dir: A, config: testConfig() });
    const kbb = new KnowledgeBase({ dir: B, config: testConfig() });
    // stejná hypotéza vznikla u dvou lidí, každý má 1 reálné srovnání
    const ra = seedRecommendation(ka, { wins: 1 }).rec;
    const rb = seedRecommendation(kbb, { wins: 1 }).rec;
    ka.save(); kbb.save();
    assert.notEqual(ra.id, rb.id);
    assert.equal(ka.recommendation(ra.id).status, 'supported');
    // „git pull“: soubory B se přidají k A (různé názvy souborů → žádný konflikt)
    for (const kind of fs.readdirSync(B)) {
      const src = path.join(B, kind);
      if (!fs.statSync(src).isDirectory()) continue;
      for (const f of fs.readdirSync(src)) {
        const dst = path.join(A, kind, f);
        if (kind === 'sets' && fs.existsSync(dst)) { assert.equal(fs.readFileSync(dst, 'utf8'), fs.readFileSync(path.join(src, f), 'utf8'), 'sestavy jsou adresované obsahem — stejný soubor'); continue; }
        assert.ok(!fs.existsSync(dst), 'žádná kolize názvů');
        fs.copyFileSync(path.join(src, f), dst);
      }
    }
    ka.reload();
    assert.equal(ka.data.recommendations.length, 1, 'stejný klíč = jedno doporučení');
    const merged = ka.recommendation(rb.id);
    assert.equal(merged.id, ka.recommendation(ra.id).id, 'alias na nejstarší záznam');
    assert.equal(merged.status, 'verified', '2 nezávislá reálná srovnání');
    assert.equal(merged.proposals.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KB: převod dřívějšího data/kb/fr-kb.json (fr-kb/1) do knowledge/ — očištěně, původní soubor beze změny', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-kb-mig-'));
  try {
    const legacy = path.join(dir, 'kb', 'fr-kb.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    const cand = deriveSet(DEFAULT_SET, { remove: ['H10'] }, {});
    const old = {
      schemaVersion: 'fr-kb/1', aspectSets: { [cand.id]: cand },
      experiences: [{ id: 'EXP-1', at: '2026-10-09T04:02:26.000Z', runId: 'RUN-1', promptSha256: 'a'.repeat(64), profile: {} }],
      recommendations: [{ id: 'REC-OLD-1', key: 'k1', version: 1, kind: 'reduction', change: { remove: ['H10'] }, changeText: 'odebrat H10', baseSet: { id: 'HS-default', version: 1, hash: DEFAULT_SET.hash }, candidateSet: { id: cand.id, version: 1, hash: cand.hash }, applicability: { key: { kind: 'math', artifact: 'number' }, requires: {} }, originProfile: profileTask({ prompt: 'Vypočítej 2+3' }).features, rationale: 'x', origin: { runId: 'RUN-1', simulated: false }, proposals: [{ at: '2026-10-09T04:02:26.000Z', runId: 'RUN-1', simulated: false }], evidence: { comparisons: [], observations: [] }, status: 'candidate', createdAt: '2026-10-09T04:02:26.000Z' }],
      comparisons: [], log: [],
    };
    fs.writeFileSync(legacy, JSON.stringify(old));
    const { createServer } = require('../src/server');
    const { server, kb, kbMigration } = createServer({ config: testConfig(), dataDir: dir, providers: { mock: new MockProvider() } });
    server.close();
    assert.ok(kbMigration && kbMigration.saved);
    assert.equal(kb.recommendation('REC-OLD-1').changeText, 'odebrat H10');
    assert.equal(kb.data.experiences.length, 1);
    assert.ok(!dirText(path.join(dir, 'knowledge')).includes('a'.repeat(64)), 'hash zadání se nepřevádí');
    assert.deepEqual(JSON.parse(fs.readFileSync(legacy, 'utf8')), old, 'původní soubor beze změny');
    const { kbMigration: again } = createServer({ config: testConfig(), dataDir: dir, providers: { mock: new MockProvider() } });
    assert.equal(again, null, 'převod proběhne jen jednou');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G — události průběhu: skutečné kroky, modelová volání, učení; vše perzistováno v záznamu běhu', async () => {
  const snapshots = [];
  const cfg = testConfig();
  const provider = new MockProvider();
  const run = createRun({ prompt: SUMMARY_PROMPT, provider: 'mock', config: cfg });
  await runPipeline({ run, provider, config: cfg, persist: (r) => snapshots.push(JSON.parse(JSON.stringify(r.events))) });
  const steps = run.events.map((e) => e.step);
  for (const s of ['RECEIVED', 'PROFILE', 'PROFILE_TASK', 'ASPECT_SET', 'GATE0', 'gate0', 'GOAL_AUDIT', 'DECISION', 'CONTRACTS', 'COMPILE', 'EXECUTE', 'execute', 'VERIFY', 'semantic_verify', 'REPORT', 'LEARN', 'DIAGNOSIS', 'KB_UPDATE', 'DONE']) assert.ok(steps.includes(s), s);
  assert.ok(run.events.every((e) => e.status !== 'running'), 'po dokončení nic neběží');
  assert.ok(run.events.filter((e) => e.kind === 'call').every((e) => e.call && e.call.simulated === true && Number.isFinite(e.durationMs)));
  assert.ok(snapshots.some((evs) => evs.some((e) => e.kind === 'call' && e.status === 'running')), 'během volání je perzistován stav „běží“');
  assert.deepEqual(run.events.map((e) => e.seq), run.events.map((_, i) => i + 1));
  const json = JSON.stringify(run.events);
  assert.ok(!/rawOutput|uvažování|chain/i.test(json), 'žádné interní úvahy modelu');
});

test('G — STOP a BILLING_GUARD: učení přeskočeno / blokace viditelná v průběhu', async () => {
  const { run } = await runMock({ prompt: 'Udělej to.' });
  assert.equal(run.state, 'CLARIFICATION_REQUIRED');
  assert.ok(run.events.some((e) => e.step === 'CLARIFICATION_REQUIRED' && e.status === 'stopped'));
  assert.ok(run.events.some((e) => e.step === 'LEARN' && e.status === 'skipped'));
});
