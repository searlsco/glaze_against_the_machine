import { expect, mock, test } from 'claude-code/testing';

test('Turbocommit helper requests bypass the native mod before model and filesystem calls', async ($, on) => {
  mock.env(on, { TURBOCOMMIT_DISABLED: '1' });
  let modelCalls = 0;
  let fileCalls = 0;
  on('model.complete', () => { modelCalls++; throw new Error('Unexpected helper rewrite.'); });
  on('fs.exists', () => { fileCalls++; return { value: false }; });
  let forwarded;
  on('prompt.submit', ($, e) => { forwarded = e; return { text: e.text }; });
  const text = 'Write a commit headline from this transcript.';
  await $.prompt.submit({ text, origin: { kind: 'sdk' } });
  expect(forwarded.text).toBe(text);
  expect(modelCalls).toBe(0);
  expect(fileCalls).toBe(0);
});
