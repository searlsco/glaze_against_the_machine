import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { installPaseo } from './paseo-install.js';

export async function configurePaseo({ home, remove = false, optional = false } = {}) {
  if (!home) {
    const status = spawnSync('paseo', ['daemon', 'status', '--json'], { encoding: 'utf8', timeout: 30000 });
    if (optional && status.error?.code === 'ENOENT') return;
    if (status.error || status.status !== 0) throw new Error('Could not inspect the local Paseo daemon. Use --home PASEO_HOME to select its configuration.');
    try { home = JSON.parse(status.stdout).home; } catch { /* Validated below. */ }
    if (typeof home !== 'string' || !home) throw new Error('Paseo did not report its home directory.');
  }
  if (remove) {
    let installed = false;
    for (const name of ['.glaze_against_the_machine-paseo.json', '.prompt-glazer-paseo.json']) {
      try { await lstat(join(home, name)); installed = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!installed) return optional ? undefined : 'glaze_against_the_machine is not installed in this Paseo home.';
  }
  const result = await installPaseo({ home, remove });
  const reload = spawnSync('paseo', ['reload', '--home', home, '--json'], { encoding: 'utf8', timeout: 30000 });
  if (reload.error || reload.status !== 0) throw new Error('Paseo configuration was updated, but reload failed. Run paseo reload against that home before launching agents.');
  return result.replace('Reload Paseo configuration', 'Paseo configuration reloaded');
}
