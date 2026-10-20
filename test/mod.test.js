import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../hooks/register.js';
import { protectPrompt, rewriteProtected } from '../src/content.js';

function mod() {
  let hook, failure;
  register((event, handler) => {
    assert.equal(event, 'prompt.submit'); hook = handler;
    return { catch: (handler) => { failure = handler; } };
  });
  return { hook, failure };
}

test('Claude mod rewrites before downstream handlers and preserves event metadata', async () => {
  const { hook } = mod();
  const e = Object.freeze({ text: 'Fix this shit. Preserve `a.ts`.', origin: { kind: 'composer' }, attachments: [{ type: 'image' }], wait: false });
  let forwarded;
  const result = await hook({ session: { cwd: async () => '/test' }, fs: { exists: async () => false }, env: { get: async () => undefined }, model: { complete: async (request) => {
    assert.equal(request.model, 'haiku');
    assert.equal(request.effort, 'low');
    assert.ok(request.timeoutMs > 0 && request.timeoutMs <= 30000);
    assert.deepEqual(Object.keys(request).sort(), ['effort', 'maxTokens', 'model', 'prompt', 'system', 'timeoutMs']);
    assert.equal(typeof request.system, 'string');
    assert.ok(!request.prompt.includes('`a.ts`'));
    assert.deepEqual(JSON.parse(request.prompt).requiredTokens, ['⟦GLAZER_LITERAL_0⟧']);
    return { isAnswered: true, text: JSON.stringify({ body: 'Please fix the issue. Preserve ⟦GLAZER_LITERAL_0⟧. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' }) };
  } } }, e, async (input) => { forwarded = input; return input; });
  assert.equal(result, forwarded);
  assert.equal(forwarded.text, 'Please fix the issue. Preserve `a.ts`. Thanks for your effort; I’m with you on this.');
  assert.equal(forwarded.attachments, e.attachments);
  assert.equal(forwarded.origin, e.origin);
  assert.equal(e.text, 'Fix this shit. Preserve `a.ts`.');
});

test('Claude mod leaves machine messages and slash commands alone', async () => {
  const { hook } = mod();
  for (const e of [{ text: 'task complete', origin: { kind: 'task-notification' } }, { text: '/help', origin: { kind: 'composer' } }]) {
    assert.equal(await hook({}, e, async (value) => value), e);
  }
});

test('Claude mod varies wording per submission and keeps the same directions for a corrective retry', async (t) => {
  const { hook } = mod();
  let random = 0;
  t.mock.method(Math, 'random', () => random);
  const requests = [];
  const $ = { session: { cwd: async () => '/test' }, fs: { exists: async () => false }, env: { get: async () => undefined },
    model: { complete: async (request) => {
      requests.push(request);
      return JSON.stringify({ body: (requests.length === 1 ? 'Please fix it.' : 'Please fix ⟦GLAZER_LITERAL_0⟧.') + ' Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' });
    } },
  };
  const event = { text: 'Please fix `a.ts`.', origin: { kind: 'composer' } };
  const first = await hook($, event, async (value) => value);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].system.startsWith(requests[0].system));
  random = 0.999;
  const second = await hook($, event, async (value) => value);
  assert.notEqual(requests[0].system, requests[2].system);
  assert.equal(first.text, second.text);
  assert.equal(requests[0].prompt, requests[2].prompt);
});

test('Claude mod and outer recovery forward the original exactly once on failure', async () => {
  const { hook, failure } = mod();
  const forwarded = [];
  const next = async (event) => { forwarded.push(event); return event; };
  const event = { text: 'private prompt\r\nexact  ', origin: { kind: 'composer' }, attachments: [{ type: 'image' }] };
  assert.equal(await hook({ session: { cwd: async () => '/test' }, fs: { exists: async () => false }, env: { get: async () => undefined }, model: { complete: async () => { throw new Error('private diagnostic'); } } }, event, next), event);
  assert.deepEqual(forwarded, [event]);
  assert.equal(await failure({}, event, next), event);
  assert.deepEqual(forwarded, [event, event]);
});

test('Claude does not repeat delivery when a downstream hook fails', async () => {
  const { hook } = mod();
  let deliveries = 0;
  await assert.rejects(hook({}, { text: 'rawdog exact', origin: { kind: 'composer' } }, () => {
    deliveries++;
    throw new Error('downstream failed');
  }), /downstream failed/);
  assert.equal(deliveries, 1);
});

