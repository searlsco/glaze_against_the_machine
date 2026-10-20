import { expect, mock, test } from 'claude-code/testing';

test('native Claude loader rewrites submitted prompts and captures tail events', async ($, on) => {
  const files = new Map();
  const directory = '/inspect';
  const viewer = 'abcdef';
  const minute = Math.floor(Date.now() / 60000);
  files.set(`${directory}/viewers-${minute}.jsonl`, JSON.stringify({ session: viewer, expiresAt: Date.now() + 60000 }));
  files.set('/GLAZES.md', 'Prefer concise requests.');
  let styleReads = 0;
  mock.env(on, { GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: directory });
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 'native-claude-session' }));
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }));
  on('fs.read', ($, e) => {
    if (e.path === '/GLAZES.md') styleReads++;
    return { value: files.get(e.path) };
  });
  on('fs.stat', ($, e) => {
    expect(e.resolve).toBe(true);
    return { value: { kind: 'file', size: files.get(e.path)?.length ?? 0, mtimeMs: 1 } };
  });
  on('fs.write', ($, e) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on('model.complete', ($, e) => {
    expect(e.prompt.startsWith('Prefer concise requests.\n\n')).toBe(true);
    return { value: {
      isAnswered: true,
      text: JSON.stringify({ body: 'Please fix it. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' }),
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } };
  });
  let forwarded;
  on('prompt.submit', ($, e) => { forwarded = e.text; return { text: e.text }; });

  await $.prompt.submit({ text: 'Fix this shit.', origin: { kind: 'composer' } });
  await $.prompt.submit({ text: 'Fix this shit.', origin: { kind: 'composer' } });
  expect(styleReads).toBe(1);

  expect(forwarded).toBe('Please fix it. Thanks for your effort; I’m with you on this.');
  const records = [...files].filter(([path]) => path.startsWith(`${directory}/${viewer}/`)).map(([, text]) => JSON.parse(text));
  expect(records.map((record) => record.event)).toEqual(['rewrite_started', 'rewrite_completed', 'rewrite_started', 'rewrite_completed']);
  expect(records[1].originalTexts).toEqual(['Fix this shit.']);
  expect(records[1].texts).toEqual([forwarded]);
  expect(records[1].session).toBe('native-claude-session');
});
