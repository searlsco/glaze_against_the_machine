import process from 'node:process';

// Exercise the real subprocess boundary without contacting a model provider.
export const native = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const args = process.argv.slice(2);
const record = value => fs.appendFileSync(process.env.WORKER_CAPTURE, JSON.stringify({pid: process.pid, parentPid: process.ppid, ...value}) + '\\n');
record({event: 'spawn', args, cwd: process.cwd(), home: process.env.CODEX_HOME,
  active: process.env.GLAZE_AGAINST_THE_MACHINE_ACTIVE, nested: process.env.CLAUDECODE,
  parentThread: process.env.CODEX_THREAD_ID});
if (args.includes('mcp') && args.includes('list')) {
  process.stdout.write(JSON.stringify([{name: 'system-server'}, {name: 'another.server'}]) + '\\n');
  process.exit(0);
}
if (!args.includes('app-server')) process.exit(9);
let sequence = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = readline.createInterface({input: process.stdin});
lines.on('line', line => {
  const message = JSON.parse(line);
  record({event: 'rpc', ...message});
  const reply = result => send({id: message.id, result});
  if (message.method === 'initialize') reply({userAgent: 'fake-codex', platformFamily: 'unix', platformOs: 'macos'});
  if (message.method === 'config/read') reply({config: {mcp_servers: {
    'system-server': {enabled: true}, 'another.server': {enabled: true}
  }}, origins: {}, layers: null});
  if (message.method === 'thread/start') reply({thread: {id: process.pid + '-' + ++sequence}});
  if (message.method === 'thread/unsubscribe' || message.method === 'thread/archive') reply({});
  if (message.method !== 'turn/start') return;
  const text = message.params.input.filter(item => item.type === 'text').map(item => item.text).join('');
  if (process.env.WORKER_ECHO_INPUT_DIAGNOSTICS === '1') process.stderr.write(text);
  const turnId = 'turn-' + sequence;
  reply({turn: {id: turnId, status: 'inProgress', items: []}});
  if (text.startsWith('hold')) return;
  if (text.startsWith('crash')) {
    process.stderr.write(text);
    process.exit(7);
  }
  const complete = () => {
    if (text.startsWith('tool ')) {
      const [, method, type] = text.split(' ');
      send({method, params: {threadId: message.params.threadId, turnId,
        item: {id: 'unexpected-tool', type}}});
    }
    if (text.startsWith('approval ')) {
      send({id: 'unexpected-approval', method: 'item/commandExecution/requestApproval',
        params: {threadId: message.params.threadId, turnId}});
    }
    if (text.startsWith('failed')) {
      send({method: 'turn/completed', params: {threadId: message.params.threadId,
        turn: {id: turnId, status: 'failed', error: {message: text}}}});
      return;
    }
    for (const type of ['userMessage', 'reasoning', 'contextCompaction']) {
      for (const method of ['item/started', 'item/completed']) {
        send({method, params: {threadId: message.params.threadId, turnId,
          item: {id: 'text-lifecycle-' + type, type}}});
      }
    }
    const output = text.startsWith('oversize') ? 'x'.repeat(4 * 1024 * 1024 + 1) : process.env.WORKER_GLAZE_RESPONSE || 'rewritten:' + text;
    send({method: 'item/completed', params: {threadId: message.params.threadId, turnId,
      item: {id: 'item-' + sequence, type: 'agentMessage', phase: 'final_answer', text: output}}});
    send({method: 'turn/completed', params: {threadId: message.params.threadId,
      turn: {id: turnId, status: 'completed', items: []}}});
  };
  if (text.startsWith('slow')) setTimeout(complete, 250);
  else setImmediate(complete);
});
if (process.env.WORKER_STUBBORN === '1') {
  process.on('SIGTERM', () => record({event: 'sigterm'}));
  lines.on('close', () => record({event: 'eof'}));
  setInterval(() => {}, 1000);
} else lines.on('close', () => process.exit(0));
`;
