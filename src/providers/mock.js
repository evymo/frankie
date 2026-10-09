'use strict';
/**
 * Mock provider — deterministická simulace AI odpovědí pro testování celého cyklu bez inference.
 * Vše, co vrací, je označeno simulated=true a tokeny jsou pouze odhad (znaky / 4).
 * Testy mohou předat `script` s pevnými odpověďmi pro jednotlivé úlohy.
 *
 * Záměrné chování pro demonstraci: u úlohy „isPrime“ vrací první pokus chybu (1 považuje za prvočíslo),
 * aby byl vidět jediný řízený opravný průchod.
 */
const { guessTaskType, detectInjection, detectOperations } = require('../core/detectors');
const { findExpression, evaluate } = require('../tools/arith');
const { findCsvBlock, csvToJson } = require('../tools/csv');
const { sentences, textStats } = require('../tools/textStats');
const { stripDiacritics } = require('../core/util');
const { ASPECTS } = require('../core/aspects');

function firstSentence(text) {
  const s = sentences(String(text || '').split(/\n\s*\n/)[0]);
  return (s[0] || String(text || '').trim().split('\n')[0] || '').slice(0, 200);
}

function isVague(text) {
  const t = stripDiacritics(String(text || '').toLowerCase()).trim();
  const wc = (t.match(/[a-z0-9]+/g) || []).length;
  return (wc < 3 && !/\d/.test(t)) || /^(udelej|zpracuj|vyres|pomoz|oprav|dodelej)\s+(to|tohle|neco|ten|tu)\b/.test(t);
}

/** Z exekučního promptu vyjme původní zadání a odpovědi na upřesnění (ohraničené bloky). */
function originalFromCompiled(text) {
  const s = String(text || '');
  const m = s.match(/<<<PUVODNI_ZADANI_([0-9a-f]+)\n([\s\S]*?)\nPUVODNI_ZADANI_\1>>>/);
  const answers = [...s.matchAll(/<<<ODPOVED_UZIVATELE_([0-9a-f]+)\n([\s\S]*?)\nODPOVED_UZIVATELE_\1>>>/g)].map((x) => x[2]);
  return [m ? m[2] : '', ...answers].join('\n');
}

function clarText(clar) {
  return (clar || []).map((c) => c.answer).join('\n');
}

/** Klasifikace cíle pro simulované kvalitativní porovnání (typ + kvalifikátory). */
function classify(s) {
  const t = stripDiacritics(String(s || '').toLowerCase());
  const kind = /(preloz|preklad|translat)/.test(t) ? 'translation' : guessTaskType(s);
  const q = new Set();
  if (/(anglic|english|v anglictine)/.test(t)) q.add('jazyk: angličtina');
  if (/(nemc|german|nemecky)/.test(t)) q.add('jazyk: němčina');
  const lim = t.match(/(\d+)\s*(slov|vet|bod)/);
  if (lim) q.add(`rozsah: ${lim[1]} ${lim[2]}`);
  if (/\bjson\b/.test(t)) q.add('formát: JSON');
  if (/(odrazk|v bodech)/.test(t)) q.add('formát: odrážky');
  if (/tabulk/.test(t)) q.add('formát: tabulka');
  return { kind, q };
}

const KIND_LABEL = { translation: 'překlad', text_analysis: 'analýza/shrnutí textu', math: 'výpočet', code: 'program', structured_transformation: 'transformace dat', question_answering: 'odpověď na otázku', other: 'obecná úloha', text_generation: 'tvorba textu' };

