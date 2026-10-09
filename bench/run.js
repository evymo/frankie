'use strict';
/**
 * Benchmark FR vs. samostatný dotaz na model (stejný model, stejné zadání).
 *
 *   node bench/run.js --backends bench/backends.json [--only id1,id2] [--scenarios S01,L01] [--modes fr,raw]
 *
 * Režimy:  fr  — celý cyklus FR (Gate 0 → … → Verifier → max. 1 oprava)
 *          raw — čistý dotaz: zadání tak, jak ho napsal uživatel, bez jakékoli obálky FR
 * Správnost obou hodnotí nezávislý orákl (bench/oracle.js), ne kritéria FR.
 * Výsledky: data/bench/<čas>/results.jsonl + runs/*.json (úplné záznamy běhů FR).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, ROOT } = require('../src/config');
const { createRun, runPipeline } = require('../src/core/pipeline');
const { MockProvider } = require('../src/providers/mock');
const { ClaudeCliProvider } = require('../src/providers/claudeCli');
const { OpenAICompatProvider } = require('./openaiCompat');
const { SCENARIOS } = require('./scenarios');

const RAW_SYSTEM = 'Jsi užitečný asistent.';
const STOP_RULES = new Set(['A2', 'A3', 'D1']);

function parseArgs(argv) {
  const a = { backends: path.join(__dirname, 'backends.json'), modes: ['fr', 'raw'] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (['backends', 'out'].includes(k)) { a[k] = v; i++; }
    else if (['only', 'scenarios', 'modes'].includes(k)) { a[k] = v.split(',').map((x) => x.trim()).filter(Boolean); i++; }
  }
  return a;
}

function makeProvider(b, config) {
  if (b.type === 'mock') return new MockProvider({ model: 'mock-deterministic-1' });
  if (b.type === 'claude-cli') return new ClaudeCliProvider({ config, sandboxDir: path.join(os.tmpdir(), 'fr-cli-sandbox') });
  if (b.type === 'openai-compatible') return new OpenAICompatProvider({ ...b, id: b.id });
  throw new Error(`Neznámý typ backendu ${b.type}`);
}

/** Řízená chyba: první volání „execute“ vrátí podvržený výsledek, vše ostatní jde na skutečný model. */
function withInjection(provider, inject) {
  let used = false;
  return new Proxy(provider, {
    get(t, prop) {
      if (prop === 'call') {
        return async (req) => {
          if (!used && req.task === 'execute') {
            used = true;
            return { text: JSON.stringify(inject), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, model: 'řízená-chyba', modelVersions: ['řízená-chyba'], simulated: false, tokensEstimated: false, durationMs: 0 };
          }
          return t.call(req);
        };
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

function costOf(calls) {
  return {
    calls: calls.filter((c) => c.model !== 'řízená-chyba').length,
    inputTokens: calls.reduce((s, c) => s + (c.inputTokens || 0), 0),
    outputTokens: calls.reduce((s, c) => s + (c.outputTokens || 0), 0),
    aiMs: calls.reduce((s, c) => s + (c.durationMs || 0), 0),
    costUsd: calls.some((c) => typeof c.costUsdEstimate === 'number') ? calls.reduce((s, c) => s + (c.costUsdEstimate || 0), 0) : null,
    byModel: calls.reduce((m, c) => { m[c.model] = (m[c.model] || 0) + 1; return m; }, {}),
  };
}

function attemptOut(a) {
  return a ? { output: a.execution.output || '', artifacts: a.execution.artifacts || [] } : null;
}

async function runFr({ provider, config, prompt, explicitGoal, parent, clarificationAnswer }) {
  const run = createRun({ prompt, explicitGoal, provider: provider.id, baseline: false, parent, clarificationAnswer, config });
  const t0 = Date.now();
  await runPipeline({ run, provider, config, persist: () => {} });
  return { run, wallMs: Date.now() - t0 };
}

/** Vyhodnocení běhu FR nezávislým oráklem. */
async function judgeFr(run, expect, oracle) {
  const rule = run.decision && run.decision.rule;
  const decisionOk = !!rule && expect.decisions.includes(rule);
  if (run.state === 'FAILED') return { ok: false, decisionOk, detail: `FR selhal: ${run.error && run.error.code} ${run.error && run.error.message}`.slice(0, 300) };
  if (run.state === 'CLARIFICATION_REQUIRED') {
    const acceptable = expect.stop || (decisionOk && STOP_RULES.has(rule));
    return { ok: acceptable, decisionOk, detail: acceptable ? `zastavil se s otázkou (${rule}) — správně` : `zbytečně se zastavil (${rule})` };
  }
  if (expect.stop) return { ok: false, decisionOk, detail: `měl se zastavit, ale vykonal (${rule})` };
  const branches = [];
  for (const b of run.branches) {
    const out = attemptOut(b.attempts[b.attempts.length - 1]);
    const r = await oracle(out);
    branches.push({ id: b.id, role: b.role, verdict: b.finalVerdict, ok: r.ok, detail: r.detail });
  }
  const primary = branches[0];
  return { ok: !!primary && primary.ok, decisionOk, detail: primary ? primary.detail : 'žádná větev', branches };
}

function frSummary(run, wallMs) {
  const b0 = run.branches[0];
  const first = b0 && b0.attempts[0];
  const last = b0 && b0.attempts[b0.attempts.length - 1];
  return {
    runId: run.id,
    state: run.state,
    decision: run.decision ? run.decision.rule : null,
    question: run.clarification ? run.clarification.question : null,
    verdictInitial: first && first.verification ? first.verification.verdict : null,
    verdictFinal: b0 ? b0.finalVerdict : null,
    repaired: b0 ? b0.repairsUsed > 0 : false,
    repairReason: b0 && b0.repairDecision ? b0.repairDecision.reason : null,
    executionMode: last ? last.execution.mode : null,
    failedCriteria: first && first.verification ? first.verification.criteria.filter((c) => c.result !== 'PASS').map((c) => `${c.criterionId}:${c.result}`) : [],
    output: attemptOut(last),
    firstOutput: b0 && b0.attempts.length > 1 ? attemptOut(first) : null,
    error: run.error,
    wallMs,
    cost: costOf((run.telemetry && run.telemetry.calls) || []),
  };
}

async function runRaw(provider, prompt) {
  const t0 = Date.now();
  try {
    const r = await provider.call({ task: 'raw', system: RAW_SYSTEM, prompt, json: false });
    return { out: { output: r.text, artifacts: [] }, wallMs: Date.now() - t0, cost: costOf([{ model: r.model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, durationMs: r.durationMs, costUsdEstimate: r.costUsdEstimate }]) };
  } catch (e) {
    return { error: e.message, out: { output: '', artifacts: [] }, wallMs: Date.now() - t0, cost: costOf([]) };
  }
}

function log(msg) { process.stderr.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`); }

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const backends = JSON.parse(fs.readFileSync(args.backends, 'utf8')).filter((b) => !args.only || args.only.includes(b.id));
  const scenarios = SCENARIOS.filter((s) => !args.scenarios || args.scenarios.includes(s.id));
  const outDir = args.out || path.join(ROOT, 'data', 'bench', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true });
  const resultsFile = path.join(outDir, 'results.jsonl');
  const write = (rec) => fs.appendFileSync(resultsFile, JSON.stringify(rec) + '\n');
  const saveRun = (run) => fs.writeFileSync(path.join(outDir, 'runs', `${run.id}.json`), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ startedAt: new Date().toISOString(), backends: backends.map((b) => ({ id: b.id, type: b.type, model: b.model || null, judgeModel: b.judgeModel || null })), scenarios: scenarios.map((s) => s.id), modes: args.modes, frVersion: require('../package.json').version, platform: `${os.platform()}-${os.arch()}` }, null, 2));
  log(`výstup: ${outDir}`);

  for (const b of backends) {
    const base = makeProvider(b, config);
    if (base.requiresPreflight) {
      const pf = await base.preflight();
      if (!pf.ok) { log(`[${b.id}] PREFLIGHT NEPROŠEL — backend přeskočen: ${JSON.stringify(pf.checks || pf).slice(0, 400)}`); write({ backend: b.id, skipped: true, preflight: pf }); continue; }
    }
    for (const s of scenarios) {
      const modes = (s.modes || ['fr', 'raw']).filter((m) => args.modes.includes(m));
      const common = { backend: b.id, model: b.model || base.model, judgeModel: b.judgeModel || null, scenario: s.id, group: s.group, title: s.title };

      if (modes.includes('fr')) {
        const provider = s.inject ? withInjection(base, s.inject) : base;
        const { run, wallMs } = await runFr({ provider, config, prompt: s.prompt, explicitGoal: s.explicitGoal });
        saveRun(run);
        const j = await judgeFr(run, s.expect, s.oracle || (async () => ({ ok: false, detail: 'bez orákla' })));
        const fr = frSummary(run, wallMs);
        write({ ...common, mode: 'fr', injected: !!s.inject, ok: j.ok, decisionOk: j.decisionOk, detail: j.detail, branches: j.branches, fr });
        log(`[${b.id}] ${s.id} fr  ${j.ok ? 'SPRÁVNĚ ' : 'ŠPATNĚ  '} ${fr.decision || '-'} ${fr.verdictInitial || ''}${fr.repaired ? '→' + fr.verdictFinal : ''} (${fr.cost.calls} volání, ${(wallMs / 1000).toFixed(1)} s) ${j.detail.slice(0, 90)}`);

        if (s.followUp && run.state === 'CLARIFICATION_REQUIRED') {
          const f = await runFr({ provider: base, config, parent: run, clarificationAnswer: s.followUp.answer });
          saveRun(f.run);
          const jf = await judgeFr(f.run, s.followUp.expect, s.followUp.oracle);
          const frf = frSummary(f.run, f.wallMs);
          write({ ...common, mode: 'fr-followup', ok: jf.ok, decisionOk: jf.decisionOk, detail: jf.detail, branches: jf.branches, fr: frf });
          log(`[${b.id}] ${s.id} fr+ ${jf.ok ? 'SPRÁVNĚ ' : 'ŠPATNĚ  '} ${frf.decision || '-'} ${frf.verdictFinal || ''} (${frf.cost.calls} volání) ${jf.detail.slice(0, 90)}`);
        }
      }

      if (modes.includes('raw')) {
        if (base.simulated) { write({ ...common, mode: 'raw', ok: null, detail: 'n/a — simulovaný provider' }); continue; }
        const prompt = s.explicitGoal ? `${s.prompt}\n\nCíl: ${s.explicitGoal}` : s.prompt;
        const r = await runRaw(base, prompt);
        const oracle = s.rawOracle || s.oracle;
        const j = r.error ? { ok: false, detail: `chyba volání: ${r.error}` } : await oracle(r.out);
        write({ ...common, mode: 'raw', ok: j.ok, detail: j.detail, raw: { output: r.out.output, error: r.error || null, wallMs: r.wallMs, cost: r.cost } });
        log(`[${b.id}] ${s.id} raw ${j.ok ? 'SPRÁVNĚ ' : 'ŠPATNĚ  '} (${(r.wallMs / 1000).toFixed(1)} s) ${j.detail.slice(0, 90)}`);

        if (s.followUp) {
          const rf = await runRaw(base, `${s.prompt}\n\nUpřesnění: ${s.followUp.answer}`);
          const jf = rf.error ? { ok: false, detail: `chyba volání: ${rf.error}` } : await s.followUp.oracle(rf.out);
          write({ ...common, mode: 'raw-followup', ok: jf.ok, detail: jf.detail, raw: { output: rf.out.output, error: rf.error || null, wallMs: rf.wallMs, cost: rf.cost } });
          log(`[${b.id}] ${s.id} raw+ ${jf.ok ? 'SPRÁVNĚ ' : 'ŠPATNĚ  '} ${jf.detail.slice(0, 90)}`);
        }
      }
    }
  }
  log(`hotovo: ${resultsFile}`);
  process.stdout.write(outDir + '\n');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { judgeFr };
