import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const maxOutput = 4 * 1024 * 1024;
const host = fileURLToPath(new URL('./codex-worker-host.js', import.meta.url));
const unavailable = () => new Error('Codex rewrite worker failed.');

export class CodexTextWorker {
  constructor({ model, env, prepare }) {
    this.model = model;
    this.env = env;
    this.prepare = prepare;
    this.queue = Promise.resolve();
    this.closed = false;
    this.state = undefined;
  }

  complete(input, { system = '', timeout = 30000, signal, provider = 'codex', model = this.model } = {}) {
    if (this.closed) return Promise.reject(new Error('Rewrite worker is closed.'));
    if (provider !== 'codex' || model !== this.model) return Promise.reject(new Error('Rewrite worker provider and model must match.'));
    if (typeof input !== 'string' || typeof system !== 'string') return Promise.reject(new Error('Model input and instructions must be text.'));
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) return Promise.reject(new Error('Timeout must be an integer between 1 and 2147483647 milliseconds.'));
    if (signal?.aborted) return Promise.reject(new Error('Rewrite canceled.'));
    const deadline = Date.now() + timeout;
    let active = false, canceled = false, state, cancelError;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = (error) => {
      if (canceled) return;
      canceled = true;
      cancelError = error;
      if (active && state) void this.stop(state).then(() => rejectAbort(error));
      else rejectAbort(error);
    };
    const onAbort = () => cancel(new Error('Rewrite canceled.'));
    const timer = setTimeout(() => cancel(new Error('Rewrite timed out.')), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const operation = this.queue.then(async () => {
      if (canceled) throw new Error('Rewrite canceled.');
      if (this.closed) throw new Error('Rewrite worker is closed.');
      active = true;
      state = this.state;
      if (!state) {
        state = { pending: new Map(), nextId: 0, stopped: false, buffer: '', turn: undefined };
        this.state = state;
        state.ready = this.start(state);
      }
      try {
        await state.ready;
        if (canceled || Date.now() >= deadline) throw new Error('Rewrite timed out.');
        return await this.rewrite(state, input, system);
      } catch (error) {
        await this.stop(state);
        throw cancelError ?? error;
      }
    });
    this.queue = operation.then(() => {}, () => {});
    return Promise.race([operation, aborted]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    });
  }

  async start(state) {
    try {
      state.directory = await mkdtemp(join(tmpdir(), 'glaze_against_the_machine-worker-'));
      const { childEnv, configArgs } = await this.prepare(state.directory, {
        env: this.env, model: this.model, system: 'Rewrite the supplied text only.', discover: false,
      });
      if (state.stopped) throw unavailable();
      const child = state.child = spawn(process.execPath, [host, state.directory, ...configArgs], {
        cwd: state.directory, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.resume();
      state.exited = new Promise((resolve) => child.once('close', resolve));
      child.once('error', () => this.fail(state, unavailable()));
      child.once('close', () => this.fail(state, unavailable()));
      child.stdin.on('error', () => this.fail(state, unavailable()));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        if (state.stopped) return;
        state.buffer += data;
        if (Buffer.byteLength(state.buffer) > maxOutput) { state.buffer = ''; this.fail(state, new Error('Rewriter output exceeded 4 MiB.')); return; }
        let end;
        while ((end = state.buffer.indexOf('\n')) >= 0) {
          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 1);
          try { this.receive(state, JSON.parse(line)); }
          catch { this.fail(state, unavailable()); return; }
        }
      });
      await this.rpc(state, 'initialize', {
        clientInfo: { name: 'glaze_against_the_machine', title: 'Glaze Against the Machine', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    } catch (error) {
      if (!state.child && state.directory) await rm(state.directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  rpc(state, method, params) {
    if (state.stopped || !state.child || state.child.stdin.destroyed) return Promise.reject(unavailable());
    const id = ++state.nextId;
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      state.child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) this.fail(state, unavailable());
      });
    });
  }

  receive(state, message) {
    if (Object.hasOwn(message, 'id')) {
      // This worker has no tools, approvals, or model-selected capabilities.
      if (message.method) { this.fail(state, unavailable()); return; }
      const pending = state.pending.get(message.id);
      if (!pending) return;
      state.pending.delete(message.id);
      if (message.error) pending.reject(unavailable());
      else pending.resolve(message.result);
      return;
    }
    const turn = state.turn;
    if (!turn || message.params?.threadId !== turn.threadId) return;
    if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = message.params.item;
      if (!['userMessage', 'agentMessage', 'reasoning', 'contextCompaction'].includes(item?.type)) {
        this.fail(state, unavailable()); return;
      }
      if (message.method === 'item/completed' && item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)) {
        if (typeof item.text !== 'string') { this.fail(state, unavailable()); return; }
        if (Buffer.byteLength(item.text) > maxOutput) { this.fail(state, new Error('Rewriter output exceeded 4 MiB.')); return; }
        turn.text = item.text;
      }
    } else if (message.method === 'turn/completed') {
      if (message.params.turn?.status !== 'completed') turn.reject(unavailable());
      else if (typeof turn.text !== 'string' || !turn.text.trim()) turn.reject(new Error('Rewriter returned an empty prompt.'));
      else turn.resolve(turn.text);
    }
  }

  async rewrite(state, input, system) {
    // Read current effective names through the already-running server. This
    // avoids both a second CLI startup and a stale cache of system MCP servers.
    const loaded = await this.rpc(state, 'config/read', { includeLayers: false, cwd: state.directory });
    const servers = loaded?.config?.mcp_servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Could not inspect Codex tool configuration.');
    const disabled = Object.fromEntries(Object.keys(servers).map((name) => [name, { enabled: false }]));
    const started = await this.rpc(state, 'thread/start', {
      model: this.model, cwd: state.directory, ephemeral: true,
      baseInstructions: system, developerInstructions: '',
      approvalPolicy: 'never', sandbox: 'read-only', dynamicTools: [], environments: [],
      config: { mcp_servers: disabled, thread_unload_delay_secs: 0 },
    });
    const threadId = started?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw unavailable();
    let resolve, reject;
    const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
    // A turn can finish before the turn/start response, so subscribe first.
    state.turn = { threadId, resolve, reject, text: undefined };
    // Install a rejection handler immediately, including during the start RPC.
    completed.catch(() => {});
    try {
      await this.rpc(state, 'turn/start', {
        threadId, input: [{ type: 'text', text: input }], effort: 'low',
        approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly', networkAccess: false }, environments: [],
      });
      const text = await completed;
      await this.rpc(state, 'thread/unsubscribe', { threadId });
      return { text, costUsd: null };
    } finally {
      state.turn = undefined;
    }
  }

  fail(state, error) {
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    state.turn?.reject(error);
    if (!state.stopped) void this.stop(state);
  }

  stop(state) {
    if (state.shutdown) return state.shutdown;
    state.stopped = true;
    if (this.state === state) this.state = undefined;
    this.fail(state, unavailable());
    state.shutdown = (async () => {
      if (!state.child) await state.ready?.catch(() => {});
      if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
        state.child.stdin.end();
        // The supervisor owns TERM/KILL escalation and native child reaping.
        state.child.kill('SIGTERM');
      }
      await state.exited;
      if (state.directory) await rm(state.directory, { recursive: true, force: true }).catch(() => {});
    })();
    return state.shutdown;
  }

  async close() {
    this.closed = true;
    if (this.state) await this.stop(this.state);
    await this.queue;
  }
}
