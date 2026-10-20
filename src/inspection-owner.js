import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

// Resolve names in the viewer, never on the prompt submission path.
export function createOwnerResolver({ env = process.env, run = execute } = {}) {
  const owners = new Map();
  return async (record) => {
    if (!record.agentId) return record.owner || `${record.provider} terminal`;
    if (!owners.has(record.agentId)) owners.set(record.agentId, (async () => {
      try {
        const { stdout } = await run(env.PASEO_CLI || 'paseo', ['inspect', record.agentId, '--json'], { env, timeout: 3000, maxBuffer: 1024 * 1024 });
        const agent = JSON.parse(stdout);
        return agent.Name || record.owner || `Paseo ${record.agentId}`;
      } catch { return record.owner || `Paseo ${record.agentId}`; }
    })());
    return owners.get(record.agentId);
  };
}
