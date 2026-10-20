import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function runJudge(rubric, items, output, env = process.env) {
  const requested = env.EVAL_JUDGE;
  const selection = requested?.match(/^(claude|codex):(.+)$/);
  if (requested && !selection) throw new Error('EVAL_JUDGE must be claude:<model> or codex:<model>.');
  const judgeEnv = { ...env, GLAZE_AGAINST_THE_MACHINE_ACTIVE: '1' };
  delete judgeEnv.CLAUDECODE;
  if (selection) {
    // eval-judge's Claude CLI contract sends its batch over stdin. Use that
    // contract for either provider so no batch ever enters Codex's argv path.
    judgeEnv.EVAL_JUDGE = `claude:${selection[2]}`;
    judgeEnv.GLAZE_EVAL_PROVIDER = selection[1];
  } else delete judgeEnv.GLAZE_EVAL_PROVIDER;
  const directory = await mkdtemp(join(tmpdir(), 'glaze-judge-'));
  try {
    const adapter = new URL('./provider.js', import.meta.url).href;
    await writeFile(join(directory, 'claude'), `#!${process.execPath}\nimport(${JSON.stringify(adapter)});\n`, { mode: 0o700 });
    // Fail closed if a future helper changes its default to the argv contract.
    await writeFile(join(directory, 'codex'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o700 });
    judgeEnv.GLAZE_EVAL_PROVIDER_PATH = env.PATH;
    judgeEnv.PATH = directory + delimiter + env.PATH;
    const { stderr } = await exec(env.EVAL_JUDGE_BIN || join(homedir(), 'bin/eval-judge'), [
      '--rubric', rubric, '--items', items, '--out', output, '--batch', '30',
    ], { env: judgeEnv, timeout: 960000, maxBuffer: 1024 * 1024 });
    const summary = stderr.trim().split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).findLast((row) => row?.judge);
    if (!summary) throw new Error('Judge did not report its selected model.');
    return { ...summary, judge: requested || summary.judge };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
