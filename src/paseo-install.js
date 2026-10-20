import { access, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { root, nodeExecutable } from './install.js';

const providers = ['claude', 'codex'];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const own = (object, key) => Object.hasOwn(object, key);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function readJson(path, missing) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return missing;
    throw new Error(`Cannot read Paseo installation file: ${path}`);
  }
}

async function atomicWrite(path, content, mode = 0o600) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function findBinary(name, env) {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, name);
    try { await access(path, constants.X_OK); if ((await lstat(path)).isDirectory()) continue; return path; }
    catch { /* Try the next PATH entry. */ }
  }
  return undefined;
}

function validateConfig(config) {
  for (const value of [config, config?.agents, config?.agents?.providers]) {
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error('Paseo config must contain object-shaped agents and providers settings.');
    }
  }
  for (const provider of providers) {
    const value = config.agents?.providers?.[provider];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      throw new Error(`Paseo ${provider} provider settings must be an object.`);
    }
    if (value && own(value, 'command') && (!Array.isArray(value.command) || !value.command.length || value.command.some((part) => typeof part !== 'string' || !part))) {
      throw new Error(`Paseo ${provider} command must be a nonempty array of strings.`);
    }
  }
}

async function assertWrapper(path, expected, allowMissing) {
  try {
    if (!(await lstat(path)).isFile() || await readFile(path, 'utf8') !== expected) {
      throw new Error(`Refusing to replace or remove an unrelated Paseo wrapper: ${path}`);
    }
  } catch (error) { if (!(allowMissing && error.code === 'ENOENT')) throw error; }
}

function validateState(state, statePath) {
  if (state && (state.version !== 1 || !state.providers || typeof state.providers !== 'object' || Array.isArray(state.providers)
    || !Object.keys(state.providers).length || Object.keys(state.providers).some((name) => {
    const entry = state.providers[name];
    return !providers.includes(name) || !entry || typeof entry.hadCommand !== 'boolean' || !Array.isArray(entry.expected) || typeof entry.content !== 'string'
      || (entry.hadCommand && (!Array.isArray(entry.original) || !entry.original.length || entry.original.some((value) => typeof value !== 'string' || !value)));
  }))) {
    throw new Error(`Unrecognized Glaze Against the Machine Paseo installation state: ${statePath}`);
  }
}

