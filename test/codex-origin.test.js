import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startCodexBridge } from '../src/codex-bridge.js';
import { createCodexOrigins } from '../src/codex-origin.js';
import { startInspector } from '../src/inspection.js';
import { runPaseoProvider } from '../src/paseo.js';

test('title helpers are identified by thread metadata, independently of persistence and source client', () => {
  const origins = createCodexOrigins();
  for (const method of ['result', 'thread/started']) {
    for (const [id, threadSource] of [['title', 'thread_title'], ['user', 'user'], ['unknown', null]]) {
      const thread = { id, threadSource, ephemeral: true, source: 'vscode', originator: 'codex-tui' };
      origins.observe(method === 'result' ? { result: { thread } } : { method, params: { thread } });
    }
    assert.equal(origins.isHelper({ params: { threadId: 'title' } }), true);
    assert.equal(origins.isHelper({ params: { threadId: 'user' } }), false);
    assert.equal(origins.isHelper({ params: { threadId: 'unknown' } }), false);
    assert.equal(origins.isHelper({ params: { threadId: 'unseen' } }), false);
    origins.observe({ result: { thread: { id: 'title' } } });
    assert.equal(origins.isHelper({ params: { threadId: 'title' } }), true);
  }
});

// This backend returns the same source classification as the native TUI's
// thread/start response. No inference is needed to exercise helper routing.
const backend = `require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  const response = message.method === 'thread/start'
    ? { id: message.id, result: { thread: { id: message.params.threadSource, threadSource: message.params.threadSource, ephemeral: true, source: 'vscode', originator: 'codex-tui' } } }
    : message;
  process.stdout.write(JSON.stringify(response) + '\\n');
});`;

for (const transport of ['terminal', 'paseo']) {
  test(`${transport} skips title turns before rewriting and capture while preserving human ephemeral turns`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glazer-title-test-'));
    let bridge, socket, inspector, input, done;
    t.after(async () => {
      socket?.terminate();
      await bridge?.close();
      input?.end();
      await done;
      await inspector?.stop();
      await rm(directory, { recursive: true, force: true });
    });
    let captured = '';
    inspector = await startInspector({ directory, json: true, output: { write: (text) => { captured += text; } } });
    const env = { ...process.env, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: directory };
    const calls = [];
    const rewrite = async (text) => { calls.push(text); return 'Please improve the code quality.'; };
    let exchange;
    if (transport === 'terminal') {
      const command = join(directory, 'fake-codex');
      await writeFile(command, `#!${process.execPath}\n${backend}`, { mode: 0o700 });
      bridge = await startCodexBridge({ command, env, rewrite });
      socket = new WebSocket(bridge.url, { headers: { Authorization: `Bearer ${bridge.token}` } });
      await once(socket, 'open');
      exchange = async (message) => {
        const response = once(socket, 'message');
        socket.send(JSON.stringify(message));
        return JSON.parse((await response)[0]);
      };
    } else {
      input = new PassThrough();
      const output = new PassThrough();
      const frames = new EventEmitter();
      let buffered = '';
      output.on('data', (chunk) => {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf('\n')) >= 0) {
          frames.emit('message', JSON.parse(buffered.slice(0, newline)));
          buffered = buffered.slice(newline + 1);
        }
      });
      done = runPaseoProvider('codex', process.execPath, ['-e', backend, '--', 'app-server'], { input, output, env, rewrite, diagnostics: new PassThrough() });
      exchange = async (message) => {
        const response = once(frames, 'message');
        input.write(JSON.stringify(message) + '\n');
        return (await response)[0];
      };
    }
    await exchange({ id: 1, method: 'thread/start', params: { ephemeral: true, threadSource: 'thread_title' } });
    for (const method of ['turn/start', 'turn/steer']) {
      const title = { id: 2, method, params: { threadId: 'thread_title', input: [{ type: 'text', text: 'Generate a concise task title.' }] } };
      assert.deepEqual(await exchange(title), title);
    }
    await inspector.drain();
    assert.equal(captured, '');
    await exchange({ id: 3, method: 'thread/start', params: { ephemeral: true, threadSource: 'user' } });
    const human = await exchange({ id: 4, method: 'turn/start', params: { threadId: 'user', input: [{ type: 'text', text: 'Improve the code quality.' }] } });
    assert.equal(human.params.input[0].text, 'Please improve the code quality.');
    assert.deepEqual(calls, ['Improve the code quality.']);
    await inspector.drain();
    assert.deepEqual(captured.trim().split('\n').map((line) => JSON.parse(line).session), ['user', 'user']);
  });
}