function compareGoals(a, b) {
  const A = classify(a);
  const B = classify(b);
  if (A.kind !== B.kind && A.kind !== 'other' && B.kind !== 'other') {
    return { relation: 'CRITICAL_CONFLICT', differences: [{ description: `Jiný typ výsledku: ${KIND_LABEL[A.kind] || A.kind} vs. ${KIND_LABEL[B.kind] || B.kind}`, critical: true }], rationale: '(simulace) Cíle vedou k zásadně odlišným výsledkům.' };
  }
  const onlyA = [...A.q].filter((x) => !B.q.has(x));
  const onlyB = [...B.q].filter((x) => !A.q.has(x));
  if (A.kind !== B.kind) {
    return { relation: 'UNCLEAR', differences: [{ description: 'Jeden z cílů nelze typově zařadit.', critical: false }], rationale: '(simulace) Nelze rozhodnout bez upřesnění.' };
  }
  if (!onlyA.length && !onlyB.length) return { relation: 'EQUIVALENT', differences: [], rationale: '(simulace) Stejný typ výsledku i požadavky.' };
  return {
    relation: 'NONCRITICAL_DIFFERENCE',
    differences: [...onlyA.map((x) => ({ description: `Pouze A požaduje ${x}`, critical: false })), ...onlyB.map((x) => ({ description: `Pouze B požaduje ${x}`, critical: false }))],
    rationale: '(simulace) Stejný typ výsledku, liší se forma nebo rozsah.',
  };
}

const CODE_TASKS = [
  { re: /(isprime|prvocisl|prime)/, name: 'isPrime', cases: [{ args: [1], expected: false }, { args: [2], expected: true }, { args: [15], expected: false }, { args: [17], expected: true }, { args: [97], expected: true }],
    good: 'function isPrime(n) {\n  // Prvočíslo: celé číslo > 1 dělitelné jen 1 a sebou samým\n  if (!Number.isInteger(n) || n < 2) return false;\n  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;\n  return true;\n}',
    bad: 'function isPrime(n) {\n  for (let d = 2; d * d <= n; d++) if (n % d === 0) return false;\n  return true;\n}' },
  { re: /(fibonacci|fibonac)/, name: 'fibonacci', cases: [{ args: [0], expected: 0 }, { args: [1], expected: 1 }, { args: [10], expected: 55 }],
    good: 'function fibonacci(n) {\n  let a = 0, b = 1;\n  for (let i = 0; i < n; i++) [a, b] = [b, a + b];\n  return a;\n}' },
  { re: /(factorial|faktorial)/, name: 'factorial', cases: [{ args: [0], expected: 1 }, { args: [5], expected: 120 }],
    good: 'function factorial(n) {\n  let r = 1;\n  for (let i = 2; i <= n; i++) r *= i;\n  return r;\n}' },
  { re: /(palindrom)/, name: 'isPalindrome', cases: [{ args: ['abba'], expected: true }, { args: ['abc'], expected: false }],
    good: 'function isPalindrome(s) {\n  const t = String(s).toLowerCase();\n  return t === t.split("").reverse().join("");\n}' },
];

function codeTask(text) {
  const t = stripDiacritics(String(text || '').toLowerCase());
  return CODE_TASKS.find((c) => c.re.test(t)) || null;
}

function analysedText(prompt) {
  const parts = String(prompt).split(/:\s*\n|\n\s*\n/);
  const longest = parts.sort((a, b) => b.length - a.length)[0] || prompt;
  return longest.trim();
}

function goalStatement(type, text, style) {
  const first = firstSentence(text);
  const expr = findExpression(text);
  const ct = codeTask(text);
  const lead = style === 'h1' ? 'Uživatel chce ' : '';
  switch (type) {
    case 'math': return `${lead}${style === 'h1' ? 'vypočítat' : 'Vypočítat'} hodnotu ${expr ? `výrazu ${expr}` : 'zadaného příkladu'} a uvést číselný výsledek.`;
    case 'structured_transformation': return `${lead}${style === 'h1' ? 'převést' : 'Převést'} poskytnutá CSV data do formátu JSON.`;
    case 'code': return `${lead}${style === 'h1' ? 'napsat' : 'Napsat'} funkci ${ct ? ct.name : ''} v JavaScriptu podle zadání.`.replace('  ', ' ');
    case 'text_analysis': return `${lead}${style === 'h1' ? 'shrnout' : 'Shrnout'} poskytnutý text a uvést jeho hlavní myšlenky.`;
    default: return `${lead}${style === 'h1' ? 'získat' : 'Získat'} odpověď na zadání: ${first}`;
  }
}

