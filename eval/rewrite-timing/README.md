# Rewrite timing and qualitative review

**Hypothesis:** A matched matrix of prompt lengths and sentiments can expose rewrite latency and produce complete before-and-after artifacts for human review across Codex and Claude.

```sh
script/eval rewrite-timing                       # 9 prompts, both providers, 18 rewrites
script/eval rewrite-timing --samples 2           # 36 rewrites
script/eval rewrite-timing --full                # 3 samples per pair, 54 rewrites
EVAL_CASES=short-neutral,long-angry script/eval rewrite-timing
```

Both native CLIs must be installed and authenticated. The default models come from production: Claude `haiku` and Codex `gpt-6-luna`. Override them with `EVAL_CLAUDE_MODEL` and `EVAL_CODEX_MODEL`. `EVAL_TIMEOUT_MS` sets the deadline for each logical rewrite (default 90000 ms, including the existing corrective retry). `--samples` overrides the full-mode sample count.

The committed synthetic fixtures cross three lengths (roughly 10–25, 90–120, and 330–450 words) with three sentiments (neutral, frustrated, and angry). Within each length the requested work and constraints remain the same. Frustrated and angry variants are independently written throughout, with irritation or invective in every sentence, lowercase rushed writing, missing apostrophes, comma splices, and occasional typos. They do not prepend an outburst to otherwise neutral prose. Sentiment and writing roughness vary together, so this matrix describes realistic inputs rather than isolating sentiment as the sole cause of a timing difference. Exact character and whitespace-delimited word counts are recorded per row. The prompts include prohibitions, conditions, and technical requirements for qualitative fidelity review. They are data to rewrite, never tasks for the eval to execute.

Every request calls the production strict `glaze()` core with its native text-only isolation, literal protection, style lookup, randomized wording directions, validation, and single corrective retry. Local and personal `GLAZES.md` files apply, as they do to the standalone filter. Models have no tools. Both transports use a new one-shot invocation per rewrite, matching the standalone CLI and existing tone eval; this does not measure Codex's reusable app-server path or Claude's in-process mod transport. Configured model identifiers are recorded, including moving aliases; actual resolved model versions and generator billing are unavailable from this API.

Calls run serially to avoid inference contention. Each fixture/sample is a matched pair, with alternating provider order. Timing uses a monotonic clock around the complete `glaze()` call, including style lookup, startup, inference, validation, corrective retry if needed, and cleanup. It excludes logging and report generation. No warmup is excluded. Whole-experiment wall time is reported separately. Provider caching, local styles, load, subscription throttling, and moving model aliases can all affect comparisons. Expect several minutes for the default matrix and proportionally more for repeated samples, with normal provider subscription usage. Each attempt is bounded by its configured timeout.

Each run prints before-and-after text plus the per-run duration, and writes these artifacts under `.build/evals/rewrite-timing/<UTC stamp>/`:

- `report.html`: self-contained, escaped, side-by-side input/output and timing tables. Open it in a browser for human review.
- `rows.jsonl`: one row per attempt, with provider/model, case, sample, length, sentiment, exact input, accepted output, elapsed seconds, and error when present. Rows are saved as they complete so an interrupted run retains its results.
- `verdict.json`: overall and per-provider median, mean, and total completion time, plus breakdowns by length and sentiment, counts, load averages, source revision, and total wall time.
- `run.log`: console output, including the full before-and-after text.

Median, mean, and total use **completed rewrites only**. `attemptedSeconds` and the “All attempts” report column include failures and timeouts, so failed calls cannot silently improve the reported total. Failed rows retain the input and error with `output: null`; the harness never counts an original-text fallback as a completed rewrite. The host integration would forward that original, but the eval exposes the strict failure. Zero completions have null median and mean, displayed as `n/a`.

There is **no model judge, quality score, latency threshold, or quality baseline**. A pass means all requested rewrites completed production response validation, not that they are faithful or pleasant. Quality remains explicitly ungraded for human review; a future judge can consume the saved input/output pairs. Timing is descriptive, so `--write-baseline` is rejected. The separate `tone` eval retains its independent judge and quality gates.

Exit codes: 0 if every rewrite completed; 2 for any rewrite or harness error (including timeouts and partial provider availability); 3 if both providers are unavailable. Rejected structured output is surfaced as an execution error, without inventing a semantic grade. Real calls require the `script/eval` environment and never run in `npm test`. This project retains its existing singular `eval/` layout and runner.
