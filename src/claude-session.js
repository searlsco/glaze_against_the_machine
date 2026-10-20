import { randomUUID } from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bind only session identities known before launch. Interactive pickers and
// --continue select their identity inside Claude and cannot be bound safely.
export function prepareClaudeSession(args) {
  const separator = args.indexOf('--');
  const boundary = separator < 0 ? args.length : separator;
  let explicit, resume, fork = false, uncertain = false;
  for (let index = 0; index < boundary; index++) {
    const [flag, ...suffix] = args[index].split('=');
    if (flag === '--continue' || flag === '-c') uncertain = true;
    if (flag === '--fork-session') fork = true;
    if (!['--session-id', '--resume', '-r'].includes(flag)) continue;
    const value = suffix.length ? suffix.join('=') : args[++index];
    if (index >= boundary || !uuid.test(value ?? '')) { uncertain = true; continue; }
    if (flag === '--session-id') {
      if (explicit) uncertain = true;
      explicit = value;
    } else {
      if (resume) uncertain = true;
      resume = value;
    }
  }
  if (uncertain) return { args, sessionId: undefined };
  if (explicit) return { args, sessionId: explicit };
  if (resume && !fork) return { args, sessionId: resume };
  const sessionId = randomUUID();
  return { args: [...args.slice(0, boundary), '--session-id', sessionId, ...args.slice(boundary)], sessionId };
}