function capabilitiesFor(type, ops) {
  const base = { math: ['math'], code: ['code_generation', 'code_execution_sandbox_js'], structured_transformation: ['structured_data'], text_analysis: ['analysis', 'text_generation'] }[type] || ['text_generation'];
  const extra = [];
  if (ops.some((o) => o.category === 'network')) extra.push('web_access');
  if (ops.some((o) => o.category === 'external_communication')) extra.push('external_communication');
  if (ops.some((o) => o.category === 'filesystem_write')) extra.push('file_system_write');
  if (ops.some((o) => o.category === 'payment')) extra.push('payments');
  return [...base, ...extra];
}

function mockGate0({ prompt, clarifications }) {
  const text = `${prompt}\n${clarText(clarifications)}`;
  const type = guessTaskType(text);
  const vague = isVague(prompt) && !(clarifications || []).length;
  const inj = detectInjection(text);
  const ops = detectOperations(text);
  const ev = firstSentence(prompt);
  const toolCandidates = [];
  if (type === 'math') {
    const expr = findExpression(prompt);
    if (expr) toolCandidates.push({ tool: 'arith_eval', input: expr, fullySolves: !ops.length && !/(vysvetl|postup|popis|proc|why|explain)/i.test(stripDiacritics(text)) });
  }
  if (type === 'structured_transformation') {
    const block = findCsvBlock(prompt);
    if (block) toolCandidates.push({ tool: 'csv_to_json', input: block, fullySolves: !ops.length && /json/i.test(text) && !/(jen|pouze|filtr|serad|odfiltruj|starsi|vetsi|mensi|kde )/i.test(stripDiacritics(text)) });
  }
  const P = (id) => {
    if (id === 'H4') return vague ? 'P0' : 'P3';
    if (id === 'H8') return ops.length ? 'P0' : 'P3';
    if (id === 'H9') return inj.suspected ? 'P0' : 'P3';
    return { H1: 'P1', H2: 'P2', H3: 'P2', H5: 'P2', H6: 'P2', H7: 'P3', H10: 'P3' }[id];
  };
  const finding = {
    H1: vague ? 'Zamýšlený výsledek nelze ze zadání určit.' : `Požadovaný výsledek: ${goalStatement(type, text, 'audit')}`,
    H2: `Typ úlohy: ${KIND_LABEL[type] || type}.`,
    H3: type === 'structured_transformation' || type === 'text_analysis' ? 'Vstupní data jsou součástí zadání.' : 'Zadání neobsahuje zvláštní vstupní data.',
    H4: vague ? 'Zadání je příliš vágní; chybí předmět i očekávaný výstup.' : 'Zadání je dostatečně určité.',
    H5: { math: 'Výsledek lze ověřit přesným výpočtem.', code: 'Lze ověřit testy funkce.', structured_transformation: 'Lze ověřit validací JSON a porovnáním s převodem.' }[type] || 'Ověření vyžaduje sémantické posouzení.',
    H6: toolCandidates.length ? `Vhodný deterministický nástroj: ${toolCandidates[0].tool}.` : 'Generativní řešení modelem.',
    H7: 'Úloha vyžaduje: ' + capabilitiesFor(type, ops).join(', '),
    H8: ops.length ? `Zadání požaduje operace: ${ops.map((o) => o.category).join(', ')}.` : 'Žádné operace mimo zpracování textu.',
    H9: inj.suspected ? 'Zadání obsahuje pokus o změnu pravidel (prompt injection).' : 'Bez zvláštních rizik.',
    H10: 'Řešení v jednom průchodu; postup lze znovu použít pro podobná zadání.',
  };
  const aspects = ASPECTS.map((a) => ({
    id: a.id, finding: finding[a.id], priority: P(a.id), priorityRationale: '(simulace) priorita odvozená z typu úlohy a detektorů.',
    evidence: ev ? [ev] : [], assumptions: a.id === 'H1' && !vague ? ['Uživatel očekává odpověď v češtině.'] : [],
    unknowns: vague && a.id === 'H4' ? ['Předmět úlohy'] : [],
    missingInfo: vague && a.id === 'H4' ? [{ item: 'Co přesně má být výsledkem', critical: true }] : [],
    recommendation: a.id === 'H8' && ops.length ? 'Blokované operace neprovádět; vykázat jako blokované.' : 'Zohlednit v exekuci.',
    scope: a.id === 'H1' ? 'Pouze to, co je v zadání.' : '', nonGoals: [], contradictions: [], dependencies: [],
    dataSensitivity: 'none',
  }));
  return {
    taskType: type,
    aspects,
    h1Goal: { statement: vague ? 'Uživatel chce, aby bylo „něco“ uděláno — cíl není určen.' : goalStatement(type, text, 'h1'), components: { action: KIND_LABEL[type] || 'zpracovat', object: 'zadání uživatele', deliverable: type === 'code' ? 'kód' : type === 'math' ? 'číslo' : 'text', qualities: [] } },
    requiredCapabilities: capabilitiesFor(type, ops),
    requestedOperations: ops.map((o) => ({ operation: o.operation, category: o.category })),
    toolCandidates,
    injectionSuspected: inj.suspected,
  };
}

