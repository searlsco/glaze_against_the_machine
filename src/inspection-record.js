// Shared with Claude's mod runtime, which has no Node APIs.
let sequence = 0;
export const viewerRegistryNames = (now = Date.now()) => [Math.floor(now / 60000) - 1, Math.floor(now / 60000)].map((minute) => `viewers-${minute}.jsonl`);

export async function beginInspection(directory, record, files) {
  const startedAt = Date.now();
  const rewriteId = `${startedAt}-${++sequence}-${Math.random().toString(16).slice(2)}`;
  let finished = false;
  const emit = async (event, fields = {}) => {
    try { await captureInspection(directory, { ...record, rewriteId, startedAt, event, texts: [], ...fields }, files); }
    catch { /* Inspection must never change prompt delivery. */ }
  };
  if (!record.bypass) await emit('rewrite_started');
  return {
    async complete(texts, failure) {
      if (finished) return;
      finished = true;
      await emit('rewrite_completed', { texts, durationMs: Math.max(0, Date.now() - startedAt), ...(failure && { failure }) });
    },
    async cancel() {
      if (finished) return;
      finished = true;
      await emit('rewrite_canceled', { durationMs: Math.max(0, Date.now() - startedAt) });
    },
  };
}

export async function inspectionViewers(directory, files) {
  // Keep an already-running single-viewer tail working during an upgrade.
  const viewers = new Map();
  for (const filename of ['active.json', ...viewerRegistryNames()]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const path = directory + '/' + filename;
        if (!await files.exists(path)) break;
        const content = await files.read(path);
        for (const line of content.split('\n').filter(Boolean)) {
          let viewer;
          try { viewer = JSON.parse(line); } catch { continue; }
          if (/^[a-f0-9-]+$/.test(viewer?.session) && Number.isFinite(viewer.expiresAt)) viewers.set(viewer.session, viewer);
        }
        break;
      } catch { /* Retry a transient lease read, then keep submission moving. */ }
    }
  }
  return new Map([...viewers].filter(([, viewer]) => viewer.expiresAt >= Date.now()));
}

export async function captureInspection(directory, record, files) {
  if (!directory) return;
  const viewers = await inspectionViewers(directory, files);
  if (!viewers.size) return;
  const name = Date.now() + '-' + String(++sequence).padStart(12, '0') + '-' + Math.random().toString(16).slice(2);
  let content;
  try { content = JSON.stringify({ time: new Date().toISOString(), ...record }); }
  catch { return; }
  await Promise.all([...viewers.keys()].map(async (session) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await files.write(directory + '/' + session + '/' + name + '.json', content); return; }
      catch { /* One broken or closing viewer must not block another or delivery. */ }
    }
  }));
}
