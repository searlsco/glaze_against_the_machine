import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { viewerRegistryNames } from './inspection-record.js';

// Small append-only lease records avoid shared read/modify/write state between
// tail processes. Rotate by minute so producers read at most two small files.
export async function leaseViewer(directory, session, active) {
  const now = Date.now();
  const registries = viewerRegistryNames(now);
  if (active) {
    const inbox = join(directory, session);
    await mkdir(inbox, { recursive: true, mode: 0o700 });
    await writeFile(join(inbox, 'owner'), String(process.pid), { mode: 0o600 });
  }
  try {
    await appendFile(join(directory, registries.at(-1)), JSON.stringify({ session, expiresAt: active ? now + 15000 : 0 }) + '\n', { mode: 0o600 });
  } catch (error) { if (active || error.code !== 'ENOENT') throw error; }
  if (!active) return;
  for (const name of await readdir(directory)) {
    const bucket = /^viewers-(\d+)\.jsonl$/.exec(name);
    if (bucket && Number(bucket[1]) < Math.floor(now / 60000) - 1) {
      await rm(join(directory, name), { force: true });
    } else if (/^[a-f0-9-]+$/.test(name)) {
      // Expiry and failed lease reads are not proof a viewer died. In particular,
      // another viewer may be renewing just after sleep. Only collect dead owners.
      const path = join(directory, name);
      let owner;
      try { owner = Number(await readFile(join(path, 'owner'), 'utf8')); } catch { continue; }
      if (!Number.isSafeInteger(owner) || owner <= 0) continue;
      try { process.kill(owner, 0); }
      catch (error) { if (error.code === 'ESRCH') await rm(path, { recursive: true, force: true }); }
    }
  }
}
