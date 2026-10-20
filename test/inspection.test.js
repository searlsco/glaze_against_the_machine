import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import { startInspector, recordInspection, inspectionFiles, reportFailure } from '../src/inspection.js';
import { captureInspection, inspectionViewers, viewerRegistryNames } from '../src/inspection-record.js';
import { leaseViewer } from '../src/inspection-viewers.js';
import { runPaseoProvider } from '../src/paseo.js';
import { formatInspection } from '../src/inspection-format.js';
import { createOwnerResolver } from '../src/inspection-owner.js';
import { register } from '../hooks/register.js';

async function fixture(t, json = true) {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-inspect-'));
  let displayed = '';
  const output = { write: (text) => { displayed += text; } };
  const inspector = await startInspector({ directory, output, json, resolveOwner: async (record) => record.owner || record.provider });
  t.after(async () => { await inspector.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, inspector, output, text: () => displayed, env: { ...process.env, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: directory } };
}

test('inspector is opt-in, captures exact text, and removes private temporary files', async (t) => {
  const f = await fixture(t);
  const activePath = join(f.directory, viewerRegistryNames().at(-1));
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(activePath)).mode & 0o777, 0o600);
  const { session } = JSON.parse((await readFile(activePath, 'utf8')).trim());
  const record = { provider: 'codex', method: 'turn/start', texts: ['RaWdOg\r\n`exact`  \n'], bypass: true };
  await recordInspection(record, f.env);
  await f.inspector.drain();
  assert.deepEqual(JSON.parse(f.text()).texts, record.texts);
  assert.deepEqual(await readdir(join(f.directory, session)), ['owner']);
  await f.inspector.stop();
  await recordInspection(record, f.env);
  assert.equal((await inspectionViewers(f.directory, inspectionFiles)).size, 0);
  assert.ok((await readdir(f.directory)).every((name) => /^viewers-\d+\.jsonl$/.test(name)));
});

test('concurrent viewers receive every capture independently and can stop independently', async (t) => {
  const f = await fixture(t);
  const displayed = ['', ''];
  const others = await Promise.all(displayed.map((_, index) => startInspector({ directory: f.directory,
    output: { write: (text) => { displayed[index] += text; } }, json: true,
    resolveOwner: async () => 'codex',
  })));
  t.after(() => Promise.all(others.map((inspector) => inspector.stop())));
  const first = { provider: 'codex', texts: ['exact\r\n  '], failure: 'Rewrite failed.' };
  await recordInspection(first, f.env);
  await Promise.all([f.inspector, ...others].map((inspector) => inspector.drain()));
  assert.equal(displayed[0], f.text());
  assert.equal(displayed[1], f.text());
  await others[0].stop();
  await recordInspection({ ...first, texts: ['second'] }, f.env);
  await Promise.all([f.inspector, others[1]].map((inspector) => inspector.drain()));
  assert.equal(displayed[1], f.text());
  assert.equal(displayed[0].trim().split('\n').length, 1);
  assert.equal(displayed[1].trim().split('\n').length, 2);
});

test('expired leases are ignored and their private inboxes are recovered', async (t) => {
  const f = await fixture(t);
  await f.inspector.stop();
  const stale = 'dead-beef';
  await writeFile(join(f.directory, viewerRegistryNames().at(-1)), JSON.stringify({ session: stale, expiresAt: 0 }) + '\n');
  await captureInspection(f.directory, { texts: ['must not capture'] }, inspectionFiles);
  const inspector = await startInspector({ directory: f.directory, output: f.output });
  await inspector.stop();
  assert.equal((await inspectionViewers(f.directory, inspectionFiles)).size, 0);
  assert.ok((await readdir(f.directory)).every((name) => /^viewers-\d+\.jsonl$/.test(name)));
});

