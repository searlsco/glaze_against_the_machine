#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { inspect, beginInspection, reportFailure } from '../src/inspection.js';
import { bypassRewrite } from '../src/content.js';
import { glaze, defaults } from '../src/glaze.js';
import { install, root } from '../src/install.js';
import { runCodex } from '../src/codex-bridge.js';
import { runPaseoProvider } from '../src/paseo.js';
import { configurePaseo } from '../src/paseo-configure.js';
import { withRewriteFallback } from '../src/fallback.js';

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
class UsageError extends Error {}

const help = `Usage:
  glaze_against_the_machine [--provider claude|codex] [--model MODEL] [--timeout MS] [--json] [TEXT]
  glaze_against_the_machine run claude|codex --prompt TEXT [-- AGENT_OPTIONS...]
  glaze_against_the_machine claude [CLAUDE_OPTIONS...]
  glaze_against_the_machine codex [CODEX_OPTIONS...]
  glaze_against_the_machine install claude|codex|all [--bin-dir DIRECTORY]
  glaze_against_the_machine uninstall [claude|codex|all] [--bin-dir DIRECTORY] [--home PASEO_HOME]
  glaze_against_the_machine tail [--json]
  glaze_against_the_machine install|uninstall paseo [--home PASEO_HOME]

With no TEXT, reads UTF-8 stdin. --json reads an object with a string "prompt"
and emits the same object with only that field replaced. This is an upstream
filter protocol, NOT a native UserPromptSubmit hook response.
Prompts whose first word is rawdog (case-insensitive, ignoring leading whitespace)
pass through unchanged, including their original whitespace.
Inline code and fenced blocks are preserved exactly; only surrounding prose changes.

run rewrites the initial prompt, then starts the agent in the current directory.
Later prompts typed inside that agent are not intercepted.
claude loads the prompt.submit mod; codex uses a local app-server bridge.
These launchers rewrite every human prompt before legacy prompt hooks.
install requires an explicit target: claude registers its mod for ordinary claude
sessions; codex creates glazed_codex; all explicitly installs both integrations.
install paseo wraps Paseo's native providers and reloads its configuration.
Paseo supports available Claude and Codex providers only. Start a new chat afterward.
uninstall without a target removes terminal integrations and the installed Paseo integration.
Codex hooks require review and trust in /hooks; installation never bypasses it.

Defaults: Claude Haiku; Codex gpt-6-luna; timeout 30000 ms.
Environment: GLAZE_AGAINST_THE_MACHINE_PROVIDER, GLAZE_AGAINST_THE_MACHINE_MODEL, GLAZE_AGAINST_THE_MACHINE_TIMEOUT.
Rewrite failures pass the original prompt through unchanged and are reported to tail.
`;

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 1 && ['--version', '-v'].includes(raw[0])) {
    process.stdout.write(version + '\n'); return;
  }
  if (['tail', 'inspect'].includes(raw[0])) {
    const { values, positionals } = parseArgs({ args: raw.slice(1), options: { json: { type: 'boolean' } }, allowPositionals: true });
    if (positionals.length) throw new UsageError('tail takes no positional arguments.');
    await inspect({ json: values.json });
    return;
  }
  if (raw[0] === 'paseo') {
    const [, provider, separator, command, ...args] = raw;
    if (!['claude', 'codex'].includes(provider) || separator !== '--' || !command) {
      throw new UsageError('Internal Paseo launcher expects claude|codex -- NATIVE_COMMAND [ARGS...].');
    }
    process.exitCode = await runPaseoProvider(provider, command, args);
    return;
  }
  if (['install', 'uninstall'].includes(raw[0])) {
    const command = raw.shift();
    const { values, positionals } = parseArgs({ args: raw, allowPositionals: true, options: {
      'bin-dir': { type: 'string' }, home: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { process.stdout.write(help); return; }
    if (positionals.length > 1) throw new UsageError('Expected one install target: claude, codex, paseo, or all.');
    if (command === 'install' && !positionals.length) throw new UsageError('Choose an install target: claude, codex, or paseo. Use all for both terminal integrations.');
    if (positionals[0] === 'paseo') {
      if (values['bin-dir']) throw new UsageError('Paseo installation uses its own home directory, not --bin-dir.');
      process.stdout.write(await configurePaseo({ home: values.home, remove: command === 'uninstall' }) + '\n');
      return;
    }
    if (positionals[0] && !['claude', 'codex', 'all'].includes(positionals[0])) throw new UsageError('Install target must be claude, codex, paseo, or all.');
    const removeAll = command === 'uninstall' && (!positionals[0] || positionals[0] === 'all');
    if (values.home && !removeAll) throw new UsageError('--home applies only to Paseo installation or uninstalling all integrations.');
    const paseo = removeAll ? await configurePaseo({ home: values.home, remove: true, optional: true }) : undefined;
    const terminal = await install({ target: positionals[0], binDir: values['bin-dir'], remove: command === 'uninstall' });
    process.stdout.write([terminal, paseo].filter(Boolean).join('\n') + '\n');
    return;
  }
  if (raw[0] === 'codex') {
    process.exitCode = await runCodex(raw.slice(1));
    return;
  }
  if (raw[0] === 'claude') {
    const args = raw.slice(1);
    const separator = args.indexOf('--');
    args.splice(separator < 0 ? args.length : separator, 0, '--plugin-dir', root);
    await launch('claude', args);
    return;
  }
  if (raw[0] === 'rewrite') raw.shift();
  const running = raw[0] === 'run';
  let target;
  let agentArgs = [];
  if (running) {
    raw.shift();
    target = raw.shift();
    if (!Object.hasOwn(defaults, target)) throw new UsageError('run requires claude or codex.');
    const separator = raw.indexOf('--');
    if (separator >= 0) agentArgs = raw.splice(separator).slice(1);
  }
  const { values, positionals } = parseArgs({ args: raw, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, provider: { type: 'string' },
    model: { type: 'string' }, timeout: { type: 'string' },
    json: { type: 'boolean' }, prompt: { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  if (positionals.length > 1) throw new UsageError('Pass prompt text as one quoted argument or through stdin.');
  if (running && values.json) throw new UsageError('run does not support --json.');
  if (running && values.prompt === undefined) throw new UsageError('run requires --prompt TEXT.');
  if (values.prompt !== undefined && positionals.length) throw new UsageError('Use either --prompt or TEXT.');
  const source = values.prompt ?? positionals[0];
  if (values.json && source !== undefined) throw new UsageError('--json reads its envelope from stdin.');
  if (source === undefined && process.stdin.isTTY) { process.stdout.write(help); return; }
  let input = source;
  if (input === undefined) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = Buffer.concat(chunks).toString('utf8');
  }
  let envelope;
  if (values.json) {
    try { envelope = JSON.parse(input); } catch { throw new Error('Input must be valid JSON.'); }
    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object' || typeof envelope.prompt !== 'string') {
      throw new Error('JSON input must be an object with a string prompt field.');
    }
  }
  const provider = values.provider ?? target ?? process.env.GLAZE_AGAINST_THE_MACHINE_PROVIDER ?? 'claude';
  const timeout = Number(values.timeout ?? process.env.GLAZE_AGAINST_THE_MACHINE_TIMEOUT ?? 30000);
  if (!Object.hasOwn(defaults, provider)) throw new UsageError('Provider must be claude or codex.');
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw new UsageError('Timeout must be an integer between 1 and 2147483647 milliseconds.');
  const original = values.json ? envelope.prompt : input;
  const inspection = await beginInspection({ provider: target || provider, owner: target ? `${target} initial prompt` : `${provider} filter`,
    session: envelope?.session_id || `process-${process.pid}`, method: running ? 'run' : 'filter',
    originalTexts: [original], bypass: bypassRewrite(original), timeoutMs: timeout,
  });
  const { value: result, failure } = await withRewriteFallback(original, () => glaze(original, {
    provider,
    model: values.model ?? process.env.GLAZE_AGAINST_THE_MACHINE_MODEL,
    timeout,
  }));
  if (failure) reportFailure(failure);
  await inspection?.complete([result], failure);
  if (!running) {
    process.stdout.write((values.json ? JSON.stringify({ ...envelope, prompt: result }) : result) + (values.json || (!failure && !bypassRewrite(result)) ? '\n' : ''));
    return;
  }
  await launch(target, [...agentArgs, '--', result]);
}

async function launch(target, args) {
  // Reopen the controlling terminal if the wrapper itself was called with piped stdin.
  let terminal;
  if (!process.stdin.isTTY) {
    try { terminal = openSync('/dev/tty', 'r'); } catch { /* Noninteractive agent options still work. */ }
  }
  const child = spawn(target, args, { stdio: [terminal ?? 'inherit', 'inherit', 'inherit'] });
  const interrupt = () => { child.kill('SIGINT'); };
  const terminate = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
        resolve();
      });
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    if (terminal !== undefined) closeSync(terminal);
  }
}

main().catch((error) => {
  if (error.code === 'EPIPE') { process.exitCode = 0; return; }
  process.stderr.write(`glaze_against_the_machine: ${error.message}\n`);
  const usage = error instanceof UsageError || error.code?.startsWith('ERR_PARSE_ARGS');
  if (usage) process.stderr.write('Run glaze_against_the_machine --help for usage.\n');
  process.exitCode = usage ? 2 : 1;
});

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
