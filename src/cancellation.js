// Unblock the submission queue even if an integration callback ignores abort.
export async function withCancellation(signal, operation) {
  if (signal.aborted) throw new Error('Prompt submission canceled.');
  let abort;
  const canceled = new Promise((resolve, reject) => {
    abort = () => reject(new Error('Prompt submission canceled.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(operation), canceled]); }
  finally { signal.removeEventListener('abort', abort); }
}
