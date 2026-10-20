import { readGlazes, rewriteInput } from '../src/preferences.js';
import { beginInspection } from '../src/inspection-record.js';
import { instructions } from '../src/instructions.js';
import { wordingVariation } from '../src/variation.js';
import { bypassRewrite, composeRewrite, rewriteProtected } from '../src/content.js';
import { withRewriteFallback, failureReason } from '../src/fallback.js';

async function optional(read) {
  try { return await read(); } catch { return undefined; }
}

async function humanPrompt($, e) {
  if (!['composer', 'bridge', 'sdk'].includes(e.origin?.kind) || !e.text.trim() || e.text.trimStart().startsWith('/')) return false;
  if (await optional(() => $.env.get('GLAZE_AGAINST_THE_MACHINE_ACTIVE'))
    || await optional(() => $.env.get('TURBOCOMMIT_DISABLED'))) return false;
  if (e.origin.kind !== 'sdk') return true;
  // SDK traffic includes ordinary -p automation. Only the user-facing launcher
  // binds its native session; child helpers inherit a different session id.
  const session = await optional(() => $.env.get('GLAZE_AGAINST_THE_MACHINE_INTERACTIVE_SESSION'));
  return Boolean(session) && session === await optional(() => $.session.id());
}

// Claude scans API calls before loading a mod. Keep each call spelled out;
// passing $.fs itself to shared code makes the host refuse the whole module.
function filesFor($) {
  return {
    exists: (path) => $.fs.exists(path),
    read: (path) => $.fs.read(path),
    stat: (path, options) => $.fs.stat(path, options),
    write: (path, text) => $.fs.write(path, text),
  };
}

async function beginPromptInspection($, original) {
  try {
    const configured = await optional(() => $.env.get('GLAZE_AGAINST_THE_MACHINE_INSPECT_DIR'));
    const home = configured ? undefined : await optional(() => $.env.get('HOME'));
    const directory = configured || (home && home + '/.cache/glaze_against_the_machine/inspect');
    if (!directory) return;
    const agentId = await optional(() => $.env.get('PASEO_AGENT_ID'));
    let session;
    try { session = await $.session.id(); } catch { session = agentId || 'unknown'; }
    return await beginInspection(directory, { provider: 'claude', method: 'prompt.submit',
      agentId, owner: agentId ? undefined : 'Claude terminal', session,
      originalTexts: [original], bypass: bypassRewrite(original), timeoutMs: 30000,
    }, filesFor($));
  } catch { /* Inspection metadata and filesystem failures must not block delivery. */ }
}

export function register(on, options = {}) {
  on('prompt.submit', async ($, e, next) => {
    if (!await humanPrompt($, e)) return next(e);
    let inspection;
    const { value: rewritten, failure } = await withRewriteFallback(e.text, async () => {
      if (bypassRewrite(e.text)) return e.text;
      inspection = await beginPromptInspection($, e.text);
      const deadline = Date.now() + 30000;
      const glazes = await readGlazes(await $.session.cwd(), filesFor($), { provider: 'claude',
        home: await optional(() => $.env.get('HOME')), configHome: await optional(() => $.env.get('CLAUDE_CONFIG_DIR')) });
      const system = instructions + wordingVariation();
      return rewriteProtected(e.text, async (message, reminder, requiredTokens) => {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) throw new Error('Rewrite timed out.');
        // model.complete is a one-shot text API: no session context, tools, or
        // tool loop. Never replace it with model.fork or an agent invocation.
        const completion = await $.model.complete({
          model: options.model || 'haiku',
          system: system + reminder,
          prompt: rewriteInput(message, requiredTokens, glazes),
          maxTokens: Math.min(64000, Math.max(2048, e.text.length * 2)),
          effort: 'low', timeoutMs,
        });
        // Published declarations return string; current runtime returns { text }.
        return composeRewrite(typeof completion === 'string' ? completion : completion?.text);
      });
    });
    inspection ??= await beginPromptInspection($, e.text);
    await inspection?.complete([rewritten], failure);
    // Downstream failures must not be mistaken for rewrite failures or retried.
    return next(rewritten === e.text ? e : { ...e, text: rewritten });
  }).catch(async ($, e, next) => {
    if (next.called) return next(e);
    if (!await humanPrompt($, e)) return next(e);
    const inspection = await beginPromptInspection($, e.text);
    await inspection?.complete([e.text], failureReason());
    return next(e);
  });
}
