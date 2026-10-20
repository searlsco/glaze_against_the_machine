import test from 'node:test';
import assert from 'node:assert/strict';
import { codexLaunchCwd, createCodexCwd } from '../src/codex-cwd.js';

test('native launch directory honors Codex cd options without treating prompt text as options', () => {
  for (const args of [['-C', 'outside'], ['--cd', 'outside'], ['--cd=outside'], ['-Coutside']]) assert.equal(codexLaunchCwd(args, '/launch'), '/launch/outside');
  assert.equal(codexLaunchCwd(['--', '-C', '/not-a-directory-option'], '/launch'), '/launch');
});

test('native cwd follows resumed threads and persists turn overrides for steering independently', () => {
  const directories = createCodexCwd('/launch');
  directories.observe({ id: 1, result: { cwd: '/outside', thread: { id: 'a' } } });
  directories.observe({ method: 'thread/started', params: { thread: { id: 'b', cwd: '/other' } } });
  assert.equal(directories.forRequest({ method: 'turn/start', params: { threadId: 'a' } }), '/outside');
  assert.equal(directories.forRequest({ method: 'turn/start', params: { threadId: 'a', cwd: '/moved' } }), '/moved');
  assert.equal(directories.forRequest({ method: 'turn/steer', params: { threadId: 'a' } }), '/moved');
  assert.equal(directories.forRequest({ method: 'turn/steer', params: { threadId: 'b' } }), '/other');
});
