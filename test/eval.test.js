import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { protectedFailures, validateGrade, wordingDiversity } from '../eval/tone/oracles.js';

test('exact preservation rejects typographic edits to technical content', () => {
  const fixture = { protected: ['`run --name "literal"`', "```js\nthrow new Error('shit');\n```"] };
  assert.deepEqual(protectedFailures(fixture, fixture.protected.join('\n')), []);
  assert.equal(protectedFailures(fixture, fixture.protected.join('\n').replace('"literal"', '“literal”')).length, 1);
});
test('model grades must provide hard booleans and bounded soft scores', () => {
  const valid = { faithful: true, professional: false, supportive: true, warmth: 3, typography: 5, reason: 'Still hostile.' };
  assert.equal(validateGrade(valid), true);
  assert.equal(validateGrade({ ...valid, faithful: 'true' }), false);
  assert.equal(validateGrade({ ...valid, supportive: undefined }), false);
  assert.equal(validateGrade({ ...valid, warmth: 6 }), false);
});

test('fixtures distinguish real excerpts from synthetic coverage and protect actual source spans', async () => {
  const cases = JSON.parse(await readFile(new URL('../eval/tone/fixtures/cases.json', import.meta.url), 'utf8'));
  assert.equal(new Set(cases.map((row) => row.id)).size, cases.length);
  for (const row of cases) {
    assert.deepEqual(protectedFailures(row, row.input), []);
    assert.ok(row.requirements.length);
    if (row.source.kind === 'session-excerpt') assert.match(row.source.sessionId, /^[a-f0-9-]{36}$/);
    else assert.equal(row.source.kind, 'synthetic');
  }
});

test('wording diversity measures integrated messages across repeated samples, ignoring punctuation', () => {
  const items = [
    { id: 'claude/neutral/1', measureWording: true, output: 'Your effort matters; please fix it with my thanks.' },
    { id: 'claude/neutral/2', measureWording: true, output: 'YOUR effort matters! Please fix it with my thanks!' },
    { id: 'claude/neutral/3', measureWording: true, output: 'Thank you for the effort; please fix it with my support.' },
    { id: 'codex/neutral/1', measureWording: true, output: 'A separate provider.' },
    { id: 'claude/other/1', output: 'Unmeasured fixture.' },
  ];
  assert.deepEqual(wordingDiversity(items), { 'claude/neutral': { samples: 3, uniqueRewrites: 2,
    uniqueLeadingPhrases: 2, uniqueTrailingPhrases: 2 } });
});
