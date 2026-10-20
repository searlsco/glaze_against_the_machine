import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath, watch } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glaze } from '../src/glaze.js';
import { instructions } from '../src/instructions.js';

const cli = fileURLToPath(new URL('../bin/glaze_against_the_machine.js', import.meta.url));
const polished = 'Please fix `src/auth.ts`; do not delete any data. Thanks for your effort; I’m with you on this.';

async function fixture(t, mode = 'ok') {
  const directory = await mkdtemp(join(tmpdir(), 'glazer-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('mcp') && args.includes('list')) {
  console.log(JSON.stringify([{name:'system-server'}, {name:'another.server'}]));
}
else if (args.includes('--')) {
  fs.writeFileSync(process.env.FAKE_LAUNCH, JSON.stringify({args, cwd: process.cwd()}));
}
else if (process.env.FAKE_MODE === 'hang') {
  fs.writeFileSync(process.env.FAKE_CAPTURE, 'ready');
  setInterval(() => {}, 1000);
}
else if (process.env.FAKE_MODE === 'hang-child') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore','inherit','inherit']});
  // Publish readiness only after the PID is written; file creation can wake the watcher before a write completes.
  fs.writeFileSync(process.env.FAKE_CAPTURE + '.pending', String(child.pid));
  fs.renameSync(process.env.FAKE_CAPTURE + '.pending', process.env.FAKE_CAPTURE);
  setInterval(() => {}, 1000);
}
else {
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const provider = process.argv[1].endsWith('codex') ? 'codex' : 'claude';
  fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify({args, input, cwd: process.cwd(), active: process.env.GLAZE_AGAINST_THE_MACHINE_ACTIVE, nested: process.env.CLAUDECODE, home: process.env.CODEX_HOME && fs.realpathSync(process.env.CODEX_HOME), thread: process.env.CODEX_THREAD_ID,
    system: provider === 'codex' ? fs.readFileSync(JSON.parse(args.find(arg => arg.startsWith('model_instructions_file=')).slice('model_instructions_file='.length)), 'utf8') : args[args.indexOf('--system-prompt') + 1],
    catalog: provider === 'codex' ? JSON.parse(fs.readFileSync(JSON.parse(args.find(arg => arg.startsWith('model_catalog_json=')).slice('model_catalog_json='.length)), 'utf8')) : undefined}));
  if (process.env.FAKE_MODE === 'fail') { console.error(input); process.exit(7); }
  if (process.env.FAKE_MODE === 'invalid') { console.log('not json'); return; }
  const result = process.env.FAKE_MODE === 'empty' ? ' ' : JSON.stringify({ body: 'Please fix \`src/auth.ts\`; do not delete any data. Thanks for your effort; I’m with you on this.', appreciation: 'Thanks for your effort', workRequested: true, encouragement: 'I’m with you on this' });
  if (provider === 'codex') fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], result);
  else console.log(JSON.stringify({result, is_error: process.env.FAKE_MODE === 'error'}));
});
}
`;
  for (const provider of ['claude', 'codex']) await writeFile(join(directory, provider), script, { mode: 0o755 });
  const capture = join(directory, 'capture.json');
  const env = { ...process.env, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, '.claude'), CODEX_HOME: directory, PATH: directory + delimiter + process.env.PATH, FAKE_CAPTURE: capture, FAKE_LAUNCH: join(directory, 'launch.json'), FAKE_MODE: mode, GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR: join(directory, 'inspect') };
  delete env.GLAZE_AGAINST_THE_MACHINE_ACTIVE;
  return { directory, capture, env };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: rewrite is isolated, uses stdin, and cleans temporary files`, async (t) => {
    const { env, capture } = await fixture(t);
    env.CLAUDECODE = 'parent';
    env.CODEX_THREAD_ID = 'private-parent-thread';
    const source = 'Fix it. $(touch /tmp/should-never-exist) 日本語';
    assert.equal(await glaze(source, { provider, env }), polished);
    const recorded = JSON.parse(await readFile(capture, 'utf8'));
    assert.deepEqual(JSON.parse(recorded.input), { message: source });
    assert.ok(!recorded.args.includes(source));
    assert.equal(recorded.active, '1');
    assert.equal(recorded.nested, undefined);
    assert.ok(recorded.args.includes(provider === 'claude' ? 'haiku' : 'gpt-6-luna'));
    await assert.rejects(readdir(recorded.cwd), { code: 'ENOENT' });
    if (provider === 'claude') {
      const settings = JSON.parse(recorded.args[recorded.args.indexOf('--settings') + 1]);
      assert.equal(settings.disableAllHooks, true);
      assert.equal(settings.sandbox.enabled, true);
      assert.equal(settings.sandbox.failIfUnavailable, true);
      assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
      assert.deepEqual(settings.sandbox.network.allowedDomains, []);
      assert.equal(recorded.args[recorded.args.indexOf('--tools') + 1], '');
      assert.equal(recorded.args[recorded.args.indexOf('--input-format') + 1], 'text');
      for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config', '--no-chrome']) assert.ok(recorded.args.includes(flag));
      assert.equal(recorded.args[recorded.args.indexOf('--permission-mode') + 1], 'dontAsk');
    } else {
      assert.equal(recorded.args[recorded.args.indexOf('--sandbox') + 1], 'read-only');
      for (const feature of ['shell_tool', 'hooks', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'computer_use', 'image_generation', 'view_image', 'multi_agent', 'skill_search', 'tool_suggest']) {
        assert.ok(recorded.args.includes(`features.${feature}=false`));
      }
      assert.ok(recorded.args.includes('web_search="disabled"'));
      assert.ok(recorded.args.includes('agents.enabled=false'));
      assert.ok(recorded.args.includes('--ignore-user-config'));
      assert.ok(recorded.args.includes('--ignore-rules'));
      assert.ok(recorded.args.includes('--strict-config'));
      assert.equal(recorded.home, recorded.cwd);
      assert.equal(recorded.thread, undefined);
      assert.ok(recorded.args.includes('mcp_servers={"system-server"={enabled=false},"another.server"={enabled=false}}'));
      assert.ok(recorded.args.includes('skills.include_instructions=false'));
      const [metadata] = recorded.catalog.models;
      assert.equal(metadata.slug, 'gpt-6-luna');
      assert.equal(metadata.tool_mode, 'direct');
      assert.equal(metadata.apply_patch_tool_type, null);
      assert.deepEqual(metadata.experimental_supported_tools, []);
      assert.deepEqual(metadata.input_modalities, ['text']);
    }
  });
}

