import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('large escaped text does not block protection of later literals', () => {
  const moduleUrl = new URL('../src/content.js', import.meta.url).href;
  const script = `
    import { protectPrompt } from ${JSON.stringify(moduleUrl)};
    const source = String.fromCharCode(92, 34, 120).repeat(100000)
      + " Keep 'protected' and https://example.com/path";
    const protectedPrompt = protectPrompt(source);
    console.log(JSON.stringify({
      tokens: protectedPrompt.tokens.length,
      suffix: protectedPrompt.message.slice(-64),
      restored: protectedPrompt.restore(protectedPrompt.message) === source,
    }));
  `;
  // The former quadratic scan blocks for tens of seconds on this payload.
  // A subprocess timeout bounds that regression without blocking the test runner.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.tokens, 50002);
  assert.equal(output.restored, true);
  assert.ok(output.suffix.endsWith('Keep ⟦GLAZER_LITERAL_50000⟧ and ⟦GLAZER_LITERAL_50001⟧'));
});
