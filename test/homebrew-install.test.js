import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('installed terminal and Paseo launchers survive removal of their original keg', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glaze-homebrew-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stableRoot = join(directory, 'opt', 'glaze');
  const stableNode = join(directory, 'opt', 'node');
  await mkdir(join(directory, 'opt'));
  const keg = async (version) => {
    const path = join(directory, 'Cellar', version);
    await mkdir(join(path, 'bin'), { recursive: true });
    await writeFile(join(path, 'bin', 'glaze_against_the_machine.js'), `console.log(${JSON.stringify(version)}, ...process.argv.slice(2));\n`);
    await writeFile(join(path, 'node'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    return path;
  };
  const first = await keg('first');
  const second = await keg('second');
  await symlink(first, stableRoot);
  await symlink(join(first, 'node'), stableNode);
  const home = join(directory, 'paseo');
  await mkdir(home);
  await writeFile(join(home, 'config.json'), JSON.stringify({ agents: { providers: {
    codex: { command: ['/native/codex'] }, claude: { enabled: false },
  } } }));
  const installUrl = new URL('../src/install.js', import.meta.url).href;
  const paseoUrl = new URL('../src/paseo-install.js', import.meta.url).href;
  const setup = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { install } from ${JSON.stringify(installUrl)};
    import { installPaseo } from ${JSON.stringify(paseoUrl)};
    await install({ target: 'codex', binDir: ${JSON.stringify(join(directory, 'bin'))} });
    await installPaseo({ home: ${JSON.stringify(home)} });
  `], { encoding: 'utf8', env: { ...process.env,
    GLAZE_AGAINST_THE_MACHINE_ROOT: stableRoot, GLAZE_AGAINST_THE_MACHINE_NODE: stableNode,
  } });
  assert.equal(setup.status, 0, setup.stderr);
  await rm(stableRoot);
  await rm(stableNode);
  await symlink(second, stableRoot);
  await symlink(join(second, 'node'), stableNode);
  await rm(first, { recursive: true });
  // Saved launchers must work without the installer's environment as well.
  const env = { ...process.env };
  delete env.GLAZE_AGAINST_THE_MACHINE_ROOT;
  delete env.GLAZE_AGAINST_THE_MACHINE_NODE;
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
  for (const [path, expected] of [
    [join(directory, 'bin', 'glazed_codex'), 'second codex --version\n'],
    [config.agents.providers.codex.command[0], 'second paseo codex -- /native/codex --version\n'],
  ]) {
    const result = spawnSync(path, ['--version'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});
