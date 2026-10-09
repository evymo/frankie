'use strict';
const { loadConfig } = require('../src/config');
const { createRun, runPipeline } = require('../src/core/pipeline');
const { MockProvider, mockGate0, mockAudit } = require('../src/providers/mock');

function testConfig(overrides = {}) {
  const c = loadConfig();
  c.defaultProvider = 'mock';
  return { ...c, ...overrides, limits: { ...c.limits, ...(overrides.limits || {}) } };
}

async function runMock({ prompt, explicitGoal, baseline, script, config, parent, clarificationAnswer, kb, experiment, learningMode }) {
  const cfg = config || testConfig();
  const provider = new MockProvider({ script });
  const run = createRun({ prompt, explicitGoal, provider: 'mock', baseline, parent, clarificationAnswer, config: cfg, learningMode, experiment });
  const saves = [];
  await runPipeline({ run, provider, config: cfg, persist: (r) => saves.push(r.state), kb, experiment });
  return { run, provider, saves };
}

function criterion(run, branchIdx, id, attempt = -1) {
  const b = run.branches[branchIdx];
  const a = b.attempts[attempt < 0 ? b.attempts.length + attempt : attempt];
  return a.verification.criteria.find((c) => c.criterionId === id);
}

module.exports = { testConfig, runMock, criterion, mockGate0, mockAudit };
