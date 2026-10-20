// This small supervisor owns the native process even if its launcher is killed.
// Parent EOF is a shutdown request; never leave a detached native process behind.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';

const [directory, ...configArgs] = process.argv.slice(2);
const child = spawn('codex', ['--no-daemon', 'app-server', '--strict-config', '--listen', 'stdio://', ...configArgs], {
  cwd: directory, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
});
let stopping = false;
let terminateTimer, killTimer;
const kill = (signal) => {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { try { child.kill(signal); } catch { /* Already exited. */ } }
};
const stop = (immediate = false) => {
  if (stopping) return;
  stopping = true;
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  if (immediate) kill('SIGTERM');
  else terminateTimer = setTimeout(() => kill('SIGTERM'), 250);
  killTimer = setTimeout(() => kill('SIGKILL'), 2000);
};
child.stderr.resume();
child.stdout.pipe(process.stdout, { end: false });
process.stdin.pipe(child.stdin);
process.stdin.on('end', () => stop());
process.stdin.on('error', () => stop(true));
process.stdout.on('error', () => stop(true));
child.stdin.on('error', () => stop(true));
process.once('SIGINT', () => stop(true));
process.once('SIGTERM', () => stop(true));
try {
  process.exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code ?? 1));
  });
} finally {
  clearTimeout(terminateTimer);
  clearTimeout(killTimer);
  process.stdin.unpipe(child.stdin);
  process.stdin.destroy();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