test('viewer renders terminal control characters visibly without changing JSON captures', async (t) => {
  const f = await fixture(t, false);
  await recordInspection({ provider: 'codex', method: 'turn/steer', texts: ['hello\x1b[2J\r\nworld'] }, f.env);
  await f.inspector.drain();
  assert.match(f.text(), /hello\\u001b\[2J\\u000d\nworld/);
  assert.ok(!f.text().includes('\x1b'));
});

test('Paseo captures exactly the Codex request text forwarded to the native backend', async (t) => {
  const f = await fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  let native = '';
  output.on('data', (chunk) => { native += chunk; output.emit('frame'); });
  const script = "require('node:readline').createInterface({input:process.stdin}).on('line',l=>process.stdout.write(l+'\\n'))";
  const done = runPaseoProvider('codex', process.execPath, ['-e', script, '--', 'app-server'], {
    input, output, env: f.env, diagnostics: new PassThrough(),
    rewrite: async (text) => { if (text === 'failure') throw new Error('private'); return 'Please fix `a.ts`.\n'; },
  });
  const texts = ['angry original', 'RaWdOg\nunchanged  \n', 'failure'];
  for (const [id, text] of texts.entries()) {
    input.write(JSON.stringify({ id, method: id === 1 ? 'turn/steer' : 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text }, { type: 'image', url: 'keep' }] } }) + '\n');
  }
  input.end();
  assert.equal(await done, 0);
  await f.inspector.drain();
  const forwarded = native.trim().split('\n').map((line) => JSON.parse(line));
  const records = f.text().trim().split('\n').map((line) => JSON.parse(line)).filter((record) => record.event === 'rewrite_completed');
  assert.equal(records.length, 3);
  assert.equal(records[0].originalTexts[0], texts[0]);
  assert.equal(records[0].session, 'thread');
  for (const [index, record] of records.entries()) {
    const request = forwarded.find((message) => message.id === index);
    assert.deepEqual(record.texts, request.params.input.filter((item) => item.type === 'text').map((item) => item.text));
  }
  assert.equal(records[2].failure, 'Rewrite failed.');
  assert.deepEqual(records[2].texts, ['failure']);
  assert.doesNotMatch(f.text(), /private/);
  assert.ok(f.text().includes('angry original'));
  assert.equal(records.find((record) => record.bypass).texts[0], texts[1]);
});

test('Claude mod captures its exact downstream text, bypasses, and rewrite failures', async (t) => {
  const f = await fixture(t);
  let hook;
  register((event, handler) => { hook = handler; return { catch() {} }; });
  const $ = { session: { id: async () => 'claude-session-id', cwd: async () => f.directory }, fs: inspectionFiles, env: { get: async (name) => f.env[name] }, model: { complete: async () => JSON.stringify({ body: 'Please fix it. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' }) } };
  for (const text of ['angry original', 'rawdog\nleave me alone  \n']) {
    const e = { text, origin: { kind: 'composer' } };
    const result = await hook($, e, async (event) => event);
    await f.inspector.drain();
    const records = f.text().trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.at(-1).texts[0], result.text);
    assert.equal(records.at(-1).originalTexts[0], text);
    assert.equal(records.at(-1).session, 'claude-session-id');
  }
  $.model.complete = async () => { throw new Error('private'); };
  const original = { text: 'failure', origin: { kind: 'composer' } };
  assert.equal(await hook($, original, (event) => event), original);
  await f.inspector.drain();
  const last = JSON.parse(f.text().trim().split('\n').at(-1));
  assert.deepEqual(last.texts, ['failure']);
  assert.deepEqual(last.originalTexts, last.texts);
  assert.equal(last.failure, 'Rewrite failed.');
  assert.doesNotMatch(f.text(), /private/);
  assert.ok(f.text().includes('angry original'));
});

test('capture retries transient lease reads and writes without duplicate records', async (t) => {
  const f = await fixture(t);
  let reads = 0, writes = 0;
  await captureInspection(f.directory, { texts: ['original'], failure: 'Rewrite failed.' }, {
    ...inspectionFiles,
    read: async (path) => { if (++reads === 1) throw new Error('transient read'); return inspectionFiles.read(path); },
    write: async (path, content) => { if (++writes === 1) throw new Error('transient write'); return inspectionFiles.write(path, content); },
  });
  await f.inspector.drain();
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal(JSON.parse(f.text()).failure, 'Rewrite failed.');
});

