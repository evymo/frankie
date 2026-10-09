'use strict';
const args = process.argv.slice(2);
if (args.includes('--fake-fail')) { process.stdout.write('{"type":"turn.failed","error":{"message":"fixture failure"}}\n'); process.exitCode = 1; }
else if (args.includes('--fake-timeout')) setInterval(() => {}, 1000);
else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => { input += d; });
  process.stdin.on('end', () => {
    const report = { args, input, emptyDir: require('fs').readdirSync(process.cwd()).length === 0,
      forbiddenEnv: Object.keys(process.env).filter(k => /^(OPENAI_|CODEX_|ANTHROPIC_|CLAUDE|AWS_|GOOGLE_)/i.test(k)) };
    for (const event of [
      { type: 'thread.started', thread_id: 'fake-codex' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(report) } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20 } },
    ]) process.stdout.write(JSON.stringify(event) + '\n');
  });
}