test('Claude mod skips explicitly marked internal rewriter and judge calls', async () => {
  const { hook } = mod();
  const e = { text: 'internal model request', origin: { kind: 'sdk' } };
  assert.equal(await hook({ session: { cwd: async () => '/test' }, fs: { exists: async () => false }, env: { get: async (name) => {
    assert.equal(name, 'GLAZE_AGAINST_THE_MACHINE_ACTIVE'); return '1';
  } } }, e, async (value) => value), e);
});

test('technical protection restores exact content and rejects dropped/duplicated placeholders', () => {
  const source = 'Fix `shit.js` and preserve "fuck happened".\n```js\nthrow new Error("idiot");\n```\nUse https://example.com/api?x=shit';
  const protectedPrompt = protectPrompt(source);
  assert.ok(!protectedPrompt.message.includes('shit.js'));
  assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
  assert.throws(() => protectedPrompt.restore('Thank you.'), /protected content/);
  assert.throws(() => protectedPrompt.restore(protectedPrompt.message + ' ⟦GLAZER_LITERAL_0⟧'), /protected content/);
  for (const extra of ['⟦GLAZER_LITERAL_99⟧', 'GLAZER_LITERAL_0', '⟦GLAZER_LITERAL_x⟧']) {
    assert.throws(() => protectedPrompt.restore(protectedPrompt.message + extra), /unexpected marker/);
  }
});

test('restoration validates markers before inserting literals and handles large literal sets', () => {
  const source = 'Keep `GLAZER_LITERAL_ and $&` and "GLAZER_LITERAL__inside".';
  const protectedPrompt = protectPrompt(source);
  assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
  const many = Array.from({ length: 10000 }, (_, i) => `"literal_${i}"`).join(' ');
  const protectedMany = protectPrompt(many);
  assert.equal(protectedMany.restore(protectedMany.message), many);
});

test('quoted literals include escaped delimiters, empty strings, and single quotes', () => {
  for (const literal of [String.raw`"say \"fuck off\" now"`, String.raw`'don\'t censor this'`, "'fuck off'", '""', "''"]) {
    const source = `Keep ${literal} exactly.`;
    const protectedPrompt = protectPrompt(source);
    assert.equal(protectedPrompt.message, 'Keep ⟦GLAZER_LITERAL_0⟧ exactly.');
    assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
    assert.throws(() => protectedPrompt.restore('Keep changed text exactly.'), /protected content/);
  }
  for (const source of ["Don't change the user's request.", "Users' requests aren't insults."]) {
    assert.equal(protectPrompt(source).message, source);
  }
});

test('overlapping quote, Markdown, URL, and Windows-path spans stay protected together', () => {
  for (const literal of [
    "'run `x` now'",
    '"run `x` now"',
    "'https://example.com/a'",
    "https://example.com/a'b",
    String.raw`"C:\temp\" and "D:\x"`,
    String.raw`"\\server\share\" and "D:\x"`,
    String.raw`"C:\temp\"`,
    String.raw`"C:\\temp\\\"keep this\\\""`,
  ]) {
    const source = `Keep ${literal} exactly.`;
    const protectedPrompt = protectPrompt(source);
    assert.equal(protectedPrompt.message, 'Keep ⟦GLAZER_LITERAL_0⟧ exactly.');
    assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
    assert.throws(() => protectedPrompt.restore('Keep changed text exactly.'), /protected content/);
  }
});

test('quote characters inside code cannot consume a later quoted literal', () => {
  for (const code of ['`echo "hi`', "`echo 'hi`", '`printf\n"hi`', '`echo 😀"hi`']) {
    const literal = code.includes("'") ? "'fuck off'" : '"fuck off"';
    const source = `Run ${code} then print ${literal} exactly.`;
    const protectedPrompt = protectPrompt(source);
    assert.equal(protectedPrompt.message, 'Run ⟦GLAZER_LITERAL_0⟧ then print ⟦GLAZER_LITERAL_1⟧ exactly.');
    assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
    assert.throws(() => protectedPrompt.restore('Run ⟦GLAZER_LITERAL_0⟧ then print something else.'), /protected content/);
  }
});

