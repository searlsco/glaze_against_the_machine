import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { install } from '../src/install.js';
import { installPaseo } from '../src/paseo-install.js';

async function fixture(t, { paseo = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'glaze-uninstall-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin');
  const launchers = join(directory, 'launchers');
  const home = join(directory, 'paseo-home');
  const log = join(directory, 'calls.jsonl');
  await mkdir(bin);
  await mkdir(home);
  await writeFile(log, '');
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['claude', ...args]) + '\\n');
console.log(JSON.stringify(args[1] === 'list' ? [
  { id: 'glaze-against-the-machine@glaze-against-the-machine-local', scope: 'user' },
] : {}));
`, { mode: 0o700 });
  await writeFile(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o700 });
  if (paseo) await writeFile(join(bin, 'paseo'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(['paseo', ...args]) + '\\n');
console.log(JSON.stringify({ home: process.env.FAKE_PASEO_HOME }));
`, { mode: 0o700 });
  const env = { ...process.env, PATH: bin, HOME: directory, FAKE_LOG: log, FAKE_PASEO_HOME: home };
  const original = { version: 1, unrelated: 'keep', agents: { providers: {
    claude: { command: ['/native/claude', '--keep'] }, codex: { label: 'Codex' },
  } } };
  await writeFile(join(home, 'config.json'), JSON.stringify(original));
  await install({ target: 'codex', binDir: launchers, env });
  if (paseo) await installPaseo({ home, env });
  const cli = new URL('../bin/glaze_against_the_machine.js', import.meta.url).pathname;
  return { home, launchers, original, log, bin,
    run: (...args) => spawnSync(process.execPath, [cli, 'uninstall', ...args, '--bin-dir', launchers], { env, encoding: 'utf8' }),
  };
}

test('bare uninstall removes terminal and Paseo integrations and reloads only once', async (t) => {
  const f = await fixture(t);
  const installed = JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8'));
  const wrapper = installed.agents.providers.claude.command[0];
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8')), f.original);
  for (const path of [wrapper, join(f.home, '.glaze_against_the_machine-paseo.json'), join(f.launchers, 'glazed_codex')]) {
    await assert.rejects(stat(path), { code: 'ENOENT' });
  }
  assert.equal(f.run().status, 0);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(([command, action]) => command === 'paseo' && action === 'reload').length, 1);
  assert.ok(calls.some(([command, , action]) => command === 'claude' && action === 'uninstall'));
});

test('bare uninstall works when Paseo is not installed', async (t) => {
  const f = await fixture(t, { paseo: false });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(join(f.launchers, 'glazed_codex')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8')), f.original);
});

test('Codex-only installations can uninstall without Claude or Paseo executables', async (t) => {
  const f = await fixture(t, { paseo: false });
  await rm(join(f.bin, 'claude'));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(join(f.launchers, 'glazed_codex')), { code: 'ENOENT' });
});

test('an explicit terminal uninstall leaves Paseo installed', async (t) => {
  const f = await fixture(t);
  const result = f.run('codex');
  assert.equal(result.status, 0, result.stderr);
  await stat(join(f.home, '.glaze_against_the_machine-paseo.json'));
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('uninstall all accepts an explicit Paseo home', async (t) => {
  const f = await fixture(t);
  const result = f.run('all', '--home', f.home);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8')), f.original);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(!calls.some(([command, action]) => command === 'paseo' && action === 'daemon'));
});

test('bare uninstall refuses changed Paseo wrappers before removing terminal launchers', async (t) => {
  const f = await fixture(t);
  const config = JSON.parse(await readFile(join(f.home, 'config.json'), 'utf8'));
  const wrapper = config.agents.providers.claude.command[0];
  await writeFile(wrapper, 'unrelated executable');
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrelated Paseo wrapper/);
  assert.equal(await readFile(wrapper, 'utf8'), 'unrelated executable');
  await stat(join(f.launchers, 'glazed_codex'));
});
