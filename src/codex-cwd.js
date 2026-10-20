import { resolve } from 'node:path';

export function codexLaunchCwd(args, cwd = process.cwd()) {
  let selected = cwd;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    const arg = args[i];
    if (arg === '-C' || arg === '--cd') {
      if (args[i + 1] === undefined) throw new Error(`Codex option ${arg} requires a directory.`);
      selected = resolve(cwd, args[++i]);
    } else if (arg.startsWith('--cd=')) selected = resolve(cwd, arg.slice(5));
    else if (arg.startsWith('-C') && arg.length > 2) selected = resolve(cwd, arg.slice(2));
  }
  return selected;
}

export function createCodexCwd(cwd = process.cwd()) {
  const threads = new Map();
  return {
    observe(message) {
      const result = message?.result;
      if (result?.thread?.id && typeof result.cwd === 'string') threads.set(result.thread.id, result.cwd);
      const thread = message?.method === 'thread/started' ? message.params?.thread : undefined;
      if (thread?.id && typeof thread.cwd === 'string' && !threads.has(thread.id)) threads.set(thread.id, thread.cwd);
    },
    forRequest(message) {
      const id = message.params?.threadId;
      if (message.method === 'turn/start' && typeof message.params?.cwd === 'string') {
        threads.set(id, resolve(cwd, message.params.cwd));
      }
      return threads.get(id) || cwd;
    },
  };
}
