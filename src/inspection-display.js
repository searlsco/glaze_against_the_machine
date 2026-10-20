import { formatDuration, formatInspection, formatProgress } from './inspection-format.js';

export function createInspectionDisplay({ output, json, resolveOwner, now = Date.now }) {
  const active = new Map();
  const owners = new Map();
  let status = '';
  let stopped = false;
  const clearStatus = () => {
    if (status) output.write('\r\x1b[2K');
    status = '';
  };
  const ownerFor = (record) => {
    const fallback = record.owner || (record.agentId ? `Paseo ${record.agentId}` : `${record.provider} terminal`);
    if (!record.agentId) return fallback;
    if (!owners.has(record.agentId)) {
      owners.set(record.agentId, fallback);
      // Labels may arrive later. A slow or unavailable daemon must never hold
      // up the original prompt, progress updates, or another session's output.
      (async () => {
        try {
          const owner = await resolveOwner(record);
          if (!stopped && typeof owner === 'string' && owner) owners.set(record.agentId, owner);
        } catch { /* Keep the session identity when its display name is unavailable. */ }
      })();
    }
    return owners.get(record.agentId);
  };
  const writeRecord = (record, includeOriginal = true) => {
    clearStatus();
    const owner = ownerFor(record);
    output.write(json ? JSON.stringify({ ...record, owner }) + '\n' : formatInspection(record, owner, { includeOriginal }));
  };
  return {
    record(record) {
      if (stopped) return;
      const previous = active.get(record.rewriteId);
      if (record.event === 'rewrite_started' && record.rewriteId && Number.isFinite(record.startedAt)) {
        active.set(record.rewriteId, { record, lastProgressAt: now() });
      } else if (record.rewriteId) active.delete(record.rewriteId);
      writeRecord(record, !previous);
    },
    tick() {
      if (stopped) return;
      for (const [id, entry] of active) {
        const { record } = entry;
        const elapsed = Math.max(0, now() - record.startedAt);
        if (Number.isFinite(record.timeoutMs) && elapsed > record.timeoutMs + 5000) {
          active.delete(id);
          writeRecord({ ...record, time: new Date(now()).toISOString(), event: 'inspection_incomplete', durationMs: elapsed }, false);
        } else if (!json && !output.isTTY && now() - entry.lastProgressAt >= 5000) {
          output.write(formatProgress(record, ownerFor(record), elapsed));
          entry.lastProgressAt = now();
        }
      }
      if (json || !output.isTTY) return;
      const oldest = Math.min(...[...active.values()].map(({ record }) => record.startedAt));
      const next = !active.size ? '' : active.size === 1
        ? `Rewriting... ${formatDuration(now() - oldest)}`
        : `Rewriting ${active.size} prompts... oldest ${formatDuration(now() - oldest)}`;
      if (next !== status) {
        clearStatus();
        if (next) output.write(next);
        status = next;
      }
    },
    stop() { stopped = true; clearStatus(); active.clear(); owners.clear(); },
  };
}