test('broken inspection reads, writes, and metadata never block Claude delivery', async (t) => {
  const f = await fixture(t);
  let hook;
  register((event, handler) => { hook = handler; return { catch() {} }; });
  const $ = { env: { get: async (name) => f.env[name] }, session: { cwd: async () => f.directory, id: async () => { throw new Error('metadata'); } },
    fs: { ...inspectionFiles, write: async () => { throw new Error('disk'); } }, model: { complete: async () => { throw new Error('provider'); } },
  };
  for (const text of ['needs rewrite', ' \t\nrawdog\r\noriginal  ']) {
    const event = { text, origin: { kind: 'composer' } };
    assert.equal(await hook($, event, (event) => event), event);
  }
  await captureInspection(f.directory, { texts: ['original'] }, { exists: async () => { throw new Error('permissions'); } });
  await f.inspector.drain();
  assert.equal(f.text(), '');
});

test('stopping inspection during a capture does not block submission', async (t) => {
  const f = await fixture(t);
  await captureInspection(f.directory, { texts: ['prompt'] }, {
    ...inspectionFiles,
    write: async () => { await f.inspector.stop(); throw new Error('inbox was removed'); },
  });
  assert.equal((await inspectionViewers(f.directory, inspectionFiles)).size, 0);
  assert.ok((await readdir(f.directory)).every((name) => /^viewers-\d+\.jsonl$/.test(name)));
});

test('asynchronous diagnostic stream errors do not abort fallback delivery', async () => {
  const diagnostics = new Writable({ write(chunk, encoding, callback) { setImmediate(() => callback(new Error('closed pipe'))); } });
  const failed = once(diagnostics, 'error');
  reportFailure('Rewrite failed.', diagnostics);
  assert.equal((await failed)[0].message, 'closed pipe');
});

test('leases survive minute rotation, stop immediately, and expire after a killed viewer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-leases-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1792450799999;
  t.mock.method(Date, 'now', () => now);
  await leaseViewer(directory, 'aaaa-bbbb', true);
  now++;
  await leaseViewer(directory, 'cccc-dddd', true);
  assert.equal((await inspectionViewers(directory, inspectionFiles)).size, 2);
  await leaseViewer(directory, 'aaaa-bbbb', false);
  assert.deepEqual([...(await inspectionViewers(directory, inspectionFiles)).keys()], ['cccc-dddd']);
  now += 15001;
  assert.equal((await inspectionViewers(directory, inspectionFiles)).size, 0);
});

test('viewer cleanup preserves living owners and removes crashed owners private captures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-owners-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await leaseViewer(directory, 'aaaa-bbbb', true);
  const gone = spawnSync(process.execPath, ['-e', '']);
  assert.equal(gone.status, 0);
  const stale = join(directory, 'cccc-dddd');
  await mkdir(stale);
  await writeFile(join(stale, 'owner'), String(gone.pid));
  await writeFile(join(stale, 'capture.json'), 'private capture');
  await leaseViewer(directory, 'eeee-ffff', true);
  await assert.rejects(stat(stale), { code: 'ENOENT' });
  assert.ok((await stat(join(directory, 'aaaa-bbbb'))).isDirectory());
});

test('firehose puts owner and native session on one line, then original and glazed prompts', () => {
  const record = { provider: 'codex', session: 'native-id', method: 'turn/steer', originalTexts: ['ugh\nfix it  '], texts: ['Please fix it.'], bypass: false };
  const rendered = formatInspection(record, 'Agent\nName');
  assert.match(rendered, /^=+\nAgent Name \| codex \| session-id: native-id \| turn\/steer\noriginal prompt:\nugh\nfix it  \n\n-+ glazed -+\nglazed prompt:\nPlease fix it\.\n=+\n\n$/);
});

