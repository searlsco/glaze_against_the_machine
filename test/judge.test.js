import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { runJudge } from '../eval/tone/judge.js';

for (const provider of ['claude', 'codex']) {
  test(`${provider} judge uses production restrictions and stdin while preserving its identity`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glaze-judge-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const capture = join(directory, 'capture');
    const helper = join(directory, 'eval-judge');
    await writeFile(helper, `#!${process.execPath}
      const { spawnSync } = require('node:child_process');
      const fs = require('node:fs');
      const model = process.env.EVAL_JUDGE?.split(':').slice(1).join(':') || 'default-judge';
      if (process.env.EVAL_JUDGE && !process.env.EVAL_JUDGE.startsWith('claude:')) process.exit(9);
      const result = spawnSync('claude', ['-p', '--model', model, '--output-format', 'json'], {
        input: 'PRIVATE_JUDGE_SENTINEL', encoding: 'utf8', env: process.env,
      });
      if (result.status !== 0) process.exit(8);
      const reply = JSON.parse(result.stdout);
      fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1], reply.result);
      console.error(JSON.stringify({ judge: process.env.EVAL_JUDGE || 'claude:default-judge', costUsd: reply.total_cost_usd }));
    `, { mode: 0o700 });
    const native = `#!${process.execPath}
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args.includes('mcp') && args.includes('list')) { console.log('[]'); process.exit(0); }
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ args, input, cwd: process.cwd() }));
        const result = '[{"id":"item","faithful":true}]';
        if (args.includes('exec')) fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], result);
        else console.log(JSON.stringify({ result, total_cost_usd: 0.01 }));
      });
    `;
    await writeFile(join(directory, provider), native, { mode: 0o700 });
    const env = { ...process.env, CODEX_HOME: directory, EVAL_JUDGE_BIN: helper, EVAL_JUDGE: `${provider}:test-model`,
      PATH: directory + delimiter + process.env.PATH, FAKE_CAPTURE: capture };
    const output = join(directory, 'grades');
    const summary = await runJudge('/rubric', '/items', output, env);
    assert.equal(summary.judge, `${provider}:test-model`);
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [{ id: 'item', faithful: true }]);
    const recorded = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(recorded.input, 'PRIVATE_JUDGE_SENTINEL');
    assert.ok(!recorded.args.some((arg) => arg.includes('PRIVATE_JUDGE_SENTINEL')));
    assert.equal(recorded.args[recorded.args.indexOf('--model') + 1], 'test-model');
    if (provider === 'claude') {
      assert.equal(recorded.args[recorded.args.indexOf('--tools') + 1], '');
      assert.ok(recorded.args.includes('--safe-mode'));
    } else {
      assert.ok(recorded.args.includes('features.shell_tool=false'));
      assert.ok(recorded.args.includes('web_search="disabled"'));
    }
    await assert.rejects(readFile(join(recorded.cwd, 'instructions.txt')), { code: 'ENOENT' });
  });
}

test('malformed judge selection fails before starting any helper', async () => {
  await assert.rejects(runJudge('/rubric', '/items', '/output', { EVAL_JUDGE: 'unsafe:model', EVAL_JUDGE_BIN: '/missing' }), /EVAL_JUDGE must be/);
});