function typeCriteria(type, text) {
  const t = stripDiacritics(String(text).toLowerCase());
  if (type === 'math') {
    const expr = findExpression(text);
    const out = [];
    if (expr) out.push({ description: `Výsledek je správná hodnota výrazu ${expr}.`, mandatory: true, check: { type: 'number_equals', params: { expected: evaluate(expr), tolerance: 1e-6 } } });
    out.push({ description: 'Výsledek je jasně a srozumitelně uveden.', mandatory: false, check: { type: 'semantic' } });
    return out;
  }
  if (type === 'structured_transformation') {
    const block = findCsvBlock(text);
    let keys = [];
    try { keys = Object.keys(csvToJson(block)[0] || {}); } catch (_) { /* nic */ }
    return [
      { description: 'Výstup je platný JSON.', mandatory: true, check: { type: 'json_valid' } },
      { description: 'JSON je pole objektů se sloupci z hlavičky CSV.', mandatory: true, check: { type: 'json_schema', params: { schema: { type: 'array', minItems: 1, items: { type: 'object', required: keys } } } } },
    ];
  }
  if (type === 'code') {
    const ct = codeTask(text);
    const out = [{ description: 'Výsledek obsahuje JavaScript kód.', mandatory: true, check: { type: 'code_artifact_present', params: { language: 'javascript' } } }];
    if (ct) out.push({ description: `Funkce ${ct.name} projde testovacími případy.`, mandatory: true, check: { type: 'js_function_tests', params: { functionName: ct.name, cases: ct.cases } } });
    out.push({ description: 'Kód je čitelný a stručně okomentovaný.', mandatory: false, check: { type: 'semantic' } });
    return out;
  }
  if (type === 'text_analysis') {
    const out = [{ description: 'Shrnutí věrně vystihuje hlavní myšlenky textu.', mandatory: true, check: { type: 'semantic' } }];
    const lim = t.match(/(?:max(?:imalne)?|nejvyse|do)\s*(\d+)\s*slov/);
    if (lim) out.push({ description: `Shrnutí má nejvýše ${lim[1]} slov.`, mandatory: true, check: { type: 'max_words', params: { n: parseInt(lim[1], 10) } } });
    return out;
  }
  return [{ description: 'Odpověď věcně odpovídá zadání.', mandatory: true, check: { type: 'semantic' } }];
}

