import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createCodexCwd } from './codex-cwd.js';
import { createCodexOrigins } from './codex-origin.js';
import { prepareClaudeSession } from './claude-session.js';
import { glaze } from './glaze.js';
import { createTextWorker } from './model.js';
import { inspectionDirectory, beginCodexInspection, recordCodexInspection } from './inspection.js';
import { rewriteRequest } from './codex-bridge.js';
import { withRewriteFallback } from './fallback.js';
import { withCancellation } from './cancellation.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const promptMethods = new Set(['turn/start', 'turn/steer']);

// Paseo appends its native SDK arguments to the configured command. Keep stdin
// connected to the SDK transport, rather than reopening the controlling TTY.
export async function runPaseoProvider(provider, command, args, {
  input = process.stdin, output = process.stdout, diagnostics = process.stderr,
  env = process.env, cwd = process.cwd(),
  rewrite,
} = {}) {
  if (!['claude', 'codex'].includes(provider) || !command) throw new Error('Expected a Paseo provider and native command.');
  const directories = createCodexCwd(cwd);
  const origins = createCodexOrigins();
  const automated = Boolean(env.GLAZE_AGAINST_THE_MACHINE_ACTIVE || env.TURBOCOMMIT_DISABLED);
  const proxy = provider === 'codex' && args.includes('app-server') && !automated;
  const worker = proxy && !rewrite ? createTextWorker({ env, model: env.GLAZE_AGAINST_THE_MACHINE_MODEL }) : undefined;
  rewrite ??= (text, context) => glaze(text, {
    provider: 'codex', model: env.GLAZE_AGAINST_THE_MACHINE_MODEL,
    timeout: Number(env.GLAZE_AGAINST_THE_MACHINE_TIMEOUT ?? 30000), env, cwd: context.cwd, signal: context.signal,
    complete: (input, options) => worker.complete(input, options),
  });
  let nativeArgs = [...args];
  let interactiveSession;
  if (provider === 'claude' && !automated && !args.some((arg) => ['--version', '-v', '--help', '-h'].includes(arg))) {
    const prepared = prepareClaudeSession(nativeArgs);
    nativeArgs = prepared.args;
    interactiveSession = prepared.sessionId;
    const separator = nativeArgs.indexOf('--');
    nativeArgs.splice(separator < 0 ? nativeArgs.length : separator, 0, '--plugin-dir', root);
  }
  const childEnv = { ...env, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: inspectionDirectory(env) };
  // A descendant may inherit this environment, but only the user-facing SDK
  // session owns the matching native id. Never carry an outer session's grant.
  delete childEnv.GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION;
  if (interactiveSession) childEnv.GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION = interactiveSession;
  const child = spawn(command, nativeArgs, { env: childEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  // Local rewrite errors share stdout with native replies. Buffer native frames
  // so an error cannot be inserted midway through a split JSON line.
  if (proxy) {
    const nativeOutput = createInterface({ input: child.stdout, crlfDelay: Infinity });
    nativeOutput.on('line', (line) => {
      try { const message = JSON.parse(line); directories.observe(message); origins.observe(message); } catch { /* Preserve native output unchanged. */ }
      output.write(line + '\n');
    });
  } else child.stdout.pipe(output, { end: false });
  child.stderr.pipe(diagnostics, { end: false });
  let lines;
  let ended = false;
  let failed = false;
  let sequence = Promise.resolve();
  const pending = new Set();
  const stop = () => {
    ended = true;
    for (const request of pending) { request.cancelled = true; request.controller.abort(); }
    lines?.close();
    input.unpipe(child.stdin);
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    diagnostics.write('Glaze Against the Machine transport failed. Nothing further was submitted.\n');
    stop();
  };
  const forward = (message) => {
    if (!ended) child.stdin.write(JSON.stringify(message) + '\n');
  };
  child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') fail(); });
  if (proxy) {
    lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { fail(); return; }
      if (!promptMethods.has(message?.method) || origins.isHelper(message)) {
        if (message?.method === 'turn/interrupt') {
          for (const request of pending) {
            if (request.threadId === message.params?.threadId) { request.cancelled = true; request.controller.abort(); }
          }
        }
        forward(message);
        return;
      }
      const request = { threadId: message.params?.threadId, cancelled: false, controller: new AbortController() };
      pending.add(request);
      sequence = sequence.then(async () => {
        let inspection;
        try {
          if (request.cancelled || ended) throw new Error();
          inspection = await beginCodexInspection(message, childEnv);
          const { value: result, failure } = await withCancellation(request.controller.signal,
            () => withRewriteFallback(message,
              () => rewriteRequest(message, rewrite, { cwd: directories.forRequest(message), signal: request.controller.signal })));
          if (request.cancelled || ended) throw new Error();
          await recordCodexInspection(message, result, childEnv, failure, diagnostics, inspection);
          if (request.cancelled || ended) throw new Error();
          forward(result);
        } catch {
          await inspection?.cancel();
          if (!ended && Object.hasOwn(message, 'id')) output.write(JSON.stringify({
            id: message.id, error: { code: -32000, message: 'Prompt submission canceled.' },
          }) + '\n');
          else if (!ended) fail();
        } finally { request.controller.abort(); pending.delete(request); }
      }).catch(fail);
    });
    lines.on('close', () => { void sequence.then(() => { if (!ended) child.stdin.end(); }); });
  } else input.pipe(child.stdin);
  input.on('error', fail);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error(`Could not start the native ${provider} command.`)));
      child.once('close', (code, signal) => resolve(failed ? 1 : code ?? (signal === 'SIGINT' ? 130 : 1)));
    });
  } finally {
    stop();
    await worker?.close();
    input.off('error', fail);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
