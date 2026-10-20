import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { WebSocket } from 'ws';
import { register } from '../hooks/register.js';
import { startCodexBridge } from '../src/codex-bridge.js';
import { startInspector } from '../src/inspection.js';
import { runPaseoProvider } from '../src/paseo.js';

test('Claude helper requests skip rewriting and inspection, including rawdog requests', async () => {
  let hook;
  register((event, handler) => { hook = handler; return { catch() {} }; });
  for (const marker of ['TURBOCOMMIT_DISABLED', 'GLAZE_AGAINST_THE_MACHINE_ACTIVE']) {
    const $ = {
      env: { get: async (name) => name === marker ? '1' : undefined },
      fs: { exists() { assert.fail('helper prompts must not be inspected'); } },
      model: { complete() { assert.fail('helper prompts must not be rewritten'); } },
    };
    for (const text of ['Write a commit headline from this transcript.', 'rawdog\nKeep this helper unchanged.']) {
      const event = { text, origin: { kind: 'sdk' }, attachments: [{ type: 'image' }] };
      let delivered = 0;
      assert.equal(await hook($, event, (forwarded) => { delivered++; return forwarded; }), event);
      assert.equal(delivered, 1);
    }
  }
});

test('Codex helper processes forward their original requests without rewriting or inspection', async (t) => {
  for (const marker of ['TURBOCOMMIT_DISABLED', 'GLAZE_AGAINST_THE_MACHINE_ACTIVE']) {
    const directory = await mkdtemp(join(tmpdir(), 'glazer-helper-test-'));
    let bridge, socket, inspector;
    t.after(async () => {
      socket?.terminate();
      await bridge?.close();
      await inspector?.stop();
      await rm(directory, { recursive: true, force: true });
    });
    let captured = '';
    inspector = await startInspector({ directory, json: true, output: { write: (text) => { captured += text; } } });
    const command = join(directory, 'fake-codex');
    await writeFile(command, `#!${process.execPath}\nprocess.stdin.pipe(process.stdout);`, { mode: 0o700 });
    bridge = await startCodexBridge({ command, env: { ...process.env, [marker]: '1', GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: directory },
      rewrite: () => assert.fail('helper prompts must not be rewritten'),
    });
    socket = new WebSocket(bridge.url, { headers: { Authorization: `Bearer ${bridge.token}` } });
    await once(socket, 'open');
    for (const method of ['turn/start', 'turn/steer']) {
      const message = { id: 1, method, params: { threadId: 'helper', input: [{ type: 'text', text: 'Write a commit headline.' }] } };
      const response = once(socket, 'message');
      socket.send(JSON.stringify(message));
      assert.deepEqual(JSON.parse((await response)[0]), message);
    }
    await inspector.drain();
    assert.equal(captured, '');
  }
});

test('Paseo helper processes pass native transport bytes through without rewriting', async () => {
  for (const marker of ['TURBOCOMMIT_DISABLED', 'GLAZE_AGAINST_THE_MACHINE_ACTIVE']) {
    const input = new PassThrough();
    const output = new PassThrough();
    let forwarded = '';
    output.on('data', (chunk) => { forwarded += chunk; });
    const done = runPaseoProvider('codex', process.execPath, ['-e', 'process.stdin.pipe(process.stdout);', '--', 'app-server'], {
      input, output, env: { ...process.env, [marker]: '1' }, diagnostics: new PassThrough(),
      rewrite: () => assert.fail('helper prompts must not be rewritten'),
    });
    const source = 'native transport is untouched\r\n';
    input.end(source);
    assert.equal(await done, 0);
    assert.equal(forwarded, source);
  }
});