function mockAudit({ prompt, explicitGoal, clarifications }) {
  const text = `${prompt}\n${clarText(clarifications)}`;
  const type = guessTaskType(text);
  const vague = isVague(prompt) && !(clarifications || []).length;
  const ev = firstSentence(prompt);
  const fmt = { math: 'number', structured_transformation: 'json', code: 'code', text_analysis: 'markdown' }[type] || 'text';
  const crit = vague ? [] : typeCriteria(type, text);
  return {
    derivable: !vague,
    confidence: vague ? 'low' : 'high',
    statement: vague ? 'Cíl nelze ze zadání spolehlivě určit.' : goalStatement(type, text, 'audit'),
    components: { action: KIND_LABEL[type] || 'zpracovat', object: 'zadání uživatele', deliverable: fmt, qualities: [] },
    evidence: ev ? [ev] : [],
    assumptions: vague ? [] : ['Odpověď má být v češtině, pokud není řečeno jinak.'],
    scope: 'Pouze obsah zadání.',
    nonGoals: ['Akce mimo zpracování textu (odesílání, mazání, platby).'],
    constraints: ['Neuvádět neověřená fakta jako jistá.'],
    expectedOutput: { format: fmt, description: `Výstup ve formátu ${fmt}.` },
    acceptanceCriteria: crit,
    explicitGoalCriteria: explicitGoal ? [...typeCriteria(classify(explicitGoal).kind === 'other' ? type : classify(explicitGoal).kind, text), { description: `Výsledek odpovídá explicitnímu cíli: ${explicitGoal}`, mandatory: true, check: { type: 'semantic' } }] : [],
    uncertainties: vague ? ['Není zřejmé, čeho se zadání týká.', 'Není určen očekávaný výstup.'] : [],
    alternatives: [],
  };
}

function mockCompare({ pairs }) {
  return { pairs: pairs.map((p) => ({ pair: p.pair, ...compareGoals(p.a, p.b) })) };
}

function solve({ prompt, contract, attemptKind }) {
  const type = guessTaskType(prompt);
  const stmt = contract ? contract.statement : '';
  const cls = classify(stmt);
  const blocked = contract ? contract.blockedOperations.map((o) => ({ operation: o.operation, reason: 'Operace je mimo oprávnění — neprovedena.' })) : [];
  const base = { status: blocked.length ? 'partial' : 'completed', artifacts: [], completedOperations: ['analýza zadání', 'vytvoření výsledku'], blockedOperations: blocked, assumptionsUsed: [], criteriaSelfReport: [], notes: '(simulace mock provideru)' };
  if (cls.kind === 'translation') {
    return { ...base, status: 'unsupported', output: 'SIMULACE-NELZE: mock provider neumí překládat. Úloha označena jako nepodporovaná.', outputFormat: 'text' };
  }
  if (type === 'math') {
    const expr = findExpression(prompt);
    if (expr) { const v = evaluate(expr); return { ...base, output: `Postup: ${expr} = ${v}.\nVýsledek: ${v}`, outputFormat: 'number' }; }
  }
  if (type === 'structured_transformation') {
    const block = findCsvBlock(prompt);
    if (block) { try { return { ...base, output: JSON.stringify(csvToJson(block), null, 2), outputFormat: 'json' }; } catch (_) { /* nic */ } }
  }
  if (type === 'code') {
    const ct = codeTask(prompt);
    if (ct) {
      const code = attemptKind === 'initial' && ct.bad ? ct.bad : ct.good;
      return { ...base, output: `Funkce ${ct.name} je v artefaktu solution.js.`, outputFormat: 'code', artifacts: [{ name: 'solution.js', type: 'code', language: 'javascript', content: code }] };
    }
    return { ...base, status: 'partial', output: 'Simulace: pro tento typ programu nemá mock připravené řešení.', outputFormat: 'text' };
  }
  if (type === 'text_analysis') {
    const src = analysedText(prompt);
    const ss = sentences(src);
    const st = textStats(src);
    const lim = stripDiacritics(stmt.toLowerCase()).match(/(\d+)\s*bod/);
    const n = lim ? parseInt(lim[1], 10) : 2;
    const picked = ss.slice(0, Math.max(1, n));
    const en = cls.q.has('jazyk: angličtina');
    const head = en ? `Summary (simulated, ${picked.length} points):` : `Shrnutí (simulace, ${picked.length} body):`;
    return { ...base, output: `${head}\n${picked.map((s) => `- ${s}`).join('\n')}\n\nStatistika: ${st.words} slov, ${st.sentences} vět.`, outputFormat: 'markdown' };
  }
  return { ...base, output: `Simulovaná odpověď na zadání „${firstSentence(prompt)}“. (Mock provider nemá znalosti; reálnou odpověď vytvoří Claude.)`, outputFormat: 'text' };
}

