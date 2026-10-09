'use strict';
// Falešné Claude CLI pro testy adaptéru: neprovádí žádnou inferenci, jen ověří argumenty, prostředí a stdin.
const args = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  const forbiddenEnv = Object.keys(process.env).filter((k) => /^(ANTHROPIC_|CLAUDE|AWS_|GOOGLE_)/i.test(k));
  const toolsIdx = args.indexOf('--tools');
  const report = {
    args,
    hasSafeMode: args.includes('--safe-mode'),
    hasStrictMcp: args.includes('--strict-mcp-config'),
    noPersistence: args.includes('--no-session-persistence'),
    toolsEmpty: toolsIdx >= 0 && args[toolsIdx + 1] === '',
    hasBare: args.includes('--bare'),
    forbiddenEnv,
    stdinChars: stdin.length,
    stdinHead: stdin.slice(0, 40),
    cwdEmptyDir: require('fs').readdirSync(process.cwd()).length === 0,
  };
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: JSON.stringify(report),
    usage: { input_tokens: 1234, output_tokens: 56, cache_read_input_tokens: 700, cache_creation_input_tokens: 10 },
    total_cost_usd: 0.0123, duration_ms: 42, duration_api_ms: 40, num_turns: 1, session_id: 'fake-session',
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1234 } },
  }));
});
