import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { codexServerArgs, rewriteRequest, runCodex, startCodexBridge } from '../src/codex-bridge.js';

const fakeServer = 'process.stdin.setEncoding("utf8"); let b=""; process.stdin.on("data", c => { b+=c; let n; while((n=b.indexOf("\\n"))>=0) { let m=JSON.parse(b.slice(0,n)); b=b.slice(n+1); process.stdout.write(JSON.stringify({method:"received",params:m})+"\\n"); } });';

test('forwards explicit backend configuration without forwarding TUI-only options or prompt text', () => {
  assert.deepEqual(codexServerArgs([
    '--model', 'gpt-6-luna', '-c', 'model_providers.custom.base_url="https://example.test"',
    '--config=model_instructions_file="/tmp/custom.md"', '-cfeatures.hooks=false',
    '--enable', 'one', '--disable=two', '--strict-config', '--no-alt-screen',
    '--', '--config=prompt-text',
  ]), [
    '-c', 'model_providers.custom.base_url="https://example.test"',
    '--config=model_instructions_file="/tmp/custom.md"', '-c', 'features.hooks=false',
    '--enable', 'one', '--disable=two', '--strict-config',
  ]);
  assert.deepEqual(codexServerArgs(['--config', 'a=1', '--disable', 'three', '-cb=2']), ['--config', 'a=1', '--disable', 'three', '-c', 'b=2']);
  assert.throws(() => codexServerArgs(['--config']), /requires a value/);
});

test('launcher uses a pathless remote address and authenticates through the TUI environment', { timeout: 5000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-launcher-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, 'fake-codex.mjs');
  await writeFile(command, `#!${process.execPath}
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from ${JSON.stringify(import.meta.resolve('ws'))};
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  assert.equal(process.env.GLAZE_AGAINST_THE_MACHINE_CODEX_TOKEN, 'existing-value');
  ${fakeServer}
} else {
  assert.equal(args[0], '--remote');
  const address = new URL(args[1]);
  assert.equal(address.protocol, 'ws:');
  assert.equal(address.hostname, '127.0.0.1');
  assert.ok(address.port);
  assert.equal(address.pathname, '/');
  assert.equal(address.search, '');
  assert.equal(address.hash, '');
  assert.equal(args[2], '--remote-auth-token-env');
  assert.deepEqual(args.slice(4), ['--no-alt-screen']);
  const token = process.env[args[3]];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(!args.some((arg) => arg.includes(token)));
  const socket = new WebSocket(args[1], { headers: { Authorization: 'Bearer ' + token } });
  await once(socket, 'open');
  const response = once(socket, 'message');
  socket.send(JSON.stringify({ id: 1, method: 'ping' }));
  assert.deepEqual(JSON.parse((await response)[0]), { method: 'received', params: { id: 1, method: 'ping' } });
  process.exit(0);
}
`, { mode: 0o700 });
  const env = { ...process.env, GLAZE_AGAINST_THE_MACHINE_CODEX_TOKEN: 'existing-value' };
  assert.equal(await runCodex(['--no-alt-screen'], { command, env, cwd: directory }), 0);
  assert.equal(env.GLAZE_AGAINST_THE_MACHINE_CODEX_TOKEN, 'existing-value');
});