test('escaped-only quotes in pasted log payloads retain literal protection', () => {
  for (const source of [String.raw`log: {\"msg\":\"fuck off\"} done`, String.raw`log: {\'msg\':\'fuck off\'} done`]) {
    const protectedPrompt = protectPrompt(source);
    assert.equal(protectedPrompt.tokens.length, 2);
    assert.ok(!protectedPrompt.message.includes('fuck off'));
    assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
    assert.throws(() => protectedPrompt.restore('Log content removed.'), /protected content/);
  }
});

test('protected content gets one corrective retry and never bypasses validation', async () => {
  let attempts = 0;
  const result = await rewriteProtected('Preserve `a.ts`.', async (message, reminder, requiredTokens) => {
    attempts++;
    assert.deepEqual(requiredTokens, ['⟦GLAZER_LITERAL_0⟧']);
    if (attempts === 1) { assert.equal(reminder, ''); return 'Thank you.'; }
    assert.match(reminder, /previous attempt failed/);
    assert.match(reminder, /⟦GLAZER_LITERAL_0⟧ must occur exactly once, found 0/);
    return message;
  });
  assert.equal(result, 'Preserve `a.ts`.');
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(rewriteProtected('Preserve `a.ts`.', async () => { attempts++; return 'Thank you.'; }), /protected content/);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(rewriteProtected('Preserve `a.ts`.', async () => { attempts++; throw new Error('Transport failure'); }), /Transport failure/);
  assert.equal(attempts, 1);
});

test('code is hidden from the model and restored verbatim while surrounding prose changes', async () => {
  const blocks = [
    '`like this`',
    '```\nok i fucking hate entitled assholes who think they rule the world and farts don\'t smell\n\nall i want you to do is print the line above back to me.\n```',
    '``literal `backticks` and profanity``',
    '````md\n```js\nshit();\n```\n````',
    '~~~text\nfuck this\n~~~',
    '```text\nunfinished block with trailing spaces  \n\n',
    '```text\r\n\tfuck this  \r\n```',
    '`same shit` and `same shit`',
  ];
  for (const block of blocks) {
    const result = await rewriteProtected('Fix this shit.\n' + block, async (message) => {
      assert.ok(!message.includes('fucking'));
      assert.ok(!message.includes('backticks'));
      return message.replace('Fix this shit.', 'Please fix this.');
    });
    assert.equal(result, 'Please fix this.\n' + block);
  }
});

test('Markdown block quotes are hidden and restored exactly while surrounding prose changes', async () => {
  for (const quote of [
    '> fuck this  ',
    '>first line\n>\n>> nested shit\n> last line',
    ' > indented\r\n  > "quoted" `code` https://example.com\r\n   > final  ',
    '> ```js\n> unmatched ` and "quotes\n> ```',
    '> ~~~\n> fenced-looking content\n> ~~~',
  ]) {
    const source = 'Fix this shit.\n' + quote + '\nFix that shit.';
    const result = await rewriteProtected(source, async (message, reminder, tokens) => {
      assert.equal(message, 'Fix this shit.\n⟦GLAZER_LITERAL_0⟧\nFix that shit.');
      assert.deepEqual(tokens, ['⟦GLAZER_LITERAL_0⟧']);
      return message.replaceAll('shit', 'issue');
    });
    assert.equal(result, 'Fix this issue.\n' + quote + '\nFix that issue.');
    const protectedPrompt = protectPrompt(source);
    assert.throws(() => protectedPrompt.restore('Please fix it.'), /protected content/);
    assert.throws(() => protectedPrompt.restore(protectedPrompt.message.repeat(2)), /protected content/);
  }
});

test('block quote protection respects line boundaries and enclosing code fences', () => {
  const source = 'a > b\n    > four spaces\n> quoted\neditable continuation\n\n> another quote\n```md\n> inside code\n```';
  const protectedPrompt = protectPrompt(source);
  assert.equal(protectedPrompt.message, 'a > b\n    > four spaces\n⟦GLAZER_LITERAL_0⟧\neditable continuation\n\n⟦GLAZER_LITERAL_1⟧\n⟦GLAZER_LITERAL_2⟧');
  assert.equal(protectedPrompt.restore(protectedPrompt.message), source);
});