test('owner lookup resolves each Paseo agent once and falls back without blocking other owners', async () => {
  const calls = [];
  const resolve = createOwnerResolver({ run: async (command, args) => {
    calls.push(args[1]);
    if (args[1] === 'missing') throw new Error('not available');
    return { stdout: JSON.stringify({ Name: 'Agent ' + args[1] }) };
  } });
  assert.equal(await resolve({ agentId: 'a' }), 'Agent a');
  assert.equal(await resolve({ agentId: 'b' }), 'Agent b');
  assert.equal(await resolve({ agentId: 'a' }), 'Agent a');
  assert.equal(await resolve({ agentId: 'missing' }), 'Paseo missing');
  assert.equal(await resolve({ provider: 'claude' }), 'claude terminal');
  assert.deepEqual(calls, ['a', 'b', 'missing']);
});

test('CLI filters join the same firehose with original and glazed text', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const f = await fixture(t);
  const source = 'rawdog\nCLI exact text  \n';
  const result = spawnSync(process.execPath, [new URL('../bin/glaze_against_the_machine.js', import.meta.url).pathname], { env: f.env, input: source, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, source);
  await f.inspector.drain();
  const record = JSON.parse(f.text());
  assert.deepEqual(record.originalTexts, [source]);
  assert.deepEqual(record.texts, [source]);
  assert.match(record.session, /^process-/);
});

test('CLI rewrite failures report to every viewer and preserve exact stdout', async (t) => {
  const f = await fixture(t);
  let secondText = '';
  const second = await startInspector({ directory: f.directory, json: true,
    output: { write: (text) => { secondText += text; } }, resolveOwner: async (record) => record.owner || record.provider,
  });
  t.after(() => second.stop());
  const source = 'original fallback\r\n`literal`  ';
  const result = spawnSync(process.execPath, [new URL('../bin/glaze_against_the_machine.js', import.meta.url).pathname], {
    env: { ...f.env, GLAZE_AGAINST_THE_MACHINE_ACTIVE: '1' }, input: source, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, source);
  await Promise.all([f.inspector.drain(), second.drain()]);
  const record = JSON.parse(f.text().trim().split('\n').at(-1));
  assert.equal(record.failure, 'Rewrite failed.');
  assert.deepEqual(record.originalTexts, [source]);
  assert.deepEqual(record.texts, [source]);
  assert.equal(secondText, f.text());
});

test('a broken viewer inbox cannot prevent another viewer receiving failure diagnostics', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, 'active.json'), JSON.stringify({ session: 'dead-beef', expiresAt: Date.now() + 15000 }));
  await recordInspection({ provider: 'codex', originalTexts: ['original'], texts: ['original'], failure: 'Rewrite timed out.' }, f.env);
  await f.inspector.drain();
  assert.equal(JSON.parse(f.text()).failure, 'Rewrite timed out.');
});

test('terminal Codex sessions join the firehose with their own native session identity', async (t) => {
  const { startCodexBridge } = await import('../src/codex-bridge.js');
  const { WebSocket } = await import('ws');
  const { once } = await import('node:events');
  const f = await fixture(t);
  const command = join(f.directory, 'native');
  await writeFile(command, `#!${process.execPath}\nrequire('node:readline').createInterface({input:process.stdin}).on('line',l=>process.stdout.write(l+'\\n'));`, { mode: 0o700 });
  const bridge = await startCodexBridge({ command, env: f.env, rewrite: async () => 'Please fix it.' });
  t.after(() => bridge.close());
  const socket = new WebSocket(bridge.url, { headers: { Authorization: `Bearer ${bridge.token}` } });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const response = once(socket, 'message');
  socket.send(JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: 'terminal-native-id', input: [{ type: 'text', text: 'fix this shit' }] } }));
  await response;
  await f.inspector.drain();
  const record = JSON.parse(f.text().trim().split('\n').at(-1));
  assert.equal(record.session, 'terminal-native-id');
  assert.deepEqual(record.originalTexts, ['fix this shit']);
  assert.deepEqual(record.texts, ['Please fix it.']);
});

test('captures from one process stay ordered when submissions share a millisecond', async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const text of ['first', 'second', 'third']) await recordInspection({ provider: 'codex', method: 'turn/start', originalTexts: [text], texts: [text] }, f.env);
  await f.inspector.drain();
  assert.deepEqual(f.text().trim().split('\n').map((line) => JSON.parse(line).texts[0]), ['first', 'second', 'third']);
});
