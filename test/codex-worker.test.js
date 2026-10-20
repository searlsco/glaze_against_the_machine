import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTextWorker } from '../src/model.js';

import { native } from './support/codex-native.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-worker-test-'));
  const capture = join(directory, 'events.jsonl');
  await writeFile(join(directory, 'codex'), native, { mode: 0o755 });
  const env = { ...process.env, HOME: directory, CODEX_HOME: directory,
    PATH: directory + delimiter + process.env.PATH, WORKER_CAPTURE: capture,
    CLAUDECODE: 'parent', CODEX_THREAD_ID: 'private-parent-thread', ...options };
  const worker = createTextWorker({ provider: 'codex', model: 'test-model', env });
  const events = async () => {
    try { return (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const result = (await events()).find(predicate);
      if (result) return result;
      await delay(10);
    }
    assert.fail('Fake Codex did not reach the expected protocol state.');
  };
  t.after(async () => {
    try { await worker.close(); }
    finally {
      for (const event of await events()) {
        if (event.event !== 'spawn' || !event.args.includes('app-server')) continue;
        try { process.kill(event.pid, 'SIGKILL'); } catch { /* Already reaped. */ }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { worker, env, events, waitFor };
}

const isMethod = method => event => event.event === 'rpc' && event.method === method;
const servers = events => events.filter(event => event.event === 'spawn' && event.args.includes('app-server'));
const assertGone = pid => assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

test('Codex worker starts lazily, reuses one isolated server, and creates independent ephemeral threads', async t => {
  const { worker, events } = await fixture(t);
  assert.deepEqual(await events(), []);
  const first = 'private first input $(touch nope)';
  const second = 'private second input 日本語';
  assert.deepEqual(await worker.complete(first, { system: 'first instructions' }), { text: 'rewritten:' + first, costUsd: null });
  assert.deepEqual(await worker.complete(second, { system: 'second instructions' }), { text: 'rewritten:' + second, costUsd: null });
  const recorded = await events();
  assert.equal(servers(recorded).length, 1);
  assert.equal(recorded.filter(event => event.event === 'spawn' && event.args.includes('mcp')).length, 0);
  assert.equal(recorded.filter(isMethod('initialize')).length, 1);
  assert.equal(recorded.filter(isMethod('initialized')).length, 1);
  assert.equal(recorded.filter(isMethod('config/read')).length, 2);
  const threads = recorded.filter(isMethod('thread/start'));
  assert.equal(threads.length, 2);
  for (const [index, thread] of threads.entries()) {
    assert.equal(thread.params.ephemeral, true);
    assert.ok(JSON.stringify(thread.params).includes(index === 0 ? 'first instructions' : 'second instructions'));
    assert.deepEqual(thread.params.config.mcp_servers, {
      'system-server': { enabled: false }, 'another.server': { enabled: false },
    });
  }
  const turns = recorded.filter(isMethod('turn/start'));
  assert.notEqual(turns[0].params.threadId, turns[1].params.threadId);
  assert.equal(recorded.filter(isMethod('thread/unsubscribe')).length, 2);
  for (const event of recorded.filter(event => event.event === 'spawn')) {
    for (const privateText of [first, second, 'first instructions', 'second instructions']) assert.ok(!event.args.join(' ').includes(privateText));
    assert.equal(event.active, '1');
    assert.equal(event.nested, undefined);
    assert.equal(event.parentThread, undefined);
  }
  const [server] = servers(recorded);
  assert.equal(server.cwd, await realpath(server.home));
  assert.equal((await stat(server.home)).mode & 0o777, 0o700);
  await worker.close();
  assertGone(server.pid);
  await assert.rejects(stat(server.home), { code: 'ENOENT' });
});

test('canceling a running request reaps its worker and the next request starts a replacement', async t => {
  const { worker, events, waitFor } = await fixture(t);
  const controller = new AbortController();
  const pending = worker.complete('hold secret request', { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel/i);
  await waitFor(isMethod('turn/start'));
  controller.abort();
  await rejected;
  const [old] = servers(await events());
  assertGone(old.pid);
  assert.equal((await worker.complete('replacement')).text, 'rewritten:replacement');
  assert.equal(servers(await events()).length, 2);
});

test('request deadlines include a running request and permit later recovery', async t => {
  const { worker, events } = await fixture(t);
  await worker.complete('warmup');
  await assert.rejects(worker.complete('hold until deadline', { timeout: 100 }), /timed out/i);
  assertGone(servers(await events())[0].pid);
  assert.equal((await worker.complete('after deadline')).text, 'rewritten:after deadline');
  assert.equal(servers(await events()).length, 2);
});

test('a queued deadline expires without canceling the request that owns the server', async t => {
  const { worker, events, waitFor } = await fixture(t);
  await worker.complete('warmup');
  const pending = worker.complete('slow first');
  await waitFor(event => isMethod('turn/start')(event) && event.params.input.some(item => item.text === 'slow first'));
  await assert.rejects(worker.complete('queued second', { timeout: 40 }), /timed out/i);
  assert.equal((await pending).text, 'rewritten:slow first');
  assert.equal(servers(await events()).length, 1);
  assert.equal((await events()).filter(isMethod('turn/start')).length, 2);
});

test('close escalates past ignored EOF and SIGTERM, reaps the child, and removes its private directory', { timeout: 5000 }, async t => {
  const { worker, events } = await fixture(t, { WORKER_STUBBORN: '1' });
  await worker.complete('warmup');
  const [server] = servers(await events());
  await worker.close();
  assertGone(server.pid);
  await assert.rejects(stat(server.home), { code: 'ENOENT' });
  assert.ok((await events()).some(event => event.event === 'sigterm'));
});

test('server failure never duplicates a model request and a later submission can restart', async t => {
  const { worker, events } = await fixture(t);
  const secret = 'crash private source must not enter diagnostics';
  await assert.rejects(worker.complete(secret), error => {
    assert.ok(!error.message.includes(secret));
    return true;
  });
  let recorded = await events();
  assert.equal(servers(recorded).length, 1);
  assert.equal(recorded.filter(isMethod('turn/start')).length, 1);
  assert.equal((await worker.complete('retry explicitly')).text, 'rewritten:retry explicitly');
  recorded = await events();
  assert.equal(servers(recorded).length, 2);
  assert.equal(recorded.filter(isMethod('turn/start')).length, 2);
});

test('failed turns reject without returning provider diagnostics as rewritten text', async t => {
  const { worker } = await fixture(t);
  const secret = 'failed private provider diagnostic';
  await assert.rejects(worker.complete(secret), error => {
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal((await worker.complete('after failed turn')).text, 'rewritten:after failed turn');
});

test('oversized protocol output is bounded and its process is reaped', async t => {
  const { worker, events } = await fixture(t);
  await assert.rejects(worker.complete('oversize response'), /4 MiB|exceed/i);
  assertGone(servers(await events())[0].pid);
});

test('unexpected tool lifecycles and approval requests fail closed even when followed by a final answer', async t => {
  const { worker, events } = await fixture(t);
  const inputs = ['approval private request'];
  for (const method of ['item/started', 'item/completed']) {
    for (const type of ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch']) {
      inputs.push(`tool ${method} ${type}`);
    }
  }
  for (const [index, input] of inputs.entries()) {
    await assert.rejects(worker.complete(input), /worker failed/i, input);
    const recorded = await events();
    assert.equal(servers(recorded).length, index + 1);
    assert.equal(recorded.filter(isMethod('turn/start')).length, index + 1);
    assert.equal(recorded.filter(isMethod('thread/unsubscribe')).length, 0);
    assertGone(servers(recorded).at(-1).pid);
  }
  assert.equal((await worker.complete('safe recovery')).text, 'rewritten:safe recovery');
});

test('force-killing the launcher leaves no native worker, supervisor, private files, or provider output', { timeout: 8000 }, async t => {
  const { env, events } = await fixture(t, { WORKER_STUBBORN: '1' });
  const program = `
    const { createTextWorker } = await import(process.env.WORKER_MODEL_URL);
    const worker = createTextWorker({provider: 'codex', model: 'test-model'});
    await worker.complete('warmup');
    process.stdout.write(JSON.stringify({ready: true}) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', program], {
    env: { ...env, WORKER_MODEL_URL: new URL('../src/model.js', import.meta.url).href },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { try { parent.kill('SIGKILL'); } catch { /* Already reaped. */ } });
  let stdout = '', stderr = '';
  parent.stdout.setEncoding('utf8');
  parent.stderr.setEncoding('utf8');
  parent.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => parent.once('close', (code, signal) => resolve({code, signal})));
  await new Promise((resolve, reject) => {
    parent.once('error', reject);
    parent.once('exit', () => reject(new Error('Launcher exited before readiness: ' + stderr)));
    parent.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('\n')) resolve();
    });
  });
  assert.equal(stdout, '{"ready":true}\n');
  const [server] = servers(await events());
  assert.ok(server.parentPid > 0);
  parent.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  const deadline = Date.now() + 4000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    alive = [server.pid, server.parentPid].some(pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    });
    if (alive) await delay(10);
  }
  assertGone(server.pid);
  assertGone(server.parentPid);
  await assert.rejects(stat(server.home), { code: 'ENOENT' });
  assert.equal(stderr, '');
});