export async function installPaseo({ home, remove = false, env = process.env } = {}) {
  if (!home || !isAbsolute(home)) throw new Error('Paseo home must be an absolute directory.');
  const configPath = join(home, 'config.json');
  let statePath = join(home, '.glaze_against_the_machine-paseo.json');
  let directory = join(home, '.glaze_against_the_machine');
  const legacyStatePath = join(home, '.prompt-glazer-paseo.json');
  const legacyDirectory = join(home, '.prompt-glazer');
  const legacyState = await readJson(legacyStatePath, undefined);

  const config = await readJson(configPath, { version: 1 });
  validateConfig(config);
  let state = await readJson(statePath, undefined);
  validateState(state, statePath);
  validateState(legacyState, legacyStatePath);
  if (!state) {
    if (legacyState) {
      state = legacyState;
      statePath = legacyStatePath;
      directory = legacyDirectory;
    }
  }
  if (remove && !state) return 'Glaze Against the Machine is not installed in this Paseo home.';
  if (legacyState) {
    for (const [name, entry] of Object.entries(legacyState.providers)) {
      if (!equal(entry.expected, [join(legacyDirectory, `paseo-${name}`)])) throw new Error('Legacy Paseo installation state contains an unexpected wrapper path.');
      await assertWrapper(entry.expected[0], entry.content, true);
      if (state?.providers[name] && (state.providers[name].hadCommand !== entry.hadCommand
        || !equal(state.providers[name].original, entry.original))) {
        throw new Error('Paseo installation snapshots disagree about the original command.');
      }
      if (state && !state.providers[name]) {
        const current = config.agents?.providers?.[name]?.command;
        if (!equal(current, entry.expected) && !equal(current, entry.hadCommand ? entry.original : undefined)) {
          throw new Error(`Paseo ${name} command changed since installation. Refusing to overwrite it.`);
        }
        // An interrupted migration may leave an omitted provider on its old wrapper.
        if (entry.hadCommand) config.agents.providers[name].command = entry.original;
        else if (config.agents?.providers?.[name]) delete config.agents.providers[name].command;
      }
    }
  }


  if (state) {
    for (const [name, entry] of Object.entries(state.providers)) {
      const current = config.agents?.providers?.[name]?.command;
      if (!equal(current, entry.expected) && !equal(current, entry.hadCommand ? entry.original : undefined)
        && !(legacyState && equal(current, legacyState.providers[name]?.expected))) {
        throw new Error(`Paseo ${name} command changed since installation. Refusing to overwrite it.`);
      }
      if (!equal(entry.expected, [join(directory, `paseo-${name}`)])) throw new Error('Paseo installation state contains an unexpected wrapper path.');
      await assertWrapper(entry.expected[0], entry.content, true);
    }
  }
  if (legacyState && !remove && statePath === legacyStatePath) {
    for (const [name, entry] of Object.entries(legacyState.providers)) {
      if (entry.hadCommand) config.agents.providers[name].command = entry.original;
      else delete config.agents.providers[name].command;
    }
    state = undefined;
    statePath = join(home, '.glaze_against_the_machine-paseo.json');
    directory = join(home, '.glaze_against_the_machine');
  }
  state ??= { version: 1, providers: {} };
  if (!remove) {
    for (const name of providers) {
      if (state.providers[name]) continue;
      const provider = config.agents?.providers?.[name] ?? {};
      if (provider.enabled === false) continue;
      const binary = own(provider, 'command') ? undefined : await findBinary(name, env);
      const command = own(provider, 'command') ? provider.command : binary && [binary];
      if (!command) continue;
      const path = join(directory, `paseo-${name}`);
      const content = `#!/bin/sh\n# Managed by glaze_against_the_machine for Paseo\nexec ${[nodeExecutable, join(root, 'bin', 'glaze_against_the_machine.js'), 'paseo', name, '--', ...command].map(quote).join(' ')} "$@"\n`;
      // A missing state file does not authorize adopting a preexisting wrapper.
      try { await lstat(path); throw new Error(`Refusing to replace an unrelated Paseo wrapper: ${path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      state.providers[name] = { hadCommand: own(provider, 'command'), ...(own(provider, 'command') ? { original: provider.command } : {}), expected: [path], content };
    }
    if (!Object.keys(state.providers).length) {
      throw new Error('Cannot find an enabled Claude or Codex provider on PATH or in Paseo provider commands. Install either agent before configuring Paseo.');
    }
  }

  for (const [name, entry] of Object.entries(state.providers)) {
    config.agents ??= {};
    config.agents.providers ??= {};
    config.agents.providers[name] ??= {};
    if (remove) {
      if (entry.hadCommand) config.agents.providers[name].command = entry.original;
      else delete config.agents.providers[name].command;
    } else config.agents.providers[name].command = entry.expected;
  }
  await mkdir(home, { recursive: true });
  if (!remove) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of Object.values(state.providers)) await atomicWrite(entry.expected[0], entry.content, 0o700);
    // Save the original commands before changing config so an interrupted install is recoverable.
    await atomicWrite(statePath, JSON.stringify(state, null, 2) + '\n');
  }
  await atomicWrite(configPath, JSON.stringify(config, null, 2) + '\n');
  if (remove) {
    for (const entry of Object.values(state.providers)) await rm(entry.expected[0], { force: true });
    await rm(statePath);
  }
  if (legacyState) {
    for (const entry of Object.values(legacyState.providers)) await rm(entry.expected[0], { force: true });
    await rm(legacyStatePath, { force: true });
  }
  return remove
    ? 'Restored Paseo native provider commands. Reload Paseo configuration, then start a new chat to use it. Existing chats keep their current provider process.'
    : `Configured ${Object.keys(state.providers).map((name) => name === 'claude' ? 'Claude' : 'Codex').join(' and ')} prompt preprocessing in Paseo. Reload Paseo configuration, then start a new chat to use it. Existing chats keep their current provider process. Paseo plugins are not enabled or required. Codex hooks still require their normal trust approval. Keep this checkout at ${root}.`;
}
