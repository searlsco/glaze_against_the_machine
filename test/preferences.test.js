import test from 'node:test';
import assert from 'node:assert/strict';
import { readGlazes, rewriteInput } from '../src/preferences.js';
import { register } from '../hooks/register.js';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectionFiles } from '../src/inspection.js';

test('unchanged styles reuse contents while edits, removals, and failures invalidate them', async () => {
  const path = '/cache-behavior/GLAZES.md';
  let present = false;
  let style = 'First style.';
  let info = { kind: 'file', size: 12, mtimeMs: 1 };
  let reads = 0;
  let failure = false;
  const files = {
    exists: async (candidate) => candidate === path && present,
    stat: async () => { if (failure) throw new Error('private'); return info; },
    read: async () => { reads++; return style; },
  };
  const load = () => readGlazes('/cache-behavior', files);
  assert.equal(await load(), '');
  present = true;
  assert.equal(await load(), style);
  assert.equal(await load(), style);
  assert.equal(reads, 1);
  style = 'Other style.';
  info = { ...info, mtimeMs: 2 };
  assert.equal(await load(), style);
  assert.equal(reads, 2);
  present = false;
  assert.equal(await load(), '');
  present = true;
  assert.equal(await load(), style);
  assert.equal(reads, 3);
  failure = true;
  await assert.rejects(load(), { message: 'Could not read GLAZES.md.' });
  failure = false;
  assert.equal(await load(), style);
  assert.equal(reads, 4);
  info = { ...info, kind: 'dir' };
  await assert.rejects(load(), { message: 'Could not read GLAZES.md.' });
  info = { ...info, kind: 'file' };
  assert.equal(await load(), style);
  assert.equal(reads, 5);
  style = '';
  info = { ...info, size: 0, mtimeMs: 3 };
  assert.equal(await load(), '');
  assert.equal(await load(), '');
  assert.equal(reads, 6);
});

test('resolved symlink changes invalidate cached styles even with matching size and mtime', async () => {
  let target = '/styles/first.md';
  let reads = 0;
  const files = {
    exists: async (path) => path === '/cache-symlink/GLAZES.md',
    stat: async () => ({ kind: 'file', isLink: true, realPath: target, size: 10, mtimeMs: 1 }),
    read: async () => { reads++; return target; },
  };
  assert.equal(await readGlazes('/cache-symlink', files), target);
  assert.equal(await readGlazes('/cache-symlink', files), target);
  assert.equal(reads, 1);
  target = '/styles/other.md';
  assert.equal(await readGlazes('/cache-symlink', files), target);
  assert.equal(reads, 2);
});

test('Node caches actual file reads and detects replacement files with preserved mtimes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glaze-cache-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'GLAZES.md');
  await writeFile(path, 'First');
  const { stat, utimes, rename } = await import('node:fs/promises');
  const original = await stat(path);
  let reads = 0;
  const files = { ...inspectionFiles, readStyle: async (path) => { reads++; return inspectionFiles.readStyle(path); } };
  assert.equal(await readGlazes(directory, files), 'First');
  assert.equal(await readGlazes(directory, files), 'First');
  assert.equal(reads, 1);
  const replacement = join(directory, 'replacement');
  await writeFile(replacement, 'Other');
  await utimes(replacement, original.atime, original.mtime);
  await rename(replacement, path);
  assert.equal(await readGlazes(directory, files), 'Other');
  assert.equal(reads, 2);
});

test('GLAZES.md lookup searches ancestors and preserves file contents at the front', async () => {
  const style = '  Keep the encouragement understated.\nUse nautical imagery.\n';
  const visited = [];
  const files = { exists: async (path) => { visited.push(path); return path === '/agents/outside/GLAZES.md'; },
    stat: async (path, options) => { assert.equal(path, '/agents/outside/GLAZES.md'); assert.deepEqual(options, { resolve: true }); return { kind: 'file', isLink: false }; }, read: async () => style };
  const found = await readGlazes('/agents/outside/', files);
  assert.deepEqual(visited, ['/GLAZES.md', '/agents/GLAZES.md', '/agents/outside/GLAZES.md']);
  assert.equal(rewriteInput('Fix it.', ['literal'], found), style + '\n\n' + JSON.stringify({ message: 'Fix it.', requiredTokens: ['literal'] }));
  assert.equal(await readGlazes('/agents/outside', { exists: async () => false }), '');
  await assert.rejects(readGlazes('/agents/outside', { ...files, read: async () => { throw new Error('private file contents'); } }), /Could not read GLAZES.md/);
});

test('user defaults, provider defaults, and ancestors merge from outside in without duplicate reads', async () => {
  const paths = ['/home/user/.agents/GLAZES.md', '/home/user/.claude/GLAZES.md', '/GLAZES.md', '/project/GLAZES.md', '/project/sub/GLAZES.md'];
  const visited = [];
  const files = { exists: async (path) => { visited.push(path); return true; },
    stat: async () => ({ kind: 'file', isLink: false }), read: async (path) => path };
  assert.equal(await readGlazes('/project/sub', files, { provider: 'claude', home: '/home/user' }), paths.join('\n\n'));
  assert.deepEqual(visited, paths);
  visited.length = 0;
  assert.equal(await readGlazes('/home/user/.agents', files, { provider: 'codex', home: '/home/user', configHome: '/home/user/.agents/./' }),
    ['/GLAZES.md', '/home/GLAZES.md', '/home/user/GLAZES.md', '/home/user/.agents/GLAZES.md'].join('\n\n'));
  assert.equal(visited.length, new Set(visited).size);
});

