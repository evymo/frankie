'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRun, runPipeline } = require('../src/core/pipeline');
const { MockProvider } = require('../src/providers/mock');
const { ClaudeCliProvider } = require('../src/providers/claudeCli');
const { testConfig } = require('./helpers');
const os = require('os');
const path = require('path');

/** Nesimulovaný provider s odpověďmi mocku — jen pro test textu reportu (bez větvení podle backendu v jádru). */
class RealLike {
  constructor(note) { this.mock = new MockProvider({}); this.id = 'jiny-backend'; this.model = 'model-x'; this.simulated = false; this.note = note; }
  describe() { return { id: this.id, model: this.model, simulated: false, ...(this.note ? { note: this.note } : {}) }; }
  billingInfo() { return { mode: 'test' }; }
  async call(req) { return { ...(await this.mock.call(req)), simulated: false }; }
}

async function reality(provider) {
  const cfg = testConfig();
  const run = createRun({ prompt: 'Vypočítej 2+3.', provider: provider.id, config: cfg });
  await runPipeline({ run, provider, config: cfg, persist: () => {} });
  assert.equal(run.state, 'DONE');
  return run.report.realityNote;
}

test('Report: poznámku o realitě dodává provider (describe().note), jádro nevětví podle id backendu', async () => {
  assert.equal(await reality(new RealLike()), 'Reálná inference: jiny-backend (model-x).');
  assert.equal(await reality(new RealLike('Vlastní poznámka provideru.')), 'Vlastní poznámka provideru.');
  const cli = new ClaudeCliProvider({ config: testConfig(), sandboxDir: path.join(os.tmpdir(), 'fr-cli-sandbox-test') });
  assert.match(cli.describe().note, /Claude Code CLI/);
});
