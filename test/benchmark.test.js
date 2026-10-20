import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyRequest } from '../script/support/offline-model.js';

const expected = { input: 'synthetic input', system: 'synthetic instructions', forbiddenInputs: ['prior request'] };
const request = () => ({ tools: [], input: [
  { type: 'message', role: 'developer', content: [{ type: 'input_text', text: expected.system }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: expected.input }] },
] });

test('native benchmark verifier accepts isolated text for both providers', () => {
  verifyRequest('codex', request(), expected);
  verifyRequest('claude', { tools: [], system: expected.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: expected.input }] }] }, expected);
});

test('native benchmark verifier rejects root, nested and additional tools', () => {
  for (const extra of [{ tools: [{ type: 'shell' }] }, { nested: { functions: ['shell'] } },
    { nested: [{ type: 'additional_tools', tools: [] }] }]) {
    assert.throws(() => verifyRequest('codex', { ...request(), ...extra }, expected), /tool/);
  }
});

test('native benchmark verifier rejects prior context and unrelated user messages', () => {
  assert.throws(() => verifyRequest('codex', { ...request(), metadata: 'prior request' }, expected), /previous prompt/);
  assert.throws(() => verifyRequest('codex', { ...request(), previous_response_id: 'old-response' }, expected), /previous response/);
  for (const message of [
    { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'old answer' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'unrelated input' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: expected.input }] },
  ]) assert.throws(() => verifyRequest('codex', { ...request(), input: [...request().input, message] }, expected));
});

test('native benchmark verifier rejects private instructions and nontext input', () => {
  for (const context of ['GLAZE_PRIVATE_CONTEXT_MUST_NOT_REACH_INFERENCE', '<skills_instructions>', '# AGENTS.md instructions']) {
    assert.throws(() => verifyRequest('codex', { ...request(), metadata: context }, expected), /leaked/);
  }
  const body = request();
  body.input[1].content = [{ type: 'input_image', image_url: 'synthetic' }];
  assert.throws(() => verifyRequest('codex', body, expected), /non-text/);
});
