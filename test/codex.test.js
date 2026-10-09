'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { testConfig } = require('./helpers');
const { CodexCliProvider, parseCodexResult } = require('../src/providers/codexCli');
const { runCodexPreflight, evaluateCodexAuth, evaluateCodexBilling, REQUIRED_FLAGS, DISABLED_FEATURES } = require('../src/providers/codexPreflight');
const { discoverCodexCli, sanitizedEnv } = require('../src/providers/cliEnv');
const { createRun, runPipeline } = require('../src/core/pipeline');

const attestation = { creditUsageDisabledAttested: true, creditUsageAttestedBy: 'Tester', creditUsageAttestedAt: '2026-10-09' };
const cli = { path: process.execPath, source: 'fixture', tried: [] };
const exec = async (_, args) => {
  if (args[0] === '--version') return { code: 0, out: 'codex-cli 0.162.0', err: '' };
  if (args[0] === 'exec') return { code: 0, out: REQUIRED_FLAGS.join(' '), err: '' };
  if (args[0] === 'features') return { code: 0, out: DISABLED_FEATURES.map(f => f + ' stable true').join('\n'), err: '' };
  return { code: 0, out: '', err: 'Logged in using ChatGPT\n' };
};
function provider(config, dir, extra = [], ok = true) {
  return new CodexCliProvider({ config, sandboxDir: dir, commandPrefixArgs: [path.join(__dirname, 'fixtures', 'fake-codex.js'), ...extra],
    preflightFn: async () => ({ ok, cliPath: process.execPath, authMethod: 'chatgpt', at: 'now', checks: [] }) });
}
test('Codex auth: ChatGPT only, API key and unknown output fail closed', () => {
  assert.equal(evaluateCodexAuth({ code: 0, out: '', err: 'Logged in using ChatGPT\n' }), true);
  for (const output of ['Logged in using an API key', 'Not logged in', 'Logged in using ChatGPT\nAPI key active', '']) {
    assert.equal(evaluateCodexAuth({ code: 0, out: output, err: '' }), false);
  }
  assert.equal(evaluateCodexAuth({ code: 1, out: 'Logged in using ChatGPT', err: '' }), false);
});
test('Codex billing requires its own credit attestation, never Claude attestation', () => {
  assert.equal(evaluateCodexBilling(testConfig().billing).status, 'FAIL');
  assert.equal(evaluateCodexBilling({ creditUsageDisabledAttested: true }).status, 'FAIL');
  assert.equal(evaluateCodexBilling(attestation).status, 'PASS');
});
test('Codex preflight checks auth, CLI flags, features and independent billing', async () => {
  const config = testConfig(); config.billing.codex = attestation;
  const opts = { exec, discover: () => cli };
  assert.equal((await runCodexPreflight(config, opts)).ok, true);
  config.billing.codex = undefined;
  assert.equal((await runCodexPreflight(config, opts)).ok, false);
  config.billing.codex = attestation;
  for (const bad of ['auth', 'flags', 'features', 'version']) {
    const pf = await runCodexPreflight(config, { ...opts, exec: async (p,args) => {
      if (bad === 'auth' && args[0] === 'login') return { code: 0, out: 'Logged in using an API key', err: '' };
      if (bad === 'flags' && args[0] === 'exec') return { code: 0, out: '--json', err: '' };
      if (bad === 'features' && args[0] === 'features') return { code: 0, out: '', err: '' };
      if (bad === 'version' && args[0] === '--version') return { code: 1, out: '0.162.0', err: '' };
      return exec(p,args);
    } });
    assert.equal(pf.ok, false, bad);
  }
  assert.equal((await runCodexPreflight(config, { ...opts, discover: () => ({path:null,tried:[]}) })).ok, false);
});
test('Codex discover honors configured binary; environment strips API and CODEX overrides', () => {
  assert.equal(discoverCodexCli(process.execPath).path, process.execPath);
  assert.deepEqual(sanitizedEnv({ PATH: 'bin', OPENAI_API_KEY: 'secret', CODEX_API_KEY: 'secret', CODEX_HOME: 'custom', CODEX_ACCESS_TOKEN: 'secret', NODE_OPTIONS: 'unsafe' }), { PATH: 'bin' });
});
test('Codex pipeline: failed preflight blocks all real calls and fallback', async () => {
  const config = testConfig(); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-codex-test-'));
  try {
    const p = provider(config, dir, [], false);
    await assert.rejects(p.call({system:'s',prompt:'p'}), /BILLING_GUARD/);
    let called=0; p.call = async () => { called++; throw Error('must not run'); };
    const run=createRun({prompt:'Vypočítej 2+2',provider:'codex-cli',config});
    await runPipeline({run,provider:p,config,persist:()=>{}});
    assert.equal(run.state,'FAILED'); assert.equal(run.error.code,'BILLING_GUARD');
    assert.equal(called,0); assert.equal(run.telemetry.calls.length,0); assert.equal(run.provider.id,'codex-cli');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('Codex process: stdin, isolation, stripped credentials and real JSONL telemetry', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr-codex-test-'));
  const saved=process.env.CODEX_API_KEY; process.env.CODEX_API_KEY='must-not-leak';
  try {
    const p=provider(testConfig(),dir); await p.preflight();
    const prompt='Text s diakritikou a $(shell)'; const r=await p.call({system:'SYSTEM',prompt});
    const report=JSON.parse(r.text);
    assert.equal(report.input,'# INSTRUCTIONS\nSYSTEM\n\n# INPUT\n'+prompt);
    assert.ok(!report.args.join(' ').includes(prompt));
    assert.equal(report.emptyDir,true); assert.deepEqual(report.forbiddenEnv,[]);
    for(const flag of ['--ignore-user-config','--ephemeral','--skip-git-repo-check','--json']) assert.ok(report.args.includes(flag));
    assert.equal(report.args[report.args.indexOf('--sandbox')+1],'read-only');
    for(const flag of DISABLED_FEATURES) assert.ok(report.args.includes('features.'+flag+'='+(flag==='skip_host_skill_discovery'?'true':'false')));
    assert.ok(report.args.includes('forced_login_method="chatgpt"'));
    assert.deepEqual(r.usage,{inputTokens:70,outputTokens:20,cacheReadTokens:30,cacheCreationTokens:0});
    assert.equal(r.costUsdEstimate,null); assert.equal(r.simulated,false); assert.deepEqual(fs.readdirSync(dir),[]);
  } finally {
    if(saved===undefined)delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY=saved;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('Codex: nonzero exit, missing executable and timeout reject with no result', async () => {
  const config=testConfig(); config.providers['codex-cli'].timeoutMs=100;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fr-codex-test-'));
  try {
    for(const args of [['--fake-fail'],['--fake-timeout']]) {
      const p=provider(config,dir,args); await p.preflight(); await assert.rejects(p.call({system:'s',prompt:'p'}),/chybou|limit/);
    }
    const p=provider(config,dir); p.lastPreflight={ok:true,cliPath:path.join(dir,'missing')};
    await assert.rejects(p.call({system:'s',prompt:'p'}),/Spuštění/);
    assert.deepEqual(fs.readdirSync(dir),[]);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('Codex JSONL: errors, missing completion, tools and malformed usage reject', () => {
  const msg={type:'item.completed',item:{type:'agent_message',text:'answer'}};
  const end={type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}};
  const encode=events=>events.map(e=>JSON.stringify(e)).join('\n');
  assert.equal(parseCodexResult(encode([msg,end])).text,'answer');
  for(const events of [[msg], [end], [msg,{type:'turn.failed'}], [msg,{type:'error',message:'bad'}],
    [{type:'item.started',item:{type:'command_execution'}},msg,end], [msg,{type:'turn.completed',usage:{input_tokens:-1}}]]) {
    assert.throws(()=>parseCodexResult(encode(events)));
  }
  assert.throws(()=>parseCodexResult('not json'));
});
