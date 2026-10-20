import { codexLaunchCwd, createCodexCwd } from './codex-cwd.js';
import { createCodexOrigins } from './codex-origin.js';
import { beginCodexInspection, recordCodexInspection } from './inspection.js';
import { bypassRewrite } from './content.js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';
import { glaze } from './glaze.js';
import { createTextWorker } from './model.js';
import { withRewriteFallback } from './fallback.js';
import { withCancellation } from './cancellation.js';

const promptMethods = new Set(['turn/start', 'turn/steer']);

// The remote TUI forwards only some config keys in thread/start. Keep explicit
// launch overrides on its app-server too, including custom providers and prompts.
export function codexServerArgs(args) {
  const forwarded = [];
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i];
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      if (args[i + 1] === undefined) throw new Error(`Codex option ${arg} requires a value.`);
      forwarded.push(arg, args[++i]);
    } else if (/^--(?:config|enable|disable)=/.test(arg) || arg === '--strict-config') {
      forwarded.push(arg);
    } else if (arg.startsWith('-c') && arg.length > 2 && !arg.startsWith('--')) {
      forwarded.push('-c', arg.slice(2));
    }
  }
  return forwarded;
}

// Replacing an input changes its byte offsets, so discard only UI span metadata.
// Images, skill invocations, mentions, and other non-text inputs remain untouched.
export async function rewriteRequest(message, rewrite, context = {}) {
  if (!promptMethods.has(message?.method) || !Array.isArray(message.params?.input)) return message;
  const firstText = message.params.input.find((item) => item?.type === 'text' && typeof item.text === 'string');
  if (firstText && bypassRewrite(firstText.text)) return message;
  const input = await Promise.all(message.params.input.map(async (item) => {
    if (item?.type !== 'text' || typeof item.text !== 'string' || !item.text.trim()) return item;
    const text = await rewrite(item.text, context);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Rewriter returned an empty prompt.');
    if (text === item.text) return item;
    return { ...item, text, ...(Object.hasOwn(item, 'text_elements') ? { text_elements: [] } : {}) };
  }));
  return { ...message, params: { ...message.params, input } };
}

// The normal Codex TUI speaks its documented app-server protocol through this
// local bridge. Rewrites happen before app-server sees the request or runs hooks.
export async function startCodexBridge({
  rewrite,
  command = 'codex', serverArgs = [], env = process.env, cwd = process.cwd(),
} = {}) {
  const worker = rewrite ? undefined : createTextWorker({ env, model: env.GLAZE_AGAINST_THE_MACHINE_MODEL });
  rewrite ??= (prompt, context) => glaze(prompt, {
    provider: 'codex', cwd: context.cwd, signal: context.signal, env,
    model: env.GLAZE_AGAINST_THE_MACHINE_MODEL,
    timeout: Number(env.GLAZE_AGAINST_THE_MACHINE_TIMEOUT ?? 30000),
    complete: (input, options) => worker.complete(input, options),
  });
  const automated = Boolean(env.GLAZE_AGAINST_THE_MACHINE_ACTIVE || env.TURBOCOMMIT_DISABLED);
  const directories = createCodexCwd(cwd);
  const origins = createCodexOrigins();
  // Codex accepts only a bare host and port. Authenticate the handshake instead
  // of putting the capability token in a URL path the native TUI rejects.
  const token = randomBytes(32).toString('hex');
  const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, path: '/', maxPayload: 4 * 1024 * 1024,
    verifyClient: ({ req }) => req.headers.authorization === `Bearer ${token}`,
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  let client;
  let closing;
  let ended = false;
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });
  const child = spawn(command, ['app-server', '--listen', 'stdio://', ...serverArgs], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Provider output and diagnostics can contain prompts. Relay protocol frames
  // only to the authenticated local client, never to the launcher's terminal.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const send = (message) => {
    if (client?.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const pending = new Set();
  const close = () => {
    if (closing) return closing;
    ended = true;
    for (const request of pending) { request.cancelled = true; request.controller.abort(); }
    client?.terminate();
    closing = Promise.all([new Promise((resolve) => server.close(resolve)), worker?.close()]).then(() => {});
    lines.close();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }
    return closing;
  };
  const finish = (result) => {
    resolveExited(result);
    void close();
  };
  child.once('error', () => finish({ code: 1, error: 'Could not start Codex app-server.' }));
  child.once('close', (code, signal) => finish({ code, signal }));
  child.stdin.on('error', () => { void close(); });
  lines.on('line', (line) => {
    try { const message = JSON.parse(line); directories.observe(message); origins.observe(message); send(message); }
    catch { finish({ code: 1, error: 'Codex app-server returned an invalid protocol frame.' }); }
  });
  server.on('error', () => finish({ code: 1, error: 'The local Codex bridge failed.' }));
  server.on('connection', (socket) => {
    if (client || ended) { socket.close(1008, 'Only one local client is allowed.'); return; }
    client = socket;
    let sequence = Promise.resolve();
    const forward = (message) => {
      if (!ended && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1003, 'JSON text frames are required.'); return; }
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { send({ id: null, error: { code: -32700, message: 'Invalid JSON.' } }); return; }
      if (automated || !promptMethods.has(message?.method) || origins.isHelper(message)) {
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
          inspection = await beginCodexInspection(message, env);
          const { value: rewritten, failure } = await withCancellation(request.controller.signal,
            () => withRewriteFallback(message,
              () => rewriteRequest(message, rewrite, { cwd: directories.forRequest(message), signal: request.controller.signal })));
          if (request.cancelled || ended) throw new Error();
          await recordCodexInspection(message, rewritten, env, failure, undefined, inspection);
          if (request.cancelled || ended) throw new Error();
          forward(rewritten);
        } catch {
          await inspection?.cancel();
          // Rewrite and inspection failures are handled above. Cancellation
          // still prevents delivery, including while fallback logging is pending.
          if (Object.hasOwn(message, 'id')) send({ id: message.id, error: {
            code: -32000,
            message: 'Prompt submission canceled.',
          } });
        } finally { request.controller.abort(); pending.delete(request); }
      });
    });
    socket.on('error', () => { void close(); });
    socket.on('close', () => { void close(); });
  });
  return { url: `ws://127.0.0.1:${server.address().port}`, token, close, exited };
}

export async function runCodex(args = [], options = {}) {
  const bridge = await startCodexBridge({
    ...options, cwd: codexLaunchCwd(args, options.cwd), serverArgs: [...(options.serverArgs ?? []), ...codexServerArgs(args)],
  });
  const tokenEnv = 'GLAZE_AGAINST_THE_MACHINE_CODEX_TOKEN';
  const child = spawn(options.command ?? 'codex', ['--remote', bridge.url, '--remote-auth-token-env', tokenEnv, ...args], {
    cwd: options.cwd, env: { ...(options.env ?? process.env), [tokenEnv]: bridge.token }, stdio: 'inherit',
  });
  const stop = () => { child.kill('SIGTERM'); void bridge.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await Promise.race([
      new Promise((resolve) => {
        child.once('error', () => resolve({ code: 1, error: 'Could not start the Codex terminal UI.' }));
        child.once('close', (code, signal) => resolve({ code, signal }));
      }),
      bridge.exited,
    ]);
    if (result.error) throw new Error(result.error);
    return result.code ?? (result.signal ? 130 : 1);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    child.kill('SIGTERM');
    await bridge.close();
  }
}
