// Native-provider fixture: synthetic authentication, loopback inference, no saved prompts.
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import * as zlib from 'node:zlib';

const privateContext = 'GLAZE_PRIVATE_CONTEXT_MUST_NOT_REACH_INFERENCE';
export class CheckError extends Error {}
export const requireCheck = (condition, message) => { if (!condition) throw new CheckError(message); };

export async function nativeExecutable(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return await realpath(path);
    } catch { /* Try the next PATH entry. */ }
  }
  throw new CheckError(`Native ${name} executable is unavailable.`);
}

export function verifyRequest(provider, body, { input, system, forbiddenInputs = [] }) {
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    requireCheck(value.type !== 'additional_tools', 'Request included additional tool declarations.');
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'tools' || key === 'functions') {
        requireCheck(entry === null || (Array.isArray(entry) && !entry.length), 'Request included tools.');
      }
      visit(entry);
    }
  };
  visit(body);
  const serialized = JSON.stringify(body);
  requireCheck(!body.previous_response_id, 'Request referenced previous response context.');
  requireCheck(!serialized.includes(privateContext)
    && !serialized.includes('<skills_instructions>')
    && !serialized.includes('# AGENTS.md instructions'), 'Request leaked user instructions or skills.');
  requireCheck(forbiddenInputs.every((previous) => !serialized.includes(previous)), 'Request retained previous prompt context.');
  const texts = [];
  const content = (blocks, type) => {
    if (typeof blocks === 'string') { texts.push(blocks); return; }
    requireCheck(Array.isArray(blocks), 'Request content was not text.');
    for (const block of blocks) {
      requireCheck(block?.type === type && typeof block.text === 'string', 'Request contained non-text input.');
      texts.push(block.text);
    }
  };
  const messages = provider === 'claude' ? body.messages : body.input;
  if (provider === 'claude') content(body.system, 'text');
  requireCheck(Array.isArray(messages), 'Request omitted text messages.');
  let users = 0;
  for (const message of messages) {
    if (provider === 'codex') requireCheck(message?.type === 'message', 'Request contained a non-message input.');
    requireCheck(['user', 'system', 'developer'].includes(message?.role), 'Request contained assistant history or an unknown role.');
    const start = texts.length;
    content(message.content, provider === 'claude' ? 'text' : 'input_text');
    if (message.role === 'user') {
      users++;
      requireCheck(texts.slice(start).join('') === input, 'Request contained unrelated user input.');
    }
  }
  requireCheck(users === 1, 'Request did not contain exactly one user message.');
  requireCheck(texts.includes(system), 'Request omitted the expected system instructions.');
  requireCheck(texts.includes(input), 'Request omitted the synthetic text input.');
}

function respond(provider, body, response, reply, id) {
  const events = provider === 'claude' ? [
    { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [
    { type: 'response.output_item.done', output_index: 0, item: { id: `msg_${id}`, type: 'message',
      role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] } },
    { type: 'response.completed', response: { id: `resp_${id}`, object: 'response', created_at: 0,
      status: 'completed', model: body.model, output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

export async function createOfflineModel(provider) {
  const binary = await nativeExecutable(provider);
  const directory = await mkdtemp(join(tmpdir(), 'glaze-offline-model-'));
  const controller = new AbortController();
  const seenInputs = new Set();
  let expected, failure, requests = 0, attempts = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      if (request.method !== 'POST' || path !== (provider === 'claude' ? '/v1/messages' : '/v1/responses')) {
        throw new CheckError('Native CLI attempted an unexpected inference endpoint.');
      }
      attempts++;
      requireCheck(expected, 'Native CLI sent inference outside the active request.');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        requireCheck(size <= 8 * 1024 * 1024, 'Request exceeded the isolation check size limit.');
        chunks.push(chunk);
      }
      let buffer = Buffer.concat(chunks);
      const encoding = request.headers['content-encoding'];
      const decompress = { gzip: zlib.gunzipSync, deflate: zlib.inflateSync, br: zlib.brotliDecompressSync,
        zstd: zlib.zstdDecompressSync }[encoding];
      if (encoding && encoding !== 'identity') {
        requireCheck(typeof decompress === 'function', 'Node cannot decode the native request compression.');
        buffer = decompress(buffer, { maxOutputLength: 8 * 1024 * 1024 });
      }
      const body = JSON.parse(buffer.toString('utf8'));
      verifyRequest(provider, body, { ...expected, forbiddenInputs: [...seenInputs].filter((value) => value !== expected.input) });
      requests++;
      respond(provider, body, response, expected.reply, requests);
    } catch (error) {
      failure ??= error instanceof CheckError ? error : new CheckError('The local inference request was malformed.');
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Offline isolation check rejected this request.' } }));
      controller.abort();
    }
  });
  const close = async () => {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const home = join(directory, 'home');
    const codexHome = join(home, '.codex');
    const claudeHome = join(home, '.claude');
    const skill = join(codexHome, 'skills', 'private-context');
    await mkdir(skill, { recursive: true, mode: 0o700 });
    await mkdir(claudeHome, { mode: 0o700 });
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'offline-synthetic-api-key' }), { mode: 0o600 });
    await writeFile(join(codexHome, 'AGENTS.md'), privateContext);
    await writeFile(join(claudeHome, 'CLAUDE.md'), privateContext);
    await writeFile(join(skill, 'SKILL.md'), `---\nname: private-context\ndescription: ${privateContext}\n---\n${privateContext}\n`);
    const address = `http://127.0.0.1:${server.address().port}`;
    const routing = { model_provider: 'offline_isolation', 'model_providers.offline_isolation.name': 'Offline isolation',
      'model_providers.offline_isolation.base_url': address + '/v1',
      'model_providers.offline_isolation.wire_api': 'responses',
      'model_providers.offline_isolation.requires_openai_auth': false };
    const options = provider === 'codex' ? Object.entries(routing).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]) : [];
    // Change transport routing only. src/model.js supplies every isolation restriction.
    await writeFile(join(directory, provider), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const result = spawnSync(${JSON.stringify(binary)}, [...process.argv.slice(2), ...${JSON.stringify(options)}], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
    const env = { PATH: directory + delimiter + process.env.PATH, HOME: home, CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome, ANTHROPIC_BASE_URL: address, ANTHROPIC_API_KEY: 'offline-synthetic-api-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', LANG: 'en_US.UTF-8' };
    return { env, binary, signal: controller.signal, close,
      get requests() { return requests; },
      get attempts() { return attempts; },
      async run({ input, system, reply }, operation) {
        requireCheck(!expected, 'Offline model requests must run sequentially.');
        expected = { input, system, reply };
        const before = requests;
        try {
          let result;
          try { result = await operation(); }
          catch (error) { throw failure || error; }
          if (failure) throw failure;
          requireCheck(requests === before + 1, 'Expected exactly one outgoing inference request.');
          requireCheck(result.text?.trim() === reply, 'Native CLI did not return the synthetic text response.');
          seenInputs.add(input);
          return result;
        } finally { expected = undefined; }
      },
    };
  } catch (error) { await close(); throw error; }
}
