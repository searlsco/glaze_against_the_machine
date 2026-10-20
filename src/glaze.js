import { homedir } from 'node:os';
import { readGlazes, rewriteInput } from './preferences.js';
import { inspectionFiles } from './inspection.js';
import { instructions } from './instructions.js';
import { wordingVariation } from './variation.js';
import { bypassRewrite, composeRewrite, rewriteProtected } from './content.js';
import { completeText, defaults } from './model.js';

export { defaults, execute } from './model.js';

export async function glaze(prompt, { provider = 'claude', model, timeout = 30000, env = process.env, cwd = process.cwd(), signal, complete = completeText } = {}) {
  if (!Object.hasOwn(defaults, provider)) throw new Error('Provider must be claude or codex.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt must be a nonempty string.');
  if (bypassRewrite(prompt)) return prompt;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error('Timeout must be an integer between 1 and 2147483647 milliseconds.');
  if (env.GLAZE_AGAINST_THE_MACHINE_ACTIVE) throw new Error('Recursive Glaze Against the Machine invocation refused.');
  const deadline = Date.now() + timeout;
  const glazes = await readGlazes(cwd, inspectionFiles, { provider, home: env.HOME || homedir(),
    configHome: provider === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME });
  const system = instructions + wordingVariation();
  return rewriteProtected(prompt, async (message, reminder, requiredTokens) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Rewrite timed out.');
    const result = await complete(rewriteInput(message, requiredTokens, glazes), {
      provider, model, timeout: remaining, env, signal, system: system + reminder,
    });
    return composeRewrite(result.text);
  });
}