async function fixture(t, rewrite = async (text) => `Please ${text}`) {
  // A real child process exercises framing and lifecycle, without real inference.
  const directory = await mkdtemp(join(tmpdir(), 'glazer-bridge-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = join(directory, 'fake-codex');
  await writeFile(command, `#!${process.execPath}\n${fakeServer}`, { mode: 0o700 });
  const bridge = await startCodexBridge({ command, rewrite, env: { ...process.env, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: join(directory, 'inspect') } });
  t.after(() => bridge.close());
  const socket = new WebSocket(bridge.url, { headers: { Authorization: `Bearer ${bridge.token}` } });
  await once(socket, 'open');
  const exchange = async (message) => {
    const response = once(socket, 'message');
    socket.send(JSON.stringify(message));
    return JSON.parse((await response)[0].toString());
  };
  return { bridge, socket, exchange };
}

test('rewrites start and steering text while preserving attachments and request settings', async () => {
  const image = { type: 'localImage', path: '/tmp/example.png' };
  const message = { id: 8, method: 'turn/start', params: { threadId: 'a', model: 'main', input: [
    { type: 'text', text: 'fix this', text_elements: [{ byteRange: { start: 0, end: 3 } }] }, image,
  ] } };
  const result = await rewriteRequest(message, async () => 'Please fix this. You got this!');
  assert.equal(result.params.input[0].text, 'Please fix this. You got this!');
  assert.deepEqual(result.params.input[0].text_elements, []);
  assert.equal(result.params.input[1], image);
  assert.equal(result.params.model, 'main');
  assert.equal(message.params.input[0].text, 'fix this');
  assert.equal((await rewriteRequest({ ...message, method: 'turn/steer' }, async () => 'Thanks')).params.input[0].text, 'Thanks');
});

test('leaves unrelated protocol requests and textless turns untouched', async () => {
  const rewrite = () => { throw new Error('must not run'); };
  const request = { id: 1, method: 'thread/start', params: { input: 'unchanged' } };
  assert.equal(await rewriteRequest(request, rewrite), request);
  const result = await rewriteRequest({ method: 'turn/start', params: { input: [{ type: 'image', url: 'x' }] } }, rewrite);
  assert.deepEqual(result.params.input, [{ type: 'image', url: 'x' }]);
});

test('bridge sends rewritten input to app-server and relays approvals unchanged', async (t) => {
  const { exchange } = await fixture(t);
  const result = await exchange({ id: 2, method: 'turn/start', params: { threadId: 'a', input: [{ type: 'text', text: 'do it' }] } });
  assert.equal(result.params.params.input[0].text, 'Please do it');
  const approval = { id: 'approval-1', result: { decision: 'accept' } };
  assert.deepEqual((await exchange(approval)).params, approval);
});

test('rewrite failure forwards the whole original request without partial changes', async (t) => {
  const { exchange } = await fixture(t, async (text) => {
    if (text === 'second') throw new Error('sensitive prompt diagnostics');
    return 'Rewritten first';
  });
  const message = { id: 3, method: 'turn/steer', params: { threadId: 'a', input: [
    { type: 'text', text: 'private angry text\r\n  ', text_elements: [{ start: 0, end: 7 }] },
    { type: 'image', url: 'keep' }, { type: 'text', text: 'second' },
  ] } };
  const result = await exchange(message);
  assert.deepEqual(result.params, message);
  assert.equal((await exchange({ id: 4, method: 'ping' })).params.id, 4);
});

test('local bridge rejects a second client and closes its listener', async (t) => {
  const { bridge } = await fixture(t);
  const second = new WebSocket(bridge.url, { headers: { Authorization: `Bearer ${bridge.token}` } });
  const closed = once(second, 'close');
  await once(second, 'open');
  assert.equal((await closed)[0], 1008);
  await bridge.close();
  const after = new WebSocket(bridge.url);
  await once(after, 'error');
});

test('the bridge rejects missing and incorrect bearer tokens without disturbing its client', async (t) => {
  const { bridge, exchange } = await fixture(t);
  for (const headers of [{}, { Authorization: 'Bearer incorrect' }, { Authorization: bridge.token }]) {
    const wrong = new WebSocket(bridge.url, { headers });
    assert.match((await once(wrong, 'error'))[0].message, /401/);
  }
  assert.equal((await exchange({ id: 5, method: 'ping' })).params.id, 5);
});

test('the bridge rejects paths even with the correct bearer token', async (t) => {
  const { bridge } = await fixture(t);
  const wrong = new WebSocket(new URL('/wrong-path', bridge.url), { headers: { Authorization: `Bearer ${bridge.token}` } });
  assert.match((await once(wrong, 'error'))[0].message, /400/);
});

test('interrupting a rewrite aborts it and frees the next prompt without waiting for completion', { timeout: 3000 }, async (t) => {
  let release;
  let started;
  let signal;
  const waiting = new Promise((resolve) => { started = resolve; });
  const { socket } = await fixture(t, async (text, context) => {
    if (text === 'next') return 'Please proceed.';
    signal = context.signal;
    started();
    return new Promise((resolve) => { release = resolve; });
  });
  socket.send(JSON.stringify({ id: 10, method: 'turn/start', params: { threadId: 'a', input: [{ type: 'text', text: 'cancel me' }] } }));
  await waiting;
  const messages = [];
  const received = new Promise((resolve) => socket.on('message', (data) => {
    messages.push(JSON.parse(data));
    if (messages.length === 3) resolve();
  }));
  socket.send(JSON.stringify({ id: 11, method: 'turn/interrupt', params: { threadId: 'a', turnId: 't' } }));
  socket.send(JSON.stringify({ id: 12, method: 'turn/start', params: { threadId: 'a', input: [{ type: 'text', text: 'next' }] } }));
  await received;
  assert.equal(signal.aborted, true);
  assert.ok(messages.some((message) => message.params?.method === 'turn/interrupt'));
  assert.equal(messages.find((message) => message.params?.id === 12).params.params.input[0].text, 'Please proceed.');
  const result = messages.find((message) => message.id === 10);
  assert.equal(result.id, 10);
  assert.equal(result.error.message, 'Prompt submission canceled.');
  release('Please cancel me.');
});

test('consecutive start and steering submissions keep their original order', async (t) => {
  const calls = [];
  const { socket } = await fixture(t, async (text) => { calls.push(text); return `Please ${text}`; });
  const results = [];
  const received = new Promise((resolve) => socket.on('message', (data) => {
    results.push(JSON.parse(data).params);
    if (results.length === 2) resolve();
  }));
  for (const [id, method, text] of [[12, 'turn/start', 'first'], [13, 'turn/steer', 'second']]) {
    socket.send(JSON.stringify({ id, method, params: { threadId: 'a', input: [{ type: 'text', text }] } }));
  }
  await received;
  assert.deepEqual(calls, ['first', 'second']);
  assert.deepEqual(results.map((result) => result.id), [12, 13]);
});

test('rawdog bypasses the whole prompt including later text items and preserves span metadata', async () => {
  for (const method of ['turn/start', 'turn/steer']) {
    const message = { method, params: { input: [
      { type: 'image', url: 'unchanged' },
      { type: 'text', text: ' \t\nRaWdOg\nFuck this.  \n', text_elements: [{ start: 0, end: 6 }] },
      { type: 'text', text: 'Leave this alone too.' },
    ] } };
    assert.equal(await rewriteRequest(message, () => { throw new Error('must not rewrite'); }), message);
  }
});

test('rewrite callbacks receive the native turn directory and keep it for steering', async (t) => {
  const seen = [];
  const f = await fixture(t, async (text, context) => { seen.push(context.cwd); return 'Please fix it.'; });
  await f.exchange({ id: 1, method: 'turn/start', params: { threadId: 'a', cwd: '/agents/outside', input: [{ type: 'text', text: 'fix it' }] } });
  await f.exchange({ id: 2, method: 'turn/steer', params: { threadId: 'a', input: [{ type: 'text', text: 'also this' }] } });
  assert.deepEqual(seen, ['/agents/outside', '/agents/outside']);
});
