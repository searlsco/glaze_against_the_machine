import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexModel } from './codex-model-config.js';
import { CodexTextWorker } from './codex-text-worker.js';

export const defaults = { claude: 'haiku', codex: 'gpt-6-luna' };
const maxOutput = 4 * 1024 * 1024;

// No shell: neither the submitted text nor model output becomes executable syntax.
export function execute(command, args, { input, cwd, env, timeout, signal }) {
  if (signal?.aborted) return Promise.reject(new Error('Rewrite canceled.'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '';
    let size = 0;
    let failure;
    const stop = (message) => {
      failure ??= new Error(message);
      // Descendants must not outlive a deadline or keep the output pipe open.
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => stop(`Rewrite timed out after ${timeout} ms.`), timeout);
    const abort = () => stop('Rewrite canceled.');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxOutput) stop('Rewriter output exceeded 4 MiB.');
      else stdout += chunk;
    });
    // Provider diagnostics can echo the source prompt. Do not log them.
    child.stderr.resume();
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stop('Could not send input to the rewriter.');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new Error(error.code === 'ENOENT' ? `${command} is not installed or is not on PATH.` : `Could not start ${command}.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited with status ${code}. Check its authentication and model access.`));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

// All subprocess model calls, including eval judges, use this text-only boundary.
// Network is available to the provider transport, never to model-selected tools.
export async function completeText(input, { provider = 'claude', model, system = '', timeout = 30000, env = process.env, signal } = {}) {
  if (!Object.hasOwn(defaults, provider)) throw new Error('Provider must be claude or codex.');
  if (typeof input !== 'string' || typeof system !== 'string') throw new Error('Model input and instructions must be text.');
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error('Timeout must be an integer between 1 and 2147483647 milliseconds.');
  if (signal?.aborted) throw new Error('Rewrite canceled.');
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('Rewrite timed out.');
    return value;
  };
  const directory = await mkdtemp(join(tmpdir(), 'glaze_against_the_machine-'));
  const childEnv = { ...env, GLAZE_AGAINST_THE_MACHINE_ACTIVE: '1' };
  delete childEnv.CLAUDECODE;
  try {
    let text, costUsd = null;
    if (provider === 'claude') {
      const settings = { disableAllHooks: true, sandbox: {
        enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
        network: { allowedDomains: [], allowLocalBinding: false, allowAllUnixSockets: false },
      } };
      const output = await execute('claude', [
        '-p', '--model', model ?? defaults.claude, '--effort', 'low',
        '--input-format', 'text', '--output-format', 'json', '--no-session-persistence',
        '--safe-mode', '--restricted', '--permission-mode', 'dontAsk', '--no-chrome',
        '--setting-sources', '', '--settings', JSON.stringify(settings),
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', '', '--disable-slash-commands', '--system-prompt', system,
      ], { input, cwd: directory, env: childEnv, timeout: remaining(), signal });
      let response;
      try { response = JSON.parse(output); } catch { throw new Error('Claude returned invalid JSON.'); }
      if (response.is_error) throw new Error('Claude could not complete the rewrite.');
      text = response.result;
      costUsd = response.total_cost_usd ?? null;
    } else {
      const outputPath = join(directory, 'result.txt');
      const { configArgs, childEnv: codexEnv } = await prepareCodexModel(directory, {
        env, model: model ?? defaults.codex, system, execute, remaining, signal,
      });
      // read-only denies command network access. Hosted tools must also be off.
      await execute('codex', [
        '--no-daemon', 'exec', '--strict-config', '--model', model ?? defaults.codex, '--ignore-user-config', '--ignore-rules',
        '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
        ...configArgs,
        '--output-last-message', outputPath, '-',
      ], { input, cwd: directory, env: codexEnv, timeout: remaining(), signal });
      try {
        if ((await stat(outputPath)).size > maxOutput) throw new Error('Rewriter output exceeded 4 MiB.');
        text = await readFile(outputPath, 'utf8');
      } catch (error) {
        if (error.message === 'Rewriter output exceeded 4 MiB.') throw error;
        throw new Error('Codex did not produce a rewrite.');
      }
    }
    if (typeof text !== 'string' || !text.trim()) throw new Error('Rewriter returned an empty prompt.');
    if (Buffer.byteLength(text) > maxOutput) throw new Error('Rewriter output exceeded 4 MiB.');
    return { text, costUsd };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

// A session wrapper owns this worker and closes it with the native session.
export function createTextWorker({ provider = 'codex', model = defaults.codex, env = process.env } = {}) {
  if (provider !== 'codex') throw new Error('Persistent text workers require Codex.');
  return new CodexTextWorker({ model, env, prepare: prepareCodexModel });
}