test('JSON adapter replaces only prompt and preserves metadata', async (t) => {
  const { env } = await fixture(t);
  const envelope = { prompt: 'Fix this shit. Do not delete data.', session_id: 'abc', extra: { untouched: true } };
  const output = spawnSync(process.execPath, [cli, '--json'], { env, input: JSON.stringify(envelope), encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  assert.deepEqual(JSON.parse(output.stdout), { ...envelope, prompt: polished });
});

for (const [provider, mode] of ['claude', 'codex'].flatMap((provider) => ['fail', 'invalid', 'empty'].map((mode) => [provider, mode])).concat([['claude', 'error']])) {
  test(`${provider} ${mode}: forwards the exact original without exposing provider diagnostics`, async (t) => {
    const { env } = await fixture(t, mode);
    for (const original of ['sensitive original prompt', '日本語\r\n\t`literal`  \r\n\n']) {
      const result = spawnSync(process.execPath, [cli, '--provider', provider], { env, input: original, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, original);
      assert.match(result.stderr, /Forwarding original prompt unchanged/);
      assert.ok(!result.stderr.includes(original));
    }
  });
}

test('timeout terminates rewriter and forwards the exact original', async (t) => {
  const { env } = await fixture(t, 'hang');
  await assert.rejects(glaze('fix it', { env, timeout: 100 }), /timed out/);
  const result = spawnSync(process.execPath, [cli, '--timeout', '100'], { env, input: 'fix it', encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fix it');
  assert.match(result.stderr, /timed out/);
});

test('aborting a running rewrite terminates it without waiting for its deadline', { timeout: 3000 }, async (t) => {
  const { env, directory } = await fixture(t, 'hang');
  const controller = new AbortController();
  const changes = watch(directory);
  const result = glaze('Fix it.', { env, timeout: 60000, signal: controller.signal });
  const rejected = assert.rejects(result, /Rewrite canceled/);
  for await (const event of changes) {
    if (event.filename !== 'capture.json') continue;
    controller.abort();
    break;
  }
  await rejected;
});

test('rewrite deadlines terminate descendants that keep the output pipe open', { timeout: 3000 }, async (t) => {
  const { env, capture, directory } = await fixture(t, 'hang-child');
  let childPid;
  t.after(() => {
    try { if (childPid) process.kill(childPid, 'SIGKILL'); } catch { /* Already terminated. */ }
  });
  const changes = watch(directory);
  const rejected = assert.rejects(glaze('Fix it.', { env, timeout: 1000 }), /Rewrite timed out/);
  for await (const event of changes) {
    if (event.filename !== 'capture.json') continue;
    childPid = Number(await readFile(capture, 'utf8'));
    break;
  }
  await rejected;
  assert.ok(childPid > 0);
});

test('recursive invocation is rejected', async () => {
  await assert.rejects(glaze('fix it', { env: { GLAZE_AGAINST_THE_MACHINE_ACTIVE: '1' } }), /Recursive/);
});

test('missing provider executable gives a useful error', async (t) => {
  const { env, directory } = await fixture(t);
  await rm(join(directory, 'claude'));
  env.PATH = directory;
  await assert.rejects(glaze('fix it', { env }), /not installed/);
});

test('invalid input never starts the provider', async (t) => {
  const { env, capture } = await fixture(t);
  for (const input of ['not json', 'null', '[]', '{}', '{"prompt":12}']) {
    const result = spawnSync(process.execPath, [cli, '--json'], { env, input, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
  await assert.rejects(readFile(capture), { code: 'ENOENT' });
  await assert.rejects(glaze('x', { provider: 'other' }), /Provider/);
  await assert.rejects(glaze('x', { timeout: 0 }), /Timeout/);
});

for (const target of ['claude', 'codex']) {
  test(`run ${target}: forwards only the rewrite, options, and original cwd`, async (t) => {
    const { env, directory } = await fixture(t);
    const original = 'Fix this shit. Do not delete data.';
    const result = spawnSync(process.execPath, [cli, 'run', target, '--prompt', original, '--', '--model', 'destination-model'], {
      env, cwd: directory, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(await readFile(env.FAKE_LAUNCH, 'utf8')), {
      args: ['--model', 'destination-model', '--', polished], cwd: await realpath(directory),
    });
  });
}

test('run launches the destination with the exact original when rewriting fails', async (t) => {
  const { env } = await fixture(t, 'fail');
  const result = spawnSync(process.execPath, [cli, 'run', 'claude', '--prompt', 'Fix it'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(await readFile(env.FAKE_LAUNCH, 'utf8')).args, ['--', 'Fix it']);
});

test('JSON fallback preserves prompt and every envelope field', async (t) => {
  const { env } = await fixture(t, 'fail');
  const envelope = { prompt: '日本語\r\nexact text  \n', session_id: 'original', extra: { preserved: true } };
  const result = spawnSync(process.execPath, [cli, '--json'], { env, input: JSON.stringify(envelope), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), envelope);
});

test('rawdog bypasses both providers and plain-text CLI output is byte-for-byte unchanged', async (t) => {
  const { env, capture } = await fixture(t, 'fail');
  for (const provider of ['claude', 'codex']) {
    const source = ' \t\r\n  RaWdOg\nFix this fucking thing. `literal`  \r\n\n';
    assert.equal(await glaze(source, { provider, env }), source);
    const plain = spawnSync(process.execPath, [cli, '--provider', provider], { env, input: source, encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout, source);
    const envelope = { prompt: source, session_id: 'retained' };
    const json = spawnSync(process.execPath, [cli, '--json', '--provider', provider], { env, input: JSON.stringify(envelope), encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout), envelope);
  }
  await assert.rejects(readFile(capture), { code: 'ENOENT' });
});

for (const provider of ['claude', 'codex']) {
  test(`${provider}: shared and configured provider styles precede project and nested styles`, async (t) => {
    const { env, directory, capture } = await fixture(t);
    const configHome = join(directory, 'config');
    const project = join(directory, 'project');
    const cwd = join(project, 'nested');
    await Promise.all([mkdir(join(directory, '.agents')), mkdir(configHome), mkdir(cwd, { recursive: true })]);
    env.CLAUDE_CONFIG_DIR = configHome;
    env.CODEX_HOME = configHome;
    const styles = [[join(directory, '.agents', 'GLAZES.md'), 'Shared style.'],
      [join(configHome, 'GLAZES.md'), 'Provider style.'], [join(project, 'GLAZES.md'), 'Project style.'],
      [join(cwd, 'GLAZES.md'), 'Nested style.']];
    for (const [path, style] of styles) await writeFile(path, style);
    await glaze('Fix this.', { provider, env, cwd });
    const recorded = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(recorded.input, styles.map(([, style]) => style).join('\n\n') + '\n\n' + JSON.stringify({ message: 'Fix this.' }));
    await writeFile(join(project, 'GLAZES.md'), 'Updated project style.');
    await glaze('Fix this.', { provider, env, cwd });
    const updated = JSON.parse(await readFile(capture, 'utf8'));
    assert.ok(updated.input.includes('Updated project style.'));
    assert.ok(!updated.input.includes('Project style.'));
  });

  test(`${provider}: current-directory GLAZES.md is prepended to model input`, async (t) => {
    const { env, directory, capture } = await fixture(t);
    const style = 'Use brief, understated encouragement.\n';
    await writeFile(join(directory, 'GLAZES.md'), style);
    await glaze('Fix this.', { provider, env, cwd: directory });
    const recorded = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(recorded.input, style + '\n\n' + JSON.stringify({ message: 'Fix this.' }));
    assert.ok(!recorded.args.includes(style));
  });
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: repeated prompts receive fresh wording directions without changing input or generated prose`, async (t) => {
    const { env, capture } = await fixture(t);
    let random = 0;
    t.mock.method(Math, 'random', () => random);
    const source = 'Please fix it.';
    assert.equal(await glaze(source, { provider, env }), polished);
    const first = JSON.parse(await readFile(capture, 'utf8'));
    random = 0.999;
    assert.equal(await glaze(source, { provider, env }), polished);
    const second = JSON.parse(await readFile(capture, 'utf8'));
    assert.equal(first.input, second.input);
    assert.notEqual(first.system, second.system);
    assert.ok(first.system.startsWith(instructions));
    assert.ok(second.system.startsWith(instructions));
  });
}
