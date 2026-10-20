import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const marker = '# Managed by glaze_against_the_machine';
const legacyMarker = '# Managed by prompt-glazer';
const legacyPluginId = 'prompt-glazer@prompt-glazer-local';
const pluginId = 'glaze-against-the-machine@glaze-against-the-machine-local';
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

function claude(args, env, optional = false) {
  const result = spawnSync('claude', ['plugin', ...args], { env, encoding: 'utf8', timeout: 60000 });
  if (optional && result.error?.code === 'ENOENT') return '[]';
  if (result.error || result.status !== 0) throw new Error(`Claude plugin ${args[0]} failed. ${result.error?.message ?? (result.stderr.trim() || result.stdout.trim())}`);
  return result.stdout;
}

export async function install({ target, binDir = join(homedir(), '.local', 'bin'), remove = false, env = process.env } = {}) {
  target ??= remove ? 'all' : undefined;
  if (!['claude', 'codex', 'all'].includes(target)) throw new Error('Choose an explicit install target: claude, codex, or all.');
  const targets = target === 'all' ? ['claude', 'codex'] : [target];
  const launchers = targets.filter((name) => remove || name === 'codex');
  const paths = launchers.map((name) => join(resolve(binDir), `glazed_${name}`));
  const legacyPaths = launchers.map((name) => join(resolve(binDir), `glazed-${name}`));
  for (const path of [...paths, ...legacyPaths]) {
    try {
      const stat = await lstat(path);
      const content = stat.isFile() ? await readFile(path, 'utf8') : '';
      if (!stat.isFile() || ![marker, legacyMarker].some((value) => content.includes(value))) {
        throw new Error(`Refusing to ${remove ? 'remove' : 'replace'} an unrelated file: ${path}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (targets.includes('claude')) {
    if (!remove) {
      claude(['validate', root, '--json'], env);
      claude(['install', 'glaze-against-the-machine', '--marketplace', root, '--scope', 'user', '--json'], env);
    }
    const plugins = JSON.parse(claude(['list', '--json'], env, remove));
    for (const id of remove ? [pluginId, legacyPluginId] : [legacyPluginId]) {
      if (plugins.some((item) => item.id === id && item.scope === 'user')) claude(['uninstall', id, '--scope', 'user', '--json'], env);
    }
  }
  if (!remove && targets.includes('codex')) await mkdir(resolve(binDir), { recursive: true });
  for (let i = 0; i < launchers.length; i++) {
    if (remove) {
      try { await unlink(paths[i]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    } else {
      const content = `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(join(root, 'bin', 'glaze_against_the_machine.js'))} ${launchers[i]} "$@"\n`;
      await writeFile(paths[i], content, { mode: 0o755 });
    }
    try { await unlink(legacyPaths[i]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const messages = remove ? [`Removed terminal launchers: ${paths.join(', ')}`] : [];
  if (!remove && targets.includes('codex')) messages.push(`Installed: ${join(resolve(binDir), 'glazed_codex')}`);
  if (!remove && targets.includes('claude')) messages.push('Claude mod installed. Keep using claude. It replaces human prompts before legacy UserPromptSubmit hooks. Reload plugins in existing sessions or start a new session. Other mods and managed policy retain their host-defined ordering.');
  if (!remove && targets.includes('codex')) messages.push('Use glazed_codex to preprocess every prompt before Codex app-server and its native hooks. Direct codex launches are unchanged. Codex hooks still require review and trust in /hooks before they can run. This installer does not grant or bypass trust.');
  if (!remove) messages.push(`Keep this installation at ${root}.`);
  if (!remove && targets.includes('codex')) messages.push(`Ensure ${resolve(binDir)} is on PATH.`);
  return messages.join('\n');
}
