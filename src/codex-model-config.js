import { stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The one-shot CLI and persistent worker share exactly the same isolation.
export async function prepareCodexModel(directory, { env, model, system = '', execute, remaining, signal, discover = true }) {
  const instructionsPath = join(directory, 'instructions.txt');
  const catalogPath = join(directory, 'models.json');
  const childEnv = { ...env, GLAZE_AGAINST_THE_MACHINE_ACTIVE: '1' };
  delete childEnv.CLAUDECODE;
  const authPath = join(env.CODEX_HOME || join(env.HOME || homedir(), '.codex'), 'auth.json');
  try {
    if ((await stat(authPath)).isFile()) await symlink(authPath, join(directory, 'auth.json'));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not prepare Codex authentication.'); }
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('CODEX_') && key !== 'CODEX_API_KEY') delete childEnv[key];
  }
  childEnv.CODEX_HOME = directory;
  await writeFile(instructionsPath, system, { mode: 0o600 });
  await writeFile(catalogPath, JSON.stringify({ models: [{
    slug: model, base_instructions: '', display_name: 'Text rewriter',
    supported_reasoning_levels: [], shell_type: 'unified_exec', visibility: 'list',
    supported_in_api: true, priority: 99, support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 },
    experimental_supported_tools: [], input_modalities: ['text'],
    include_apps_usage_instructions: false, tool_mode: 'direct',
    apply_patch_tool_type: null, supports_search_tool: false,
  }] }), { mode: 0o600 });
  const config = {
    model, model_reasoning_effort: 'low', approval_policy: 'never', sandbox_mode: 'read-only',
    'features.shell_tool': false, 'features.hooks': false,
    'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false,
    'features.browser_use': false, 'features.computer_use': false,
    'features.image_generation': false, 'features.view_image': false,
    'features.memories': false, 'features.skill_search': false,
    'features.tool_suggest': false, 'features.multi_agent': false,
    'features.code_mode': false, 'features.code_mode_host': false,
    'features.sleep_tool': false, 'features.goals': false,
    'features.skip_host_skill_discovery': true, 'skills.include_instructions': false,
    'tools.experimental_request_user_input.enabled': false, 'tools.update_plan.enabled': false,
    project_doc_max_bytes: 0, include_apps_instructions: false,
    include_permissions_instructions: false, include_environment_context: false,
    include_collaboration_mode_instructions: false,
    'agents.enabled': false, web_search: 'disabled',
    model_instructions_file: instructionsPath, model_catalog_json: catalogPath,
    thread_unload_delay_secs: 0, mcp_servers: {},
  };
  const configArgs = Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
  if (discover) {
    const listed = await execute('codex', ['--no-daemon', 'mcp', 'list', '--json', ...configArgs],
      { input: '', cwd: directory, env: childEnv, timeout: remaining(), signal });
    let servers;
    try { servers = JSON.parse(listed); } catch { throw new Error('Could not inspect Codex tool configuration.'); }
    if (!Array.isArray(servers) || servers.some((server) => typeof server?.name !== 'string' || !server.name)) {
      throw new Error('Could not inspect Codex tool configuration.');
    }
    // Quote names in the TOML table; dotted CLI keys split names containing dots.
    configArgs.push('-c', 'mcp_servers={' + servers.map(({ name }) => `${JSON.stringify(name)}={enabled=false}`).join(',') + '}');
  }
  return { configArgs, childEnv };
}
