import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../src/install.js';

test('Codex installer is idempotent, executable, explains trust, and uninstalls only owned files', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { target: 'codex', binDir: directory };
  const output = await install(options);
  assert.match(output, /review and trust in \/hooks/);
  assert.match(output, /Direct codex launches are unchanged/);
  const path = join(directory, 'glazed_codex');
  const first = await readFile(path, 'utf8');
  assert.ok((await stat(path)).mode & 0o111);
  await install(options);
  assert.equal(await readFile(path, 'utf8'), first);
  await install({ ...options, remove: true });
  await install({ ...options, remove: true });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await writeFile(path, 'unrelated executable');
  await assert.rejects(install(options), /unrelated file/);
  await assert.rejects(install({ ...options, remove: true }), /unrelated file/);
  assert.equal(await readFile(path, 'utf8'), 'unrelated executable');
});

test('usage and version never call a model; invalid options exit 2', () => {
  const cli = new URL('../bin/glaze_against_the_machine.js', import.meta.url).pathname;
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /install claude\|codex\|all/);
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
  const invalid = spawnSync(process.execPath, [cli, '--nonsense'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /--help/);
});

test('bare install requires a target before creating files or invoking a provider', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-explicit-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binDir = join(directory, 'bin');
  await assert.rejects(install({ binDir }), /explicit install target/);
  const cli = new URL('../bin/glaze_against_the_machine.js', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [cli, 'install', '--bin-dir', binDir], {
    encoding: 'utf8', env: { ...process.env, PATH: directory, HOME: directory },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Choose an install target/);
  assert.equal(result.stdout, '');
  await assert.rejects(stat(binDir), { code: 'ENOENT' });
});

test('terminal installer migrates an owned legacy launcher to its underscore name', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-legacy-launcher-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'glazed-codex');
  await writeFile(path, '#!/bin/sh\n# Managed by prompt-glazer\nexec old-command "$@"\n', { mode: 0o755 });
  await install({ target: 'codex', binDir: directory });
  const content = await readFile(join(directory, 'glazed_codex'), 'utf8');
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.match(content, /bin\/glaze_against_the_machine\.js/);
  assert.ok(!content.includes('old-command'));
});

test('launcher migration refuses an unrelated file under the old name', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-launcher-collision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'glazed-codex');
  await writeFile(path, 'unrelated executable');
  for (const remove of [false, true]) {
    await assert.rejects(install({ target: 'codex', binDir: directory, remove }), /unrelated file/);
  }
  assert.equal(await readFile(path, 'utf8'), 'unrelated executable');
  await assert.rejects(stat(join(directory, 'glazed_codex')), { code: 'ENOENT' });
});

test('Claude rename installs its replacement before removing only the old user-scope plugin', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-legacy-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  await writeFile(join(directory, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PLUGIN_LOG, JSON.stringify(args) + '\\n');
console.log(JSON.stringify(args[1] === 'list' ? [
  {id:'prompt-glazer@prompt-glazer-local', scope:'user'},
  {id:'glaze-against-the-machine@glaze-against-the-machine-local', scope:'user'},
  {id:'unrelated@other', scope:'user'}
] : {}));
`, { mode: 0o700 });
  const env = { ...process.env, PATH: directory, FAKE_PLUGIN_LOG: log };
  const binDir = join(directory, 'launchers');
  const output = await install({ target: 'claude', binDir, env });
  assert.match(output, /Keep using claude/);
  await assert.rejects(stat(binDir), { code: 'ENOENT' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls[0].slice(0, 2), ['plugin', 'validate']);
  assert.deepEqual(calls[1].slice(0, 3), ['plugin', 'install', 'glaze-against-the-machine']);
  assert.deepEqual(calls[3].slice(0, 3), ['plugin', 'uninstall', 'prompt-glazer@prompt-glazer-local']);
  assert.equal(calls.length, 4);
  await install({ target: 'claude', binDir, env, remove: true });
  await assert.rejects(stat(join(binDir, 'glazed_claude')), { code: 'ENOENT' });
});

test('Claude installation refuses a mod the native loader cannot activate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-invalid-mod-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  await writeFile(join(directory, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PLUGIN_LOG, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({success:false, error:'hooks/register.js: forbidden API reference'}));
process.exit(1);
`, { mode: 0o700 });
  await assert.rejects(install({ target: 'claude', env: { ...process.env, PATH: directory, FAKE_PLUGIN_LOG: log } }), /Claude plugin validate failed.*forbidden API reference/);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['plugin', 'validate']);
});
