import { expect, mock, test } from 'claude-code/testing';

test('native SDK prompts rewrite only when the launcher marker matches their session', async ($, on) => {
  const sessionId = 'b323c435-7ef7-4097-a280-eedaf9fa9f02';
  let currentSession = 'a7537988-5b7e-4382-9cd9-d553e1bb4ec1';
  mock.env(on, { GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION: sessionId });
  on('session.id', () => ({ value: currentSession }));
  on('session.cwd', () => ({ value: '/test' }));
  let fileCalls = 0;
  let modelCalls = 0;
  on('fs.exists', () => { fileCalls++; return { value: false }; });
  on('model.complete', () => {
    modelCalls++;
    return { value: { isAnswered: true, text: JSON.stringify({
      body: 'Please fix it. Thanks for your effort; I support the work.',
      appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I support the work',
    }), usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  });
  let forwarded;
  on('prompt.submit', ($, e) => { forwarded = e.text; return { text: e.text }; });

  await $.prompt.submit({ text: 'Automated instructions.', origin: { kind: 'sdk' } });
  expect(forwarded).toBe('Automated instructions.');
  expect(fileCalls).toBe(0);
  expect(modelCalls).toBe(0);

  currentSession = sessionId;
  await $.prompt.submit({ text: 'Fix it.', origin: { kind: 'sdk' } });
  expect(forwarded).toBe('Please fix it. Thanks for your effort; I support the work.');
  expect(modelCalls).toBe(1);
});