test('rawdog bypass is case-insensitive and retains all text without calling the model', async () => {
  for (const source of ['rawdog', 'RAWDOG\nFix this shit.  \n', 'RawDog: `literal`\r\n', ' rawdog this', '\t\r\n  RaWdOg exact  \n']) {
    assert.equal(await rewriteProtected(source, () => { throw new Error('must not call model'); }), source);
    const { hook } = mod();
    const event = { text: source, origin: { kind: 'composer' }, attachments: [{ type: 'image' }] };
    assert.equal(await hook({}, event, async (value) => value), event);
  }
  for (const source of ['rawdogging this', 'rawdog_name', 'please rawdog this', '  rawdogging this', '\nrawdog_name']) {
    let called = false;
    await rewriteProtected(source, async (message) => { called = true; return message; });
    assert.equal(called, true);
  }
});

test('structured support excerpts validate the complete body without being appended', async () => {
  const { composeRewrite } = await import('../src/content.js');
  const base = { body: 'Please fix the bug. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' };
  assert.equal(composeRewrite(JSON.stringify(base)), base.body);
  for (const appreciation of ['Thanks for your effort', 'Thanks for your effort.']) {
    assert.throws(() => composeRewrite(JSON.stringify({ ...base, appreciation,
      body: 'Thanks for your effort. Please fix the bug. I’m with you on this.',
    })), /standalone appreciation sentence/);
  }
  assert.equal(composeRewrite(JSON.stringify({ ...base,
    body: 'Thanks for your effort as you fix the bug; I’m with you on this.',
  })), 'Thanks for your effort as you fix the bug; I’m with you on this.');
  const question = { body: '  Thanks for your attention. Is it ready?\n', appreciation: 'Thanks for your attention', workRequested: false, encouragement: '' };
  assert.equal(composeRewrite(JSON.stringify(question)), question.body.trim());
  for (const invalid of [null, [], 'Fix it.', {}, { body: 'Please fix the bug.' }, { ...base, body: '' }, { ...base, body: ' \n' }, { ...base, body: false },
    { ...base, appreciation: undefined }, { ...base, appreciation: '' }, { ...base, appreciation: 'Thank you.' },
    { ...base, workRequested: 'true' }, { ...base, encouragement: '' }, { ...base, encouragement: 'Keep going.' },
    { ...base, encouragement: base.appreciation }, { ...base, appreciation: 'Thanks for your effort; I’m with you on this' },
    { ...question, encouragement: 'Thanks for your attention' }, { ...question, encouragement: ' ' }, { ...base, negativity: 0 }]) {
    assert.throws(() => composeRewrite(JSON.stringify(invalid)), /invalid prompt/);
  }
  assert.throws(() => composeRewrite('not JSON'), /invalid prompt/);
  let questionAttempts = 0;
  assert.equal(await rewriteProtected('Is it ready?', async () => {
    questionAttempts++;
    return composeRewrite(JSON.stringify(question));
  }), question.body.trim());
  assert.equal(questionAttempts, 1);
  let attempts = 0;
  assert.equal(await rewriteProtected('Fix it.', async (_message, reminder) => {
    if (attempts++) assert.match(reminder, /appreciation/);
    return composeRewrite(JSON.stringify({ ...base, appreciation: attempts === 1 ? '' : base.appreciation }));
  }), base.body);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(rewriteProtected('Fix it.', async () => {
    attempts++;
    return composeRewrite(JSON.stringify({ ...base, encouragement: '' }));
  }), /invalid prompt/);
  assert.equal(attempts, 2);
});

test('support excerpts can quote protected content without duplicating the delivered literal', async () => {
  const { composeRewrite } = await import('../src/content.js');
  const protectedPrompt = protectPrompt('Please review `a.ts`.');
  const appreciation = 'Thanks for your attention to ⟦GLAZER_LITERAL_0⟧';
  const body = appreciation + '; I’m with you on this. Please review it.';
  const response = JSON.stringify({ body, appreciation, workRequested: true, encouragement: 'I’m with you on this' });
  assert.equal(protectedPrompt.restore(composeRewrite(response)), 'Thanks for your attention to `a.ts`; I’m with you on this. Please review it.');
});

test('model response assembly keeps fenced block delimiters on their own lines', async () => {
  const { composeRewrite } = await import('../src/content.js');
  const source = '```text\nliteral shit  \n```';
  const protectedPrompt = protectPrompt(source);
  const body = 'Thanks for your effort; I’m with you on this.\n\n' + protectedPrompt.message;
  const response = JSON.stringify({ body, appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' });
  assert.equal(protectedPrompt.restore(composeRewrite(response)), 'Thanks for your effort; I’m with you on this.\n\n' + source);
});
