export function settings(env, fixtures, defaults) {
  const samples = Number(env.EVAL_SAMPLES || (env.EVAL_FULL === '1' ? 3 : 1));
  const timeout = Number(env.EVAL_TIMEOUT_MS || 90000);
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer.');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new Error('EVAL_TIMEOUT_MS must be a positive integer no greater than 2147483647.');
  if (env.EVAL_WRITE_BASELINE === '1') throw new Error('Timing is descriptive; --write-baseline is not supported by rewrite-timing.');
  const selected = env.EVAL_CASES === undefined ? null : env.EVAL_CASES.split(',');
  if (selected && selected.some((id) => !fixtures.some((fixture) => fixture.id === id))) throw new Error('EVAL_CASES contains an unknown or empty fixture id.');
  return {
    samples, timeout,
    fixtures: fixtures.filter((fixture) => !selected || selected.includes(fixture.id)),
    models: Object.fromEntries(Object.entries(defaults).map(([provider, model]) => [provider, env[`EVAL_${provider.toUpperCase()}_MODEL`] || model])),
  };
}

// Serial matched pairs avoid provider contention. Alternate the first provider
// between pairs so neither provider always gets the earlier slot.
export async function runMatrix({ fixtures, models, samples, timeout }, { rewrite, onRow, signal, now = () => performance.now() }) {
  const rows = [];
  let pair = 0;
  for (let sample = 1; sample <= samples; sample++) {
    for (const fixture of fixtures) {
      const providers = Object.keys(models);
      if (pair++ % 2) providers.reverse();
      for (const provider of providers) {
        if (signal?.aborted) return rows;
        const row = { id: `${provider}/${fixture.id}/${sample}`, provider, model: models[provider],
          case: fixture.id, length: fixture.length, sentiment: fixture.sentiment, sample,
          input: fixture.input, inputChars: fixture.input.length, inputWords: fixture.input.trim().split(/\s+/u).length,
          output: null, status: 'completed', error: null, startedAt: new Date().toISOString() };
        const start = now();
        try {
          row.output = await rewrite(fixture.input, { provider, model: models[provider], timeout, signal });
        } catch (error) {
          row.status = /not installed or is not on PATH/.test(error.message) ? 'unavailable' : 'error';
          row.error = error.message;
        }
        row.seconds = (now() - start) / 1000;
        rows.push(row);
        await onRow(row);
      }
    }
  }
  return rows;
}
