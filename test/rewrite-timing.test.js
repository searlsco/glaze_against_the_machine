import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runMatrix, settings } from '../eval/rewrite-timing/experiment.js';
import { metrics, renderReport, summarize } from '../eval/rewrite-timing/report.js';

const models = { claude: 'fake-claude', codex: 'fake-codex' };
const fixtures = [
  { id: 'short-neutral', length: 'short', sentiment: 'neutral', input: 'Fix the parser.' },
  { id: 'long-angry', length: 'long', sentiment: 'angry', input: 'Fix this damn parser.\nKeep the data.' },
];
const completed = (seconds, provider = 'claude') => ({ seconds, provider, length: 'short', sentiment: 'neutral', status: 'completed' });

test('timing statistics use the arithmetic mean and numeric median, excluding failed durations', () => {
  const rows = [completed(20), completed(1), completed(3), completed(2), { ...completed(90), status: 'error' }];
  assert.deepEqual(summarize(rows), { attempted: 5, completed: 4, failed: 1, medianSeconds: 2.5, meanSeconds: 6.5, totalSeconds: 26, attemptedSeconds: 116 });
  assert.equal(summarize(rows.slice(0, 3)).medianSeconds, 3);
  assert.equal(summarize([{ ...completed(90), status: 'error' }]).meanSeconds, null);
  assert.deepEqual(summarize([]), { attempted: 0, completed: 0, failed: 0, medianSeconds: null, meanSeconds: null, totalSeconds: 0, attemptedSeconds: 0 });
  const grouped = metrics([...rows, completed(4, 'codex')]);
  assert.equal(grouped.byProvider.codex.totalSeconds, 4);
  assert.equal(grouped.byProvider.claude.attemptedSeconds, 116);
  assert.equal(grouped.byLength.short.completed, 5);
  assert.equal(grouped.bySentiment.neutral.failed, 1);
});

test('matched pairs run serially in alternating provider order, repeat samples, and retain failures', async () => {
  let clock = 0;
  let active = false;
  const saved = [];
  const rows = await runMatrix({ fixtures, models, samples: 2, timeout: 1234 }, {
    now: () => clock,
    rewrite: async (input, options) => {
      assert.equal(active, false);
      active = true;
      assert.equal(options.model, models[options.provider]);
      assert.equal(options.timeout, 1234);
      clock += options.provider === 'claude' ? 1000 : 2500;
      await Promise.resolve();
      active = false;
      if (input === fixtures[1].input && options.provider === 'codex') throw new Error('Rewrite timed out.');
      return 'Rewritten: ' + input;
    },
    onRow: async (row) => saved.push(structuredClone(row)),
  });
  assert.deepEqual(rows, saved);
  assert.equal(rows.length, 8);
  assert.equal(new Set(rows.map((row) => row.id)).size, 8);
  assert.deepEqual(rows.map((row) => row.provider), ['claude', 'codex', 'codex', 'claude', 'claude', 'codex', 'codex', 'claude']);
  for (const row of rows) {
    assert.equal(row.seconds, row.provider === 'claude' ? 1 : 2.5);
    assert.equal(row.input, fixtures.find((fixture) => fixture.id === row.case).input);
    if (row.status === 'error') {
      assert.equal(row.output, null);
      assert.equal(row.error, 'Rewrite timed out.');
    } else assert.equal(row.output, 'Rewritten: ' + row.input);
  }
  assert.equal(metrics(rows).overall.failed, 2);
});

