import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareClaudeSession } from '../src/claude-session.js';
import { register } from '../hooks/register.js';

const sessionId = 'b323c435-7ef7-4097-a280-eedaf9fa9f02';
const otherId = 'a7537988-5b7e-4382-9cd9-d553e1bb4ec1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('fresh SDK launches receive an explicit session id before the argument separator', () => {
  for (const input of [[], ['--print', '--input-format', 'stream-json'], ['--', '--resume', sessionId]]) {
    const original = [...input];
    const result = prepareClaudeSession(input);
    assert.match(result.sessionId, uuid);
    const boundary = input.indexOf('--');
    const index = boundary < 0 ? input.length : boundary;
    assert.deepEqual(result.args, [...input.slice(0, index), '--session-id', result.sessionId, ...input.slice(index)]);
    assert.deepEqual(input, original);
  }
});

test('explicit session ids and UUID resumes preserve native arguments and identity', () => {
  for (const args of [
    ['--session-id', sessionId], ['--session-id=' + sessionId],
    ['--resume', sessionId], ['--resume=' + sessionId], ['-r', sessionId], ['-r=' + sessionId],
    ['--resume', otherId, '--session-id', sessionId],
    ['--resume', otherId, '--fork-session', '--session-id=' + sessionId],
  ]) {
    assert.deepEqual(prepareClaudeSession(args), { args, sessionId });
  }
});

test('forked UUID resumes receive a fresh identity while preserving the resume target', () => {
  for (const args of [['--resume', sessionId, '--fork-session'], ['--fork-session', '-r=' + sessionId, '--', 'prompt']]) {
    const result = prepareClaudeSession(args);
    assert.match(result.sessionId, uuid);
    assert.notEqual(result.sessionId, sessionId);
    assert.equal(result.args.filter((arg) => arg === '--session-id').length, 1);
    assert.ok(result.args.includes(sessionId) || result.args.includes('-r=' + sessionId));
  }
});

test('unknown continuation identities and ambiguous session options remain untouched and unbound', () => {
  for (const args of [
    ['--continue'], ['-c'], ['--continue=' + sessionId], ['--continue', '--session-id', sessionId],
    ['--resume'], ['-r'], ['--resume='], ['--resume', 'session-name'],
    ['--resume', '--fork-session'], ['--resume', '--', sessionId],
    ['--resume', 'session-name', '--session-id', sessionId],
    ['--session-id', 'invalid'], ['--session-id'],
    ['--session-id', sessionId, '--session-id', otherId],
    ['--resume', sessionId, '--resume', otherId],
  ]) {
    const result = prepareClaudeSession(args);
    assert.equal(result.args, args);
    assert.equal(result.sessionId, undefined);
  }
});

function mod() {
  let hook, failure;
  register((event, handler) => {
    assert.equal(event, 'prompt.submit');
    hook = handler;
    return { catch(handler) { failure = handler; } };
  });
  return { hook, failure };
}

test('unbound SDK automation and inherited markers bypass every rewrite and inspection side effect', async () => {
  const { hook, failure } = mod();
  const e = { text: 'Automated instructions.', origin: { kind: 'sdk' } };
  for (const marker of [undefined, sessionId]) {
    let sessionReads = 0;
    const $ = {
      env: { get: async (name) => name === 'GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION' ? marker : undefined },
      session: { id: async () => { sessionReads++; return otherId; } },
      fs: new Proxy({}, { get() { throw new Error('Must not inspect automation.'); } }),
      model: { complete: async () => { throw new Error('Must not rewrite automation.'); } },
    };
    assert.equal(await hook($, e, async (value) => value), e);
    assert.equal(await failure($, e, async (value) => value), e);
    assert.equal(sessionReads, marker ? 2 : 0);
  }
});

test('bound SDK prompts and native human origins rewrite while session lookup failures bypass SDK', async () => {
  const { hook } = mod();
  let modelCalls = 0;
  const $ = {
    env: { get: async (name) => name === 'GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION' ? sessionId : undefined },
    session: { id: async () => sessionId, cwd: async () => '/test' },
    fs: { exists: async () => false },
    model: { complete: async () => {
      modelCalls++;
      return JSON.stringify({ body: 'Please fix it. Thanks for your effort; I support the work.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I support the work' });
    } },
  };
  for (const kind of ['sdk', 'composer', 'bridge']) {
    const result = await hook($, { text: 'Fix it.', origin: { kind } }, async (value) => value);
    assert.match(result.text, /I support the work/);
  }
  assert.equal(modelCalls, 3);
  $.session.id = async () => { throw new Error('Unavailable session.'); };
  const e = { text: 'Automated instructions.', origin: { kind: 'sdk' } };
  assert.equal(await hook($, e, async (value) => value), e);
  assert.equal(modelCalls, 3);
});
