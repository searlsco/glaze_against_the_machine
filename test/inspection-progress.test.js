import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginInspection, inspectionFiles, startInspector } from '../src/inspection.js';
import { createInspectionDisplay } from '../src/inspection-display.js';
import { register } from '../hooks/register.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const original = 'Fix this.\r\nKeep `exact text`  \n';
const record = { provider: 'claude', method: 'prompt.submit', session: 'native-session', originalTexts: [original], timeoutMs: 30000 };
const response = JSON.stringify({ body: 'Please fix this. Keep ⟦GLAZER_LITERAL_0⟧. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'glaze-progress-'));
  let text = '';
  const inspector = await startInspector({ directory, json: true, output: { write: (chunk) => { text += chunk; } } });
  t.after(async () => { await inspector.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, inspector, env: { ...process.env, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: directory },
    records: () => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
  };
}

test('Claude original appears while its model completion is still pending', async (t) => {
  const f = await fixture(t);
  const entered = deferred(), completion = deferred();
  t.after(() => completion.resolve(response));
  let hook;
  register((event, handler) => { hook = handler; return { catch() {} }; });
  const $ = { session: { id: async () => record.session, cwd: async () => f.directory }, fs: inspectionFiles,
    env: { get: async (name) => f.env[name] },
    model: { complete: () => { entered.resolve(); return completion.promise; } },
  };
  const result = hook($, { text: original, origin: { kind: 'composer' } }, (event) => event);
  await entered.promise;
  await f.inspector.drain();
  const [start] = f.records();
  assert.equal(f.records().length, 1);
  assert.equal(start.event, 'rewrite_started');
  assert.deepEqual(start.originalTexts, [original]);
  assert.deepEqual(start.texts, []);
  completion.resolve(response);
  const rewritten = await result;
  await f.inspector.drain();
  const finish = f.records().at(-1);
  assert.equal(finish.event, 'rewrite_completed');
  assert.equal(finish.rewriteId, start.rewriteId);
  assert.deepEqual(finish.texts, [rewritten.text]);
  assert.ok(rewritten.text.includes('`exact text`'));
  assert.ok(finish.durationMs >= 0);
});

test('lifecycle capture stays opt-in and does not create a directory without a viewer', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glaze-no-viewer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inspection = await beginInspection(record, { GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: join(directory, 'absent') });
  await inspection.complete(['Please fix it.']);
  assert.deepEqual(await readdir(directory), []);
});

test('bypasses emit one exact completion and cancellation emits one terminal event', async (t) => {
  const f = await fixture(t);
  const bypass = await beginInspection({ ...record, bypass: true }, f.env);
  await bypass.complete([original]);
  const pending = await beginInspection(record, f.env);
  await pending.cancel();
  await pending.complete(['must not appear']);
  await pending.cancel();
  await f.inspector.drain();
  const captures = f.records();
  assert.deepEqual(captures.map(({ event }) => event), ['rewrite_completed', 'rewrite_started', 'rewrite_canceled']);
  assert.deepEqual(captures[0].texts, [original]);
  assert.equal(captures[1].rewriteId, captures[2].rewriteId);
  assert.deepEqual(captures[2].texts, []);
});

function displayFixture({ json = false, tty = false, resolveOwner = async () => 'Resolved owner' } = {}) {
  let text = '', time = 1000;
  const display = createInspectionDisplay({ output: { isTTY: tty, write: (chunk) => { text += chunk; } }, json, resolveOwner, now: () => time });
  return { display, text: () => text, advance: (duration) => { time += duration; },
    start: { ...record, rewriteId: 'rewrite-a', startedAt: time, event: 'rewrite_started', texts: [] },
  };
}

test('TTY progress updates elapsed time and completion stops it without repeating the original', () => {
  const f = displayFixture({ tty: true });
  f.display.record(f.start);
  assert.ok(f.text().includes('original prompt:\nFix this.\\u000d\nKeep `exact text`  \n'));
  f.advance(1200);
  f.display.tick();
  assert.ok(f.text().endsWith('Rewriting... 1.2s'));
  f.advance(1000);
  f.display.tick();
  assert.ok(f.text().endsWith('Rewriting... 2.2s'));
  f.display.record({ ...f.start, event: 'rewrite_completed', texts: ['Please fix it.'], durationMs: 2200 });
  assert.equal(f.text().split('original prompt:').length, 2);
  assert.match(f.text(), /Rewritten in 2\.2s/);
  assert.match(f.text(), /glazed prompt:\nPlease fix it\./);
  const finished = f.text();
  f.advance(10000);
  f.display.tick();
  assert.equal(f.text(), finished);
});

test('slow owner lookups cannot delay originals, progress, or other sessions', async () => {
  const owner = deferred();
  const f = displayFixture({ resolveOwner: () => owner.promise });
  f.display.record({ ...f.start, agentId: 'pending-agent' });
  assert.match(f.text(), /Paseo pending-agent/);
  assert.match(f.text(), /original prompt:/);
  f.display.record({ ...record, rewriteId: 'rewrite-b', event: 'rewrite_completed', texts: ['Other session completed.'], durationMs: 20 });
  assert.match(f.text(), /Other session completed/);
  f.advance(5000);
  f.display.tick();
  assert.match(f.text(), /still rewriting \(5\.0s\)/);
  owner.resolve('Resolved name');
  await owner.promise;
  await Promise.resolve();
  f.display.record({ ...f.start, agentId: 'pending-agent', event: 'rewrite_completed', texts: ['Finished.'], durationMs: 5000 });
  assert.match(f.text(), /Resolved name/);
  assert.ok(!f.text().includes('\x1b'));
});

test('concurrent rewrites are tracked independently through failure and cancellation', () => {
  const f = displayFixture({ tty: true });
  f.display.record(f.start);
  f.display.record({ ...f.start, rewriteId: 'rewrite-b', session: 'another-session' });
  f.advance(2400);
  f.display.tick();
  assert.ok(f.text().endsWith('Rewriting 2 prompts... oldest 2.4s'));
  f.display.record({ ...f.start, event: 'rewrite_completed', texts: [original], failure: 'Rewrite timed out.', durationMs: 2400 });
  f.display.tick();
  assert.match(f.text(), /REWRITE FAILED: Rewrite timed out\./);
  assert.ok(f.text().endsWith('Rewriting... 2.4s'));
  f.display.record({ ...f.start, rewriteId: 'rewrite-b', session: 'another-session', event: 'rewrite_canceled', durationMs: 2400 });
  assert.match(f.text(), /Rewrite canceled after 2\.4s/);
  const finished = f.text();
  f.display.tick();
  assert.equal(f.text(), finished);
});

test('JSON emits exact lifecycle records without terminal animation or periodic chatter', () => {
  const f = displayFixture({ json: true, tty: true });
  f.display.record(f.start);
  f.advance(6000);
  f.display.tick();
  assert.equal(f.text().trim().split('\n').length, 1);
  f.display.record({ ...f.start, event: 'rewrite_completed', texts: [original], durationMs: 6000 });
  const [start, finish] = f.text().trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(start.originalTexts, [original]);
  assert.deepEqual(finish.texts, [original]);
  assert.equal(start.rewriteId, finish.rewriteId);
  assert.ok(!f.text().includes('\x1b'));
});

test('a missing completion stops progress without claiming that rewriting failed', () => {
  const f = displayFixture();
  f.display.record(f.start);
  f.advance(36000);
  f.display.tick();
  assert.match(f.text(), /No completion received after 36\.0s/);
  assert.match(f.text(), /outcome is unknown/);
  assert.doesNotMatch(f.text(), /REWRITE FAILED/);
  const expired = f.text();
  f.advance(5000);
  f.display.tick();
  assert.equal(f.text(), expired);
  f.display.record({ ...f.start, event: 'rewrite_completed', texts: ['Eventually finished.'], durationMs: 41000 });
  assert.match(f.text(), /Eventually finished/);
  const json = displayFixture({ json: true });
  json.display.record({ ...json.start, time: new Date(1000).toISOString() });
  json.advance(36000);
  json.display.tick();
  const incomplete = JSON.parse(json.text().trim().split('\n').at(-1));
  assert.equal(incomplete.event, 'inspection_incomplete');
  assert.equal(incomplete.time, new Date(37000).toISOString());
});

test('a viewer opened during rewriting can render a completion without its start', () => {
  const f = displayFixture();
  f.display.record({ ...f.start, event: 'rewrite_completed', texts: ['Please fix it.'], durationMs: 1000 });
  assert.match(f.text(), /original prompt:/);
  assert.match(f.text(), /glazed prompt:/);
  f.display.stop();
  const stopped = f.text();
  f.display.record(f.start);
  f.display.tick();
  assert.equal(f.text(), stopped);
});