test('cancellation saves the in-flight error then stops scheduling requests', async () => {
  const controller = new AbortController();
  const rows = await runMatrix({ fixtures, models, samples: 2, timeout: 1234 }, {
    signal: controller.signal,
    rewrite: async (input, { signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      throw new Error('Rewrite canceled.');
    }, onRow: async () => {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].output, null);
});

test('eval configuration validates subsets, repetitions, deadlines, and model overrides', () => {
  assert.equal(settings({}, fixtures, models).samples, 1);
  assert.equal(settings({ EVAL_FULL: '1' }, fixtures, models).samples, 3);
  const options = settings({ EVAL_CASES: 'long-angry', EVAL_SAMPLES: '2', EVAL_FULL: '1', EVAL_CODEX_MODEL: 'custom', EVAL_TIMEOUT_MS: '4567' }, fixtures, models);
  assert.deepEqual(options, { samples: 2, timeout: 4567, fixtures: [fixtures[1]], models: { ...models, codex: 'custom' } });
  for (const env of [{ EVAL_SAMPLES: '0' }, { EVAL_SAMPLES: '1.5' }, { EVAL_TIMEOUT_MS: 'NaN' }, { EVAL_TIMEOUT_MS: '2147483648' }, { EVAL_CASES: '' }, { EVAL_CASES: 'missing' }, { EVAL_WRITE_BASELINE: '1' }]) {
    assert.throws(() => settings(env, fixtures, models));
  }
});

test('report renders literal input/output safely and makes failures and ungraded quality visible', () => {
  const rows = [
    { ...completed(1), id: 'claude/case/1', model: 'fake', input: '<script>alert("input")</script>\n& before', output: '<img src=x onerror=alert(1)>', inputWords: 4, inputChars: 55 },
    { ...completed(90, 'codex'), id: 'codex/case/1', model: 'fake', input: 'Original', output: null, error: '<timeout>', status: 'error', inputWords: 1, inputChars: 8 },
  ];
  const html = renderReport(rows, { status: 'error', reason: 'one failure', models: ['claude:fake', 'codex:fake'], timeoutMs: 90000, seconds: 92, startedAt: 'today', gitRef: 'abc', machine: 'test', os: 'test', node: 'test', metrics: { ...metrics(rows), loadAvg: [1, 2, 3] } });
  assert.ok(html.includes('&lt;script&gt;alert(&quot;input&quot;)&lt;/script&gt;\n&amp; before'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('No accepted rewrite: &lt;timeout&gt;'));
  assert.ok(html.includes('Quality is ungraded'));
  assert.ok(html.includes('n/a'));
  assert.ok(html.includes('91.000 s'));
});

test('fixtures cover every length/sentiment pair without reusing neutral sentences as the frustrated or angry body', async () => {
  const cases = JSON.parse(await readFile(new URL('../eval/rewrite-timing/fixtures/cases.json', import.meta.url), 'utf8'));
  assert.equal(cases.length, 9);
  for (const length of ['short', 'medium', 'long']) {
    const group = cases.filter((row) => row.length === length);
    assert.deepEqual(group.map((row) => row.sentiment), ['neutral', 'frustrated', 'angry']);
    const sentences = (input) => input.toLowerCase().split(/[.!?]+\s*|\n+/u).map((sentence) => sentence.trim()).filter(Boolean);
    const neutralSentences = new Set(sentences(group[0].input));
    for (const row of group) {
      const words = row.input.split(/\s+/).length;
      assert.ok(length === 'short' ? words < 30 : length === 'medium' ? words > 70 && words < 150 : words > 300 && words < 500);
      if (row.sentiment !== 'neutral') {
        assert.ok(!row.input.endsWith(group[0].input), row.id);
        assert.ok(sentences(row.input).every((sentence) => !neutralSentences.has(sentence)), row.id);
      }
    }
  }
});

test('direct execution without the eval environment refuses real model calls', () => {
  const env = { ...process.env };
  delete env.SEARLS_EVAL;
  const run = fileURLToPath(new URL('../eval/rewrite-timing/run', import.meta.url));
  const result = spawnSync(process.execPath, [run], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run script\/eval rewrite-timing/);
});

for (const failCodex of [false, true]) {
  test(`runner writes usable artifacts and an accurate exit code with ${failCodex ? 'one failed' : 'successful'} fake providers`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glaze-timing-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const out = join(directory, 'out');
    await mkdir(out);
    const fake = `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args.includes('mcp')) { console.log('[]'); process.exit(0); }
      if (args.includes('exec') && process.env.FAIL_CODEX === '1') process.exit(7);
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const appreciation = 'Your effort is appreciated';
        const encouragement = 'Best wishes for this work';
        const result = JSON.stringify({ body: 'Fix the parser bug. Do not change authentication or deploy anything. ' + appreciation + '; ' + encouragement + '.', appreciation, encouragement, workRequested: true });
        if (args.includes('exec')) fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], result);
        else console.log(JSON.stringify({ result }));
      });
    `;
    for (const provider of Object.keys(models)) await writeFile(join(directory, provider), fake, { mode: 0o700 });
    const run = fileURLToPath(new URL('../eval/rewrite-timing/run', import.meta.url));
    const env = { ...process.env, PATH: directory + delimiter + process.env.PATH, HOME: directory, CODEX_HOME: directory,
      SEARLS_EVAL: 'rewrite-timing', EVAL_OUT: out, EVAL_DIR: fileURLToPath(new URL('../eval/rewrite-timing/', import.meta.url)),
      EVAL_CASES: 'short-neutral', EVAL_SAMPLES: '1', EVAL_WRITE_BASELINE: '0', FAIL_CODEX: failCodex ? '1' : '0' };
    delete env.GLAZE_AGAINST_THE_MACHINE_ACTIVE;
    const result = spawnSync(process.execPath, [run], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, failCodex ? 2 : 0, result.stdout + result.stderr);
    const verdict = JSON.parse(await readFile(join(out, 'verdict.json'), 'utf8'));
    const rows = (await readFile(join(out, 'rows.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(verdict.metrics.overall.completed, failCodex ? 1 : 2);
    assert.equal(verdict.qualityAssessed, false);
    assert.equal(verdict.judge, null);
    assert.equal(rows[1].output === null, failCodex);
    assert.match(await readFile(join(out, 'report.html'), 'utf8'), /Fix the parser bug/);
    assert.match(result.stdout, /median .*mean .*total /);
  });
}