test('provider config-home overrides select only that provider and missing files are ignored', async () => {
  const visited = [];
  const files = { exists: async (path) => { visited.push(path); return false; } };
  assert.equal(await readGlazes('/project/sub', files, { provider: 'codex', home: '/home/user', configHome: '/custom/codex' }), '');
  assert.deepEqual(visited, ['/home/user/.agents/GLAZES.md', '/custom/codex/GLAZES.md', '/GLAZES.md', '/project/GLAZES.md', '/project/sub/GLAZES.md']);
  visited.length = 0;
  await readGlazes('/', files, { provider: 'codex', home: '/home/user' });
  assert.deepEqual(visited, ['/home/user/.agents/GLAZES.md', '/home/user/.codex/GLAZES.md', '/GLAZES.md']);
});

test('Claude prepends all style scopes on every prompt and rawdog skips lookup', async () => {
  let hook;
  register((event, handler) => { hook = handler; return { catch() {} }; });
  let style = 'Be concise.';
  const styles = new Map([['/home/.agents/GLAZES.md', 'Shared style.'], ['/custom/GLAZES.md', 'Claude style.'], ['/GLAZES.md', 'Root style.']]);
  const $ = { env: { get: async (name) => ({ HOME: '/home', CLAUDE_CONFIG_DIR: '/custom' })[name] }, session: { cwd: async () => '/outside' },
    fs: { exists: async (path) => path === '/outside/GLAZES.md' || styles.has(path), stat: async () => ({ kind: 'file', isLink: false }), read: async (path) => styles.get(path) || style },
    model: { complete: async (request) => {
      assert.ok(request.prompt.startsWith('Shared style.\n\nClaude style.\n\nRoot style.\n\n' + style + '\n\n'));
      return JSON.stringify({ body: 'Please fix it. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' });
    } },
  };
  for (const nextStyle of ['Be concise.', 'Use a warmer tone.']) {
    style = nextStyle;
    const result = await hook($, { text: 'Fix this shit.', origin: { kind: 'composer' } }, async (event) => event);
    assert.ok(!result.drop);
    assert.match(result.text, /Please fix it/);
  }
  $.fs.exists = () => assert.fail('rawdog must skip preferences');
  const original = { text: ' \t\nrawdog\nexact input', origin: { kind: 'composer' } };
  assert.equal(await hook($, original, async (event) => event), original);
});

test('unreadable ancestor guidance fails safely without exposing its contents', async () => {
  await assert.rejects(readGlazes('/project/sub', { exists: async (path) => path === '/project/GLAZES.md',
    stat: async () => { throw new Error('PRIVATE_SENTINEL'); } }), { message: 'Could not read GLAZES.md.' });
});

test('style guidance rejects nonregular targets without reading their contents', async () => {
  for (const info of [{ kind: 'dir', isLink: false }, { kind: 'other', isLink: false }]) {
    await assert.rejects(readGlazes('/session', { exists: async () => true, stat: async () => info,
      read: () => assert.fail('must not read unsafe style guidance') }), /Could not read GLAZES.md/);
  }
});

test('symlinked project guidance follows and re-reads its shared dotfile target', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glaze-style-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project');
  const dotfiles = join(directory, 'project_dotfiles');
  await mkdir(project);
  await mkdir(dotfiles);
  const target = join(dotfiles, 'GLAZES.md');
  await writeFile(target, 'Keep it dry.');
  await symlink('../project_dotfiles/GLAZES.md', join(project, 'GLAZES.md'));
  assert.equal(await readGlazes(project, inspectionFiles), 'Keep it dry.');
  await writeFile(target, 'Make it extravagant.');
  assert.equal(await readGlazes(project, inspectionFiles), 'Make it extravagant.');
  await rm(target);
  await mkdir(target);
  await assert.rejects(readGlazes(project, inspectionFiles), /Could not read GLAZES.md/);
  await assert.rejects(inspectionFiles.readStyle(join(project, 'GLAZES.md')));
});

test('Claude follows symlinked style files through its filesystem API', async () => {
  let hook;
  register((event, handler) => { hook = handler; return { catch() {} }; });
  const $ = { env: { get: async () => undefined }, session: { cwd: async () => '/project' },
    fs: {
      exists: async (path) => path === '/project/GLAZES.md',
      stat: async (_path, options) => {
        assert.deepEqual(options, { resolve: true });
        return { kind: 'file', isLink: true };
      },
      read: async () => 'Shared dotfile style.',
    },
    model: { complete: async ({ prompt }) => {
      assert.ok(prompt.startsWith('Shared dotfile style.\n\n'));
      return JSON.stringify({ body: 'Fix it. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' });
    } },
  };
  const result = await hook($, { text: 'Fix it.', origin: { kind: 'composer' } }, async (event) => event);
  assert.equal(result.text, 'Fix it. Thanks for your effort; I’m with you on this.');
});
