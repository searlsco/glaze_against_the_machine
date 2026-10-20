import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { runPaseoProvider } from '../src/paseo.js';

async function fixture(t, provider, rewrite, args = ['app-server'], env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-paseo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'native.cjs');
  await writeFile(script, `process.stdout.write(JSON.stringify({args:process.argv.slice(2), interactiveSession:process.env.GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION})+'\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line',l=>process.stdout.write(l+'\\n'));`);
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let buffer = '';
  const messages = [];
  output.on('data', (data) => {
    buffer += data;
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, n)));
      buffer = buffer.slice(n + 1);
      output.emit('frame');
    }
  });
  const waitFor = async (count) => { while (messages.length < count) await once(output, 'frame'); };
  const done = runPaseoProvider(provider, process.execPath, [script, ...args], { input, output, diagnostics, rewrite, env: { ...process.env, ...env, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: join(directory, 'inspect') } });
  await waitFor(1);
  return { input, output, messages, done, waitFor };
}

test('Paseo Claude preserves stream-json stdin and loads the native mod', async (t) => {
  const f = await fixture(t, 'claude', undefined, ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  const frame = { type: 'user', message: { role: 'user', content: 'hello' } };
  f.input.end(JSON.stringify(frame) + '\n');
  assert.equal(await f.done, 0);
  assert.deepEqual(f.messages[0].args.slice(0, 4), ['--input-format', 'stream-json', '--output-format', 'stream-json']);
  assert.ok(f.messages[0].args.includes('--plugin-dir'));
  assert.equal(f.messages[0].interactiveSession, f.messages[0].args[f.messages[0].args.indexOf('--session-id') + 1]);
  assert.match(f.messages[0].interactiveSession, /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.messages[1], frame);
});

test('Paseo binds resumed SDK chats and clears inherited grants for helpers and unresolved sessions', async (t) => {
  const sessionId = 'b323c435-7ef7-4097-a280-eedaf9fa9f02';
  for (const [args, env, expected] of [
    [['--resume', sessionId], {}, sessionId],
    [['--continue'], {}, undefined],
    [['--resume', 'session-name'], {}, undefined],
    [[], { TURBOCOMMIT_DISABLED: '1' }, undefined],
    [['--version'], {}, undefined],
  ]) {
    const f = await fixture(t, 'claude', undefined, args, { GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION: 'inherited', ...env });
    f.input.end();
    assert.equal(await f.done, 0);
    assert.equal(f.messages[0].interactiveSession, expected);
    if (!expected) assert.ok(!f.messages[0].args.includes('--session-id'));
  }
});

test('Paseo Codex rewrites initial and follow-up requests, retaining images and approvals', async (t) => {
  const f = await fixture(t, 'codex', async (text) => `Please ${text}`);
  const image = { type: 'localImage', path: '/tmp/example.png' };
  for (const [id, method] of [[1, 'turn/start'], [2, 'turn/steer']]) {
    f.input.write(JSON.stringify({ id, method, params: { threadId: 'a', input: [{ type: 'text', text: 'fix this' }, image] } }) + '\n');
  }
  await f.waitFor(3);
  const approval = { id: 'approval', result: { decision: 'accept' } };
  f.input.end(JSON.stringify(approval) + '\n');
  assert.equal(await f.done, 0);
  for (const result of f.messages.slice(1, 3)) {
    assert.equal(result.params.input[0].text, 'Please fix this');
    assert.deepEqual(result.params.input[1], image);
  }
  assert.deepEqual(f.messages[3], approval);
});

test('Paseo failed rewrite forwards the original, then permits another rewrite', async (t) => {
  const f = await fixture(t, 'codex', async (text) => {
    if (text === 'private original') throw new Error('private diagnostics');
    return 'Thank you';
  });
  for (const [id, text] of [[1, 'private original'], [2, 'retry']]) {
    f.input.write(JSON.stringify({ id, method: 'turn/start', params: { input: [{ type: 'text', text }] } }) + '\n');
  }
  f.input.end();
  assert.equal(await f.done, 0);
  assert.equal(f.messages[1].id, 1);
  assert.deepEqual(f.messages[1], { id: 1, method: 'turn/start', params: { input: [{ type: 'text', text: 'private original' }] } });
  assert.doesNotMatch(JSON.stringify(f.messages), /diagnostics/);
  assert.equal(f.messages[2].params.input[0].text, 'Thank you');
});

test('Paseo interrupt aborts the pending rewrite and permits the next prompt immediately', { timeout: 3000 }, async (t) => {
  let release;
  let started;
  let signal;
  const waiting = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, 'codex', (text, context) => {
    if (text === 'next') return 'Please proceed.';
    signal = context.signal;
    started(); return new Promise((resolve) => { release = resolve; });
  });
  f.input.write(JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: 'a', input: [{ type: 'text', text: 'cancel' }] } }) + '\n');
  await waiting;
  f.input.write(JSON.stringify({ id: 2, method: 'turn/interrupt', params: { threadId: 'a' } }) + '\n');
  f.input.write(JSON.stringify({ id: 3, method: 'turn/start', params: { threadId: 'a', input: [{ type: 'text', text: 'next' }] } }) + '\n');
  await f.waitFor(4);
  assert.equal(signal.aborted, true);
  assert.ok(f.messages.some((message) => message.method === 'turn/interrupt'));
  assert.match(f.messages.find((message) => message.id === 1).error.message, /canceled/);
  assert.equal(f.messages.find((message) => message.id === 3).params.input[0].text, 'Please proceed.');
  f.input.end();
  assert.equal(await f.done, 0);
  release('Please cancel');
});

test('Paseo native version probes bypass model calls and plugin arguments', async (t) => {
  for (const provider of ['claude', 'codex']) {
    const f = await fixture(t, provider, () => { throw new Error('must not rewrite'); }, ['--version']);
    f.input.end();
    assert.equal(await f.done, 0);
    assert.deepEqual(f.messages[0].args, ['--version']);
  }
});

test('Paseo keeps native split frames intact while forwarding fallback requests', { timeout: 3000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-paseo-frames-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'native.cjs');
  await writeFile(script, `
    process.stdout.write('{"id":99,"result":');
    process.stderr.write('ready');
    let count = 0;
    require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write(++count === 1 ? '{} }\\n' : '{"id":100,"result":{}}\\n'));
  `);
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let content = '';
  let completed = false;
  output.on('data', (chunk) => {
    content += chunk;
    if (!completed && content.includes('\n')) {
      completed = true;
      input.end(JSON.stringify({ id: 2, method: 'ping' }) + '\n');
    }
  });
  diagnostics.once('data', () => input.write(JSON.stringify({
    id: 1, method: 'turn/start', params: { input: [{ type: 'text', text: 'source' }] },
  }) + '\n'));
  const result = await runPaseoProvider('codex', process.execPath, [script, 'app-server'], {
    input, output, diagnostics, rewrite: async () => { throw new Error('synthetic rewrite failure'); },
  });
  assert.equal(result, 0);
  const frames = content.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames, [{ id: 99, result: {} }, { id: 100, result: {} }]);
});
