import { access, chmod, lstat, stat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInspectionDisplay } from './inspection-display.js';
import { createOwnerResolver } from './inspection-owner.js';
import { beginInspection as beginCapture, captureInspection } from './inspection-record.js';
import { leaseViewer } from './inspection-viewers.js';
import { bypassRewrite } from './content.js';

export const inspectionDirectory = (env = process.env) => env.GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR
  || join(homedir(), '.cache', 'glaze_against_the_machine', 'inspect');

export const inspectionFiles = {
  exists: async (path) => { try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
  read: (path) => readFile(path, 'utf8'),
  stat: async (path, { resolve = false } = {}) => {
    const info = await (resolve ? stat : lstat)(path);
    return { kind: info.isFile() ? 'file' : info.isDirectory() ? 'dir' : 'other', isLink: info.isSymbolicLink(),
      size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, dev: info.dev, ino: info.ino, mode: info.mode };
  },
  readStyle: async (path) => {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile()) throw new Error('GLAZES.md must be a regular file.');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  },
  write: (path, value) => writeFile(path, value, { mode: 0o600, flag: 'wx' }),
};

const diagnosticStreams = new WeakSet();
export function reportFailure(failure, diagnostics = process.stderr) {
  try {
    if (diagnostics.on && !diagnosticStreams.has(diagnostics)) {
      diagnostics.on('error', () => {});
      diagnosticStreams.add(diagnostics);
    }
    diagnostics.write(`Glaze Against the Machine: ${failure} Forwarding original prompt unchanged.\n`);
  }
  catch { /* A broken diagnostic stream must not block delivery either. */ }
}

const textItems = (message) => message.params?.input?.filter((item) => item?.type === 'text' && typeof item.text === 'string').map((item) => item.text) ?? [];
const codexRecord = (message, env) => ({ provider: 'codex', method: message.method, agentId: env.PASEO_AGENT_ID,
  owner: env.PASEO_AGENT_ID ? undefined : 'Codex terminal',
  session: message.params?.threadId || env.PASEO_AGENT_ID || `process-${process.pid}`,
  originalTexts: textItems(message), bypass: bypassRewrite(textItems(message)[0] || ''),
  timeoutMs: Number(env.GLAZE_AGAINST_THE_MACHINE_TIMEOUT ?? 30000),
});

export async function beginInspection(record, env = process.env) {
  try { return await beginCapture(inspectionDirectory(env), record, inspectionFiles); }
  catch { /* Inspection must never block prompt delivery. */ }
}

export async function beginCodexInspection(message, env = process.env) {
  if (!textItems(message).length) return;
  return beginInspection(codexRecord(message, env), env);
}

export async function recordCodexInspection(original, glazed, env = process.env, failure, diagnostics, inspection) {
  if (failure) reportFailure(failure, diagnostics);
  try {
    const texts = textItems(glazed);
    if (!texts.length) return;
    if (inspection) await inspection.complete(texts, failure);
    else await recordInspection({ ...codexRecord(original, env), texts, ...(failure && { failure }) }, env);
  } catch { /* Inspection must never block the native request. */ }
}

export async function recordInspection(record, env) {
  try { await captureInspection(inspectionDirectory(env), record, inspectionFiles); }
  catch { /* Inspection must never block prompt delivery. */ }
}

// Prompt text stays out of the provider transport. Only an active inspector
// enables capture, and its lease expires if the viewer is killed unexpectedly.
export async function startInspector({ directory = inspectionDirectory(), output = process.stdout, json = false, resolveOwner = createOwnerResolver() } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const session = randomUUID();
  const inbox = join(directory, session);
  const refresh = () => leaseViewer(directory, session, true);
  await refresh();
  let draining;
  let stopped = false;
  let closed = false;
  const display = createInspectionDisplay({ output, json, resolveOwner });
  const drain = () => {
    if (stopped) return Promise.resolve();
    if (draining) return draining;
    draining = (async () => {
      for (const name of (await readdir(inbox)).filter((name) => name.endsWith('.json')).sort()) {
        const path = join(inbox, name);
        let record;
        try { record = JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error instanceof SyntaxError || error.code === 'ENOENT') continue; throw error; }
        display.record(record);
        await rm(path, { force: true });
      }
    })().finally(() => { draining = undefined; });
    return draining;
  };
  let failure;
  const pending = new Set();
  const run = (operation) => {
    const promise = operation().catch((error) => { failure = error; }).finally(() => pending.delete(promise));
    pending.add(promise);
  };
  const poll = setInterval(() => run(async () => { await drain(); display.tick(); }), 200);
  const heartbeat = setInterval(() => run(refresh), 5000);
  if (!json) output.write('Prompt inspector is listening. Submit a prompt in a refreshed Paseo agent session.\nOriginal and glazed prompts from all integrated sessions, before native hooks. Ctrl-C stops capture.\n');
  return { drain, async stop() {
    if (closed) return;
    closed = true;
    stopped = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    display.stop();
    const settled = await Promise.allSettled([...pending, draining]);
    failure ??= settled.find((result) => result.status === 'rejected')?.reason;
    try { await leaseViewer(directory, session, false); }
    finally { await rm(inbox, { recursive: true, force: true }); }
    if (failure) throw failure;
  } };
}

export async function inspect(options) {
  const inspector = await startInspector(options);
  try {
    await new Promise((resolve) => {
      const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally { await inspector.stop(); }
}
