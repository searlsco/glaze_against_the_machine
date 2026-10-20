// Human-readable output preserves text and makes terminal controls visible.
const visible = (text) => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
  (char) => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
const oneLine = (text) => visible(text).replace(/[\r\n\t]/g, ' ');
export const formatDuration = (milliseconds) => (Math.max(0, milliseconds) / 1000).toFixed(1) + 's';

const identity = (record, owner) => `${oneLine(owner)} | ${oneLine(record.provider)} | session-id: ${oneLine(record.session || 'unknown')} | ${oneLine(record.method)}${record.bypass ? ' | rawdog' : ''}`
  + (record.rewriteId ? ` | rewrite-id: ${oneLine(record.rewriteId)}` : '');

export const formatProgress = (record, owner, elapsed) => `${identity(record, owner)} | still rewriting (${formatDuration(elapsed)})\n`;

export function formatInspection(record, owner = record.owner || record.provider, { includeOriginal = true } = {}) {
  const original = record.originalTexts?.join('\n') ?? '(original unavailable from an older session)';
  const heading = '================================================================\n' + identity(record, owner) + '\n';
  const source = includeOriginal ? 'original prompt:\n' + visible(original) + '\n\n' : '';
  if (record.event === 'rewrite_started') return heading + source + 'Rewriting...\n';
  if (record.event === 'rewrite_canceled') return heading + source + `Rewrite canceled after ${formatDuration(record.durationMs)}.\n================================================================\n\n`;
  if (record.event === 'inspection_incomplete') return heading + `No completion received after ${formatDuration(record.durationMs)}. The rewrite's outcome is unknown.\n================================================================\n\n`;
  return heading
    + (record.failure ? `REWRITE FAILED: ${oneLine(record.failure)} Original prompt forwarded unchanged.\n` : '')
    + (Number.isFinite(record.durationMs) ? `${record.bypass ? 'Bypassed' : record.failure ? 'Rewrite failed' : 'Rewritten'} in ${formatDuration(record.durationMs)}.\n` : '')
    + source
    + '-------------------------- glazed ------------------------------\n'
    + 'glazed prompt:\n' + visible(record.texts.join('\n')) + '\n'
    + '================================================================\n\n';
}
