// Shared with Claude's mod runtime. Never expose arbitrary provider errors:
// their messages can contain the original prompt or model output.
export function failureReason(error) {
  let message = '';
  try { if (typeof error?.message === 'string') message = error.message; } catch { /* Even an unusual thrown value must preserve the original. */ }
  if (/timed out/i.test(message)) return 'Rewrite timed out.';
  if (/GLAZES\.md/.test(message)) return 'Could not read GLAZES.md.';
  if (/protected|invalid prompt|empty prompt|invalid JSON/i.test(message)) return 'Rewrite failed response validation.';
  if (/not installed|Could not start|exited with status|could not complete/i.test(message)) return 'Rewrite provider unavailable or failed.';
  return 'Rewrite failed.';
}

export async function withRewriteFallback(original, rewrite) {
  try { return { value: await rewrite() }; }
  catch (error) { return { value: original, failure: failureReason(error) }; }
}