function mockExecute(req) {
  const prompt = originalFromCompiled(req.prompt);
  return solve({ prompt, contract: req.input.contract, attemptKind: req.input.attemptKind });
}

function mockSemantic({ criteria, output }) {
  const out = String(output || '');
  const quote = out.trim().split('\n')[0].slice(0, 60);
  return {
    results: criteria.map((c) => {
      if (!out.trim() || out.includes('SIMULACE-NELZE')) return { criterionId: c.id, result: 'FAIL', evidence: 'Výstup neobsahuje požadovaný výsledek.', deviation: '(simulace) Kritérium nesplněno.' };
      return { criterionId: c.id, result: 'PASS', evidence: quote, deviation: '' };
    }),
  };
}

function mockBaseline({ prompt }) {
  const r = solve({ prompt, contract: null, attemptKind: 'baseline' });
  return { output: r.output, artifacts: r.artifacts };
}

const HANDLERS = { gate0: (r) => mockGate0(r.input), goal_audit: (r) => mockAudit(r.input), goal_compare: (r) => mockCompare(r.input), execute: mockExecute, semantic_verify: (r) => mockSemantic(r.input), baseline: (r) => mockBaseline(r.input) };

class MockProvider {
  constructor({ model = 'mock-deterministic-1', script = null } = {}) {
    this.id = 'mock';
    this.model = model;
    this.simulated = true;
    this.requiresPreflight = false;
    this.script = script;
    this.counts = {};
  }

  describe() { return { id: this.id, model: this.model, simulated: true, note: 'Deterministická simulace — žádná inference, žádné náklady.' }; }

  billingInfo() { return { mode: 'mock', authMethod: 'none', note: 'Simulace — žádná fakturace.' }; }

  async preflight() { return { ok: true, checks: [{ id: 'mock', status: 'PASS', label: 'Mock provider', detail: 'Nevyžaduje inferenci.' }] }; }

  async call(req) {
    const t0 = Date.now();
    this.counts[req.task] = (this.counts[req.task] || 0) + 1;
    let data;
    const s = this.script ? this.script[req.task] : undefined;
    if (s !== undefined) {
      const v = Array.isArray(s) ? s[Math.min(this.counts[req.task] - 1, s.length - 1)] : s;
      data = typeof v === 'function' ? await v(req.input, req, this.counts[req.task]) : v;
    } else {
      const h = HANDLERS[req.task];
      if (!h) throw new Error(`Mock neumí úlohu ${req.task}`);
      data = h(req);
    }
    if (data instanceof Error) throw data;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return {
      text,
      data: typeof data === 'string' ? undefined : data,
      model: this.model,
      modelVersions: [this.model],
      simulated: true,
      tokensEstimated: true,
      usage: { inputTokens: Math.ceil(((req.system || '').length + (req.prompt || '').length) / 4), outputTokens: Math.ceil(text.length / 4), cacheReadTokens: 0, cacheCreationTokens: 0 },
      durationMs: Date.now() - t0,
      apiDurationMs: null,
      costUsdEstimate: null,
      sessionId: null,
    };
  }
}

module.exports = { MockProvider, compareGoals, classify, mockGate0, mockAudit, originalFromCompiled };
