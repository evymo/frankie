'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MODEL_CATALOG, modelsFor, selectProviderModel } = require('../src/providers/models');
const { createProviders } = require('../src/providers');
const { ClaudeCliProvider } = require('../src/providers/claudeCli');
const { CodexCliProvider } = require('../src/providers/codexCli');
const { RunManager } = require('../src/core/pipeline');
const { RunStore } = require('../src/core/store');
const { MockProvider } = require('../src/providers/mock');
const { testConfig } = require('./helpers');

test('Model catalog: provider-specific models, blocked Fable, immutable catalogue', () => {
  const providers = createProviders(testConfig());
  assert.equal(modelsFor(providers['codex-cli']).length, 7);
  assert.equal(modelsFor(providers['claude-cli']).filter(m=>!m.disabled).length, 3);
  for (const [id,p] of Object.entries(providers)) {
    assert.equal(selectProviderModel(p).model,p.model);
    for (const bad of ['--dangerously-bypass-approvals-and-sandbox', 'unknown', {}, '', id === 'codex-cli' ? 'claude-opus-5-5' : 'gpt-6-astra']) {
      assert.throws(()=>selectProviderModel(p,bad),{code:'BAD_MODEL'});
    }
  }
  assert.throws(()=>selectProviderModel(providers['claude-cli'],'claude-fable-5-1'),{code:'BAD_MODEL'});
  assert.ok(Object.isFrozen(MODEL_CATALOG['codex-cli'][0]));
});
test('Model selection: both CLI adapters pass the selected model without mutating the base provider', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr-model-'));
  try {
    for(const [Class,fixture,id,model] of [
      [ClaudeCliProvider,'fake-claude.js','claude-cli','claude-haiku-5-5'],
      [CodexCliProvider,'fake-codex.js','codex-cli','gpt-6-astra'],
    ]) {
      const config=testConfig();
      const p=new Class({ config,sandboxDir:dir,commandPrefixArgs:[path.join(__dirname,'fixtures',fixture)],
        preflightFn:async()=>({ok:true,cliPath:process.execPath,authMethod:'subscription',at:'now',checks:[]}) });
      const original=p.model; await p.preflight();
      const selected=selectProviderModel(p,model);
      assert.notEqual(selected,p); assert.equal(selected.lastPreflight,null); assert.equal(p.model,original);
      if(id==='claude-cli') assert.equal(selected.pc.minCliVersion,'2.1.293');
      await selected.preflight();
      const result=await selected.call({system:'System',prompt:'Prompt'});
      const args=JSON.parse(result.text).args;
      assert.equal(args[args.indexOf('--model')+1],model);
      assert.equal(result.model,model); assert.equal(p.model,original);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
class ModelMock extends MockProvider {
  constructor(model='gpt-6.1-sol') {super({model});this.id='codex-cli';this.simulated=false;}
  describe(){return {id:this.id,model:this.model,simulated:false};}
  withModel(entry){return new ModelMock(entry.id);}
}
test('RunManager: model is saved, telemetry follows selection, clarification inherits it, default stays intact', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr-model-store-'));
  try {
    const config=testConfig(), base=new ModelMock();
    const store=new RunStore(dir);
    const manager=new RunManager({store,config,providers:{'codex-cli':base}});
    assert.throws(()=>manager.start({prompt:'x',provider:'codex-cli',model:'claude-opus-5-5'}),{code:'BAD_MODEL'});
    const {run,done}=manager.start({prompt:'Udělej to.',provider:'codex-cli',model:'gpt-6-luna'});
    await done;
    assert.equal(run.state,'CLARIFICATION_REQUIRED');
    assert.equal(run.input.options.model,'gpt-6-luna');
    assert.equal(run.provider.model,'gpt-6-luna');
    assert.ok(run.telemetry.calls.every(c=>c.model==='gpt-6-luna'));
    const next=manager.start({parentRunId:run.id,clarificationAnswer:'Vypočítej 2+2'});
    await next.done;
    assert.equal(next.run.input.options.provider,'codex-cli');
    assert.equal(next.run.input.options.model,'gpt-6-luna');
    assert.equal(next.run.provider.model,'gpt-6-luna');
    assert.equal(base.model,'gpt-6.1-sol');
    const def=manager.start({prompt:'Vypočítej 3+3',provider:'codex-cli'});
    await def.done;assert.equal(def.run.provider.model,'gpt-6.1-sol');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
