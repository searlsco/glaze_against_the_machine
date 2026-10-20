import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installPaseo } from '../src/paseo-install.js';

async function fixture(t, config) {
  const home = await mkdtemp(join(tmpdir(), 'glazer-paseo-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'bin'));
  for (const name of ['claude', 'codex']) await writeFile(join(home, 'bin', name), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  return { home, env: { PATH: join(home, 'bin') } };
}
async function configAt(home) { return JSON.parse(await readFile(join(home, 'config.json'), 'utf8')); }

test('Paseo install preserves settings and custom prefixes through repeated install and uninstall', async (t) => {
  const original = { version: 1, pluginsEnabled: false, secret: 'local-only', agents: { providers: {
    claude: { command: ['/custom/claude', '--setting', "quoted 'value'"], options: { permissionMode: 'default' } },
    codex: { label: 'Existing Codex' },
    unrelated: { command: ['/custom/other'] },
  } } };
  const options = await fixture(t, original);
  const output = await installPaseo(options);
  assert.match(output, /plugins are not enabled or required/);
  assert.match(output, /start a new chat/);
  const installed = await configAt(options.home);
  assert.equal(installed.pluginsEnabled, false);
  assert.equal(installed.secret, original.secret);
  assert.deepEqual(installed.agents.providers.unrelated, original.agents.providers.unrelated);
  for (const provider of ['claude', 'codex']) {
    const [path] = installed.agents.providers[provider].command;
    assert.equal(installed.agents.providers[provider].command.length, 1);
    assert.ok((await stat(path)).mode & 0o111);
    const script = await readFile(path, 'utf8');
    assert.match(script, /'paseo'/);
    assert.match(script, /"\$@"/);
    if (provider === 'claude') assert.ok(script.includes("'/custom/claude' '--setting' 'quoted '\\''value'\\'''"));
    else assert.ok(script.includes(join(options.home, 'bin', 'codex')));
  }
  const state = await readFile(join(options.home, '.glaze_against_the_machine-paseo.json'), 'utf8');
  await installPaseo(options);
  assert.equal(await readFile(join(options.home, '.glaze_against_the_machine-paseo.json'), 'utf8'), state);
  installed.agents.providers.codex.newSetting = true;
  await writeFile(join(options.home, 'config.json'), JSON.stringify(installed));
  await installPaseo({ ...options, remove: true });
  original.agents.providers.codex.newSetting = true;
  assert.deepEqual(await configAt(options.home), original);
  await installPaseo({ ...options, remove: true });
  await assert.rejects(stat(join(options.home, '.glaze_against_the_machine-paseo.json')), { code: 'ENOENT' });
  assert.equal((await stat(join(options.home, 'config.json'))).mode & 0o777, 0o600);
});

test('Paseo install refuses provider command drift without changing config or its snapshot', async (t) => {
  const options = await fixture(t, { version: 1 });
  await installPaseo(options);
  const config = await configAt(options.home);
  config.agents.providers.codex.command = ['/different/codex'];
  const content = JSON.stringify(config);
  await writeFile(join(options.home, 'config.json'), content);
  const state = await readFile(join(options.home, '.glaze_against_the_machine-paseo.json'), 'utf8');
  for (const remove of [false, true]) await assert.rejects(installPaseo({ ...options, remove }), /command changed/);
  assert.equal(await readFile(join(options.home, 'config.json'), 'utf8'), content);
  assert.equal(await readFile(join(options.home, '.glaze_against_the_machine-paseo.json'), 'utf8'), state);
});

test('Paseo install and uninstall refuse changed wrappers', async (t) => {
  const options = await fixture(t, { version: 1 });
  await installPaseo(options);
  const config = await configAt(options.home);
  const path = config.agents.providers.claude.command[0];
  await writeFile(path, '#!/bin/sh\n# unrelated\n');
  for (const remove of [false, true]) await assert.rejects(installPaseo({ ...options, remove }), /unrelated Paseo wrapper/);
  assert.deepEqual(await configAt(options.home), config);
  assert.equal(await readFile(path, 'utf8'), '#!/bin/sh\n# unrelated\n');
});

test('Paseo installation recovers when original commands remain after snapshot was saved', async (t) => {
  const original = { version: 1, agents: { providers: { claude: { command: ['/custom/claude'] } } } };
  const options = await fixture(t, original);
  await installPaseo(options);
  await writeFile(join(options.home, 'config.json'), JSON.stringify(original));
  await installPaseo(options);
  assert.match((await configAt(options.home)).agents.providers.claude.command[0], /paseo-claude$/);
  await installPaseo({ ...options, remove: true });
  const restored = await configAt(options.home);
  assert.deepEqual(restored.agents.providers.claude, original.agents.providers.claude);
  assert.equal(Object.hasOwn(restored.agents.providers.codex, 'command'), false);
});

for (const name of ['claude', 'codex']) {
  test(`Paseo installs ${name} alone, recovers partial config, and uninstalls without native binaries`, async (t) => {
    const options = await fixture(t, { version: 1 });
    const other = name === 'claude' ? 'codex' : 'claude';
    await rm(join(options.home, 'bin', other));
    const output = await installPaseo(options);
    assert.ok(output.includes(`Configured ${name === 'claude' ? 'Claude' : 'Codex'} prompt preprocessing`));
    const installed = await configAt(options.home);
    assert.deepEqual(Object.keys(installed.agents.providers), [name]);
    const statePath = join(options.home, '.glaze_against_the_machine-paseo.json');
    const snapshot = await readFile(statePath, 'utf8');
    await rm(join(options.home, 'bin', name));
    await writeFile(join(options.home, 'config.json'), JSON.stringify({ version: 1 }));
    await installPaseo(options);
    assert.deepEqual(await configAt(options.home), installed);
    assert.equal(await readFile(statePath, 'utf8'), snapshot);
    await installPaseo({ ...options, remove: true });
    assert.equal(Object.hasOwn((await configAt(options.home)).agents.providers[name], 'command'), false);
  });
}

test('Paseo adds a newly available provider without changing its first snapshot', async (t) => {
  const options = await fixture(t, { version: 1 });
  await rm(join(options.home, 'bin', 'codex'));
  await installPaseo(options);
  const statePath = join(options.home, '.glaze_against_the_machine-paseo.json');
  const original = JSON.parse(await readFile(statePath, 'utf8')).providers.claude;
  await writeFile(join(options.home, 'bin', 'codex'), '#!/bin/sh\n', { mode: 0o755 });
  await installPaseo(options);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.deepEqual(state.providers.claude, original);
  assert.deepEqual(Object.keys(state.providers), ['claude', 'codex']);
  await installPaseo({ ...options, remove: true });
  for (const provider of Object.values((await configAt(options.home)).agents.providers)) assert.equal(Object.hasOwn(provider, 'command'), false);
});

test('Paseo accepts configured custom commands without PATH providers and skips disabled providers', async (t) => {
  const original = { version: 1, agents: { providers: {
    claude: { command: ['/custom/claude', '--keep'] }, codex: { enabled: false, command: ['/custom/codex'] },
    unrelated: { command: ['/custom/other'] },
  } } };
  const options = await fixture(t, original);
  options.env.PATH = '';
  await installPaseo(options);
  const installed = await configAt(options.home);
  assert.deepEqual(installed.agents.providers.codex, original.agents.providers.codex);
  assert.deepEqual(installed.agents.providers.unrelated, original.agents.providers.unrelated);
  assert.ok((await readFile(installed.agents.providers.claude.command[0], 'utf8')).includes("'/custom/claude' '--keep'"));
  await installPaseo({ ...options, remove: true });
  assert.deepEqual(await configAt(options.home), original);
});

test('Paseo with no available supported providers fails before writing configuration or snapshots', async (t) => {
  const options = await fixture(t, { version: 1, agents: { providers: { unrelated: { command: ['/custom/other'] } } } });
  options.env.PATH = '';
  const original = await readFile(join(options.home, 'config.json'), 'utf8');
  await assert.rejects(installPaseo(options), /Install either agent/);
  assert.equal(await readFile(join(options.home, 'config.json'), 'utf8'), original);
  for (const name of ['.glaze_against_the_machine', '.glaze_against_the_machine-paseo.json']) {
    await assert.rejects(stat(join(options.home, name)), { code: 'ENOENT' });
  }
});

async function legacyInstall(t) {
  const original = { version: 1, agents: { providers: { claude: { command: ['/custom/claude', '--keep'] }, codex: { label: 'Keep me' } } } };
  const options = await fixture(t, original);
  await installPaseo(options);
  const statePath = join(options.home, '.glaze_against_the_machine-paseo.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const config = await configAt(options.home);
  await mkdir(join(options.home, '.prompt-glazer'));
  for (const [name, entry] of Object.entries(state.providers)) {
    await rm(entry.expected[0]);
    entry.expected = [join(options.home, '.prompt-glazer', 'paseo-' + name)];
    entry.content = entry.content.replaceAll('glaze_against_the_machine', 'prompt-glazer');
    await writeFile(entry.expected[0], entry.content, { mode: 0o700 });
    config.agents.providers[name].command = entry.expected;
  }
  await rm(statePath);
  await writeFile(join(options.home, '.prompt-glazer-paseo.json'), JSON.stringify(state));
  await writeFile(join(options.home, 'config.json'), JSON.stringify(config));
  return { options, original, state };
}

test('renamed Paseo installation migrates owned legacy wrappers without nesting them', async (t) => {
  const { options, original, state } = await legacyInstall(t);
  await installPaseo(options);
  const config = await configAt(options.home);
  for (const name of ['claude', 'codex']) {
    assert.ok(config.agents.providers[name].command[0].includes('.glaze_against_the_machine'));
    const content = await readFile(config.agents.providers[name].command[0], 'utf8');
    assert.ok(!content.includes('.prompt-glazer'));
    await assert.rejects(stat(state.providers[name].expected[0]), { code: 'ENOENT' });
  }
  await installPaseo({ ...options, remove: true });
  assert.deepEqual(await configAt(options.home), original);
});

test('legacy uninstall restores commands and migration refuses modified legacy wrappers', async (t) => {
  const { options, original } = await legacyInstall(t);
  await installPaseo({ ...options, remove: true });
  assert.deepEqual(await configAt(options.home), original);
  const second = await legacyInstall(t);
  await writeFile(second.state.providers.codex.expected[0], 'modified wrapper');
  await assert.rejects(installPaseo(second.options), /unrelated Paseo wrapper/);
  assert.equal(await readFile(second.state.providers.codex.expected[0], 'utf8'), 'modified wrapper');
});

test('partial legacy migration restores an omitted provider before deleting its old wrapper', async (t) => {
  const { options, original, state } = await legacyInstall(t);
  const legacyConfig = await configAt(options.home);
  await rm(join(options.home, 'bin', 'codex'));
  await installPaseo(options);
  const installedState = JSON.parse(await readFile(join(options.home, '.glaze_against_the_machine-paseo.json'), 'utf8'));
  assert.deepEqual(Object.keys(installedState.providers), ['claude']);
  // Simulate interruption after the new snapshot but before the config switch.
  await writeFile(join(options.home, '.prompt-glazer-paseo.json'), JSON.stringify(state));
  for (const entry of Object.values(state.providers)) await writeFile(entry.expected[0], entry.content);
  const drifted = structuredClone(legacyConfig);
  drifted.agents.providers.codex.command = ['/unrelated/codex'];
  await writeFile(join(options.home, 'config.json'), JSON.stringify(drifted));
  await assert.rejects(installPaseo(options), /codex command changed/);
  assert.deepEqual(await configAt(options.home), drifted);
  await writeFile(join(options.home, 'config.json'), JSON.stringify(legacyConfig));
  await installPaseo(options);
  assert.deepEqual((await configAt(options.home)).agents.providers.codex, original.agents.providers.codex);
  for (const entry of Object.values(state.providers)) await assert.rejects(stat(entry.expected[0]), { code: 'ENOENT' });
  await installPaseo({ ...options, remove: true });
  assert.deepEqual(await configAt(options.home), original);
});

for (const checkpoint of ['before config switch', 'before legacy cleanup']) {
  test(`renamed Paseo installation recovers interruption ${checkpoint}`, async (t) => {
    const { options, original, state } = await legacyInstall(t);
    await installPaseo(options);
    // Recreate the exact owned legacy files that were still present at interruption.
    await writeFile(join(options.home, '.prompt-glazer-paseo.json'), JSON.stringify(state));
    for (const entry of Object.values(state.providers)) await writeFile(entry.expected[0], entry.content);
    if (checkpoint === 'before config switch') {
      const config = await configAt(options.home);
      for (const name of ['claude', 'codex']) config.agents.providers[name].command = state.providers[name].expected;
      await writeFile(join(options.home, 'config.json'), JSON.stringify(config));
    }
    await installPaseo(options);
    await assert.rejects(stat(join(options.home, '.prompt-glazer-paseo.json')), { code: 'ENOENT' });
    for (const entry of Object.values(state.providers)) await assert.rejects(stat(entry.expected[0]), { code: 'ENOENT' });
    await installPaseo({ ...options, remove: true });
    assert.deepEqual(await configAt(options.home), original);
  });
}
