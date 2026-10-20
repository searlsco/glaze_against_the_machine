import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { startCodexBridge } from '../src/codex-bridge.js';
import { runPaseoProvider } from '../src/paseo.js';
import { native } from './support/codex-native.js';

const polished = 'Please fix it; thank you for your effort, and I wish you success.';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-worker-integration-'));
  const capture = join(directory, 'events.jsonl');
  const destination = join(directory, 'destination.cjs');
  await writeFile(join(directory, 'codex'), native, { mode: 0o755 });
  await writeFile(destination, `#!${process.execPath}
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      process.stdout.write(JSON.stringify({method: 'received', params: JSON.parse(line)}) + '\\n');
    });
  `, { mode: 0o755 });
  const env = { ...process.env, HOME: directory, CODEX_HOME: directory,
    PATH: directory + delimiter + process.env.PATH,
    WORKER_CAPTURE: capture, GLAZE_AGAINST_THE_MACHINE_MODEL: 'test-model',
    WORKER_ECHO_INPUT_DIAGNOSTICS: '1',
    GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: join(directory, 'inspect'),
    WORKER_GLAZE_RESPONSE: JSON.stringify({body: polished, appreciation: 'thank you for your effort',
      workRequested: true, encouragement: 'I wish you success'}),
  };
  delete env.GLAZE_AGAINST_THE_MACHINE_ACTIVE;
  delete env.TURBOCOMMIT_DISABLED;
  const events = async () => {
    try { return (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  t.after(async () => {
    for (const event of await events()) {
      if (event.event !== 'spawn' || !event.args.includes('app-server')) continue;
      try { process.kill(event.pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, destination, env, events };
}

function request(id) {
  return {id, method: id === 1 ? 'turn/start' : 'turn/steer',
    params: {threadId: 'human-thread', input: [{type: 'text', text: 'Fix it.'}]}};
}

async function assertReused(events) {
  const recorded = await events();
  const servers = recorded.filter(event => event.event === 'spawn' && event.args.includes('app-server'));
  assert.equal(servers.length, 1);
  assert.equal(recorded.filter(event => event.method === 'thread/start').length, 2);
  assert.equal(recorded.filter(event => event.method === 'turn/start').length, 2);
  assert.equal(recorded.filter(event => event.method === 'thread/unsubscribe').length, 2);
  assert.equal(recorded.filter(event => event.event === 'spawn' && event.args.includes('mcp')).length, 0);
  return servers[0];
}

async function assertCleaned(server) {
  assert.throws(() => process.kill(server.pid, 0), {code: 'ESRCH'});
  assert.throws(() => process.kill(server.parentPid, 0), {code: 'ESRCH'});
  await assert.rejects(stat(server.home), {code: 'ENOENT'});
}

test('default Codex bridge rewrites two prompts through one worker and reaps it on close', { timeout: 5000 }, async t => {
  const { directory, destination, env, events } = await fixture(t);
  let diagnosticText = '';
  t.mock.method(process.stderr, 'write', (chunk, encoding, callback) => {
    diagnosticText += chunk;
    (typeof encoding === 'function' ? encoding : callback)?.();
    return true;
  });
  const bridge = await startCodexBridge({command: destination, env, cwd: directory});
  t.after(() => bridge.close());
  const socket = new WebSocket(bridge.url, {headers: {Authorization: `Bearer ${bridge.token}`}});
  await once(socket, 'open');
  assert.deepEqual(await events(), []);
  for (const id of [1, 2]) {
    const response = once(socket, 'message');
    socket.send(JSON.stringify(request(id)));
    const echoed = JSON.parse((await response)[0].toString());
    assert.equal(echoed.params.params.input[0].text, polished);
    assert.equal(echoed.params.id, id);
  }
  const server = await assertReused(events);
  await bridge.close();
  await assertCleaned(server);
  assert.doesNotMatch(diagnosticText, /Fix it\./);
});

test('default Paseo Codex wrapper rewrites two prompts through one worker and reaps it on EOF', { timeout: 5000 }, async t => {
  const { directory, destination, env, events } = await fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  let diagnosticText = '', buffer = '';
  diagnostics.on('data', chunk => { diagnosticText += chunk; });
  const messages = [];
  output.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      output.emit('frame');
    }
  });
  const done = runPaseoProvider('codex', process.execPath, [destination, 'app-server'], {
    input, output, diagnostics, env, cwd: directory,
  });
  t.after(async () => { input.end(); await done; });
  assert.deepEqual(await events(), []);
  for (const id of [1, 2]) {
    input.write(JSON.stringify(request(id)) + '\n');
    while (messages.length < id) await once(output, 'frame');
    assert.equal(messages[id - 1].params.params.input[0].text, polished);
    assert.equal(messages[id - 1].params.id, id);
  }
  const server = await assertReused(events);
  input.end();
  assert.equal(await done, 0);
  await assertCleaned(server);
  assert.doesNotMatch(diagnosticText, /Fix it\./);
});
