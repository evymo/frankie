'use strict';
/**
 * Task Executor — univerzální exekuční adaptér.
 * 1) Pokud kontrakt obsahuje validovaný deterministický nástroj, který úlohu plně řeší, použije ho (bez AI).
 * 2) Jinak předá Execution Contract providerovi (Claude CLI / mock) a převezme strukturovaný výsledek.
 * Nikdy nedoplňuje „splnění“ blokovaných operací; blokace určené konfigurací eviduje zvlášť (systemBlocked).
 */
const { EXECUTION } = require('./schemas');

function systemBlocked(contract) {
  return contract.blockedOperations.map((o) => ({ operation: o.operation, reason: `Kategorie „${o.category}“ není povolena systémovou konfigurací.` }));
}

async function execute({ contract, compiled, callModel, config, attemptKind }) {
  const started = Date.now();
  const plan = contract.toolPlan;
  if (plan && plan.fullySolves && config.executor.preferDeterministicTools && attemptKind === 'initial') {
    return {
      mode: 'deterministic_tool',
      tool: plan.tool,
      status: contract.blockedOperations.length ? 'partial' : 'completed',
      output: plan.outputFormat === 'json' ? JSON.stringify(plan.value, null, 2) : plan.rendered,
      outputFormat: plan.outputFormat,
      artifacts: [],
      completedOperations: [`deterministický nástroj ${plan.tool}`],
      blockedOperations: systemBlocked(contract),
      systemBlocked: systemBlocked(contract),
      assumptionsUsed: [],
      criteriaSelfReport: [],
      notes: 'Vykonáno deterministickým nástrojem bez AI inference.',
      simulated: false,
      callId: null,
      durationMs: Date.now() - started,
    };
  }
  const r = await callModel({
    task: 'execute',
    template: compiled.template,
    system: compiled.system,
    prompt: compiled.text,
    schema: EXECUTION,
    input: { contract, attemptKind },
  });
  if (!r.ok) {
    return {
      mode: 'ai', status: 'error', error: r.error, output: '', outputFormat: 'text', artifacts: [], completedOperations: [],
      blockedOperations: [], systemBlocked: systemBlocked(contract), assumptionsUsed: [], criteriaSelfReport: [], notes: '',
      simulated: r.simulated, callId: r.callId, durationMs: Date.now() - started,
    };
  }
  const d = r.data;
  return {
    mode: 'ai',
    status: d.status,
    output: d.output,
    outputFormat: d.outputFormat,
    artifacts: d.artifacts || [],
    completedOperations: d.completedOperations || [],
    blockedOperations: d.blockedOperations || [],
    systemBlocked: systemBlocked(contract),
    assumptionsUsed: d.assumptionsUsed || [],
    criteriaSelfReport: d.criteriaSelfReport || [],
    notes: d.notes || '',
    simulated: r.simulated,
    callId: r.callId,
    durationMs: Date.now() - started,
  };
}

module.exports = { execute };
