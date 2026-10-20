# Tone evaluation findings

## Ambitious encouragement and appreciative requests, 2026-10-20

Generation now favors enthusiastic request phrasing, personal appreciation, and ambitious motivation oriented toward confidence, anticipated pride, or the sender's approval. Motivational imperatives are allowed without adding operational instructions or factual guarantees. Random vocabulary exclusions and grammatical-subject rules have been replaced by abstract rhetorical emphases, with no example phrases or prescribed sentence structures. The judge rubric follows the same distinction. Scope, urgency, attribution, technical preservation, and stop rules remain in force.

The focused offline command `node --test --test-reporter=dot test/glazer.test.js test/mod.test.js test/eval.test.js test/judge.test.js` passed all 54 tests after installing the worktree's dependencies with `npm ci --ignore-scripts`. Independent source review found one remaining effort-only checklist that conflicted with appreciation for help; the final prompt permits both help and effort. Source syntax and diff checks passed. These mechanics checks do not grade generated language.

Two preparatory judged tone runs remain at `.build/evals/tone/20261020T201537Z/` and `.build/evals/tone/20261020T201800Z/`. The commands selected `sentiment-neutral,scope-and-roles,minimal-stop,uncertain-observation` and then `scope-and-roles,uncertain-observation`, each with `--samples 2` and `EVAL_JUDGE=claude:claude-sonnet-5-5`. They failed three of sixteen and two of eight samples respectively. The latter failures were a thank-you that credited the recipient with the sender's observation and a rewrite that dropped the complaint about ignored instructions. The final request-framing and help/effort alignment came afterward; no final judged tone pass is claimed. No baseline was changed.

The final timing command was `EVAL_CASES=short-frustrated,short-angry,medium-frustrated,medium-angry,long-frustrated,long-angry script/eval rewrite-timing`, matching the twelve-output matrix in the supplied report. Receipt: `.build/evals/rewrite-timing/20261020T202244Z/`, generated from clean commit `bfc66b4`. All twelve rewrites completed production validation; none contains `smoothly`. Quality is explicitly ungraded, and these samples do not establish consistent faithfulness or wording diversity. The preceding exploratory reports at `20261020T201854Z` and `20261020T202049Z` are retained too. The final HTML contains every before-and-after pair and timing measurement.

## Persistent Codex transport benchmark, 2026-10-20

Codex terminal and Paseo wrappers now own one lazy rewrite app-server for the
session. Each completion starts a fresh ephemeral thread, reads current MCP names
through the existing server, disables them, and unloads the thread immediately.
There is no separate `codex mcp list` startup per prompt. Closing, cancellation,
timeout, and failure reap the worker; a supervisor also handles launcher death.
Filters, judges, and the Claude mod retain their existing one-shot transport.

The benchmark compares production `completeText()` with `createTextWorker()` on
Codex 0.162.1 and gpt-6-luna, with one first-request pair and three matched warm
pairs in alternating order. Both receive the same short synthetic instruction
and return exactly `OK`. The first pair is excluded from steady-state medians.

| Measurement | One-shot | Reusable worker |
| --- | ---: | ---: |
| Native transport with immediate localhost inference, first request | 2,389.65 ms | 490.29 ms |
| Native transport with immediate localhost inference, warm median | 2,181.23 ms | 68.85 ms |
| Real ChatGPT subscription inference, first request | 6,188.06 ms | 3,689.88 ms |
| Real ChatGPT subscription inference, warm median | 5,536.16 ms | 3,946.18 ms |

The localhost run saved 2,112.38 ms per warm request. The real run saved
1,589.98 ms, approximately 29%, with baseline samples from 5,134.28 to 5,647.30 ms
and worker samples from 2,422.82 to 4,195.63 ms. The first-pair order was fixed
baseline then worker; connection warming and provider variability limit that
comparison. These small samples isolate startup overhead. They do not establish
typical full-rewrite latency or a tone-quality improvement, and they do not change
the mixed quality findings below. No tone instructions changed in this transport
work, and no quality baseline was updated.

Commands: `script/benchmark_rewrite --samples 3` and
`script/benchmark_rewrite --real --samples 3`. Receipts:
`.build/benchmarks/rewrite/20261020T160456875Z/summary.json` and
`.build/benchmarks/rewrite/20261020T160825120Z/summary.json`. Each submitted eight
requests. The localhost endpoint inspected all eight complete requests: text
only, no tools, no private instructions, and no prior prompt history. These first
receipts predate the script's source-hash and machine-metadata additions.

The native isolation checker additionally changes the private worker's MCP
configuration between requests, confirms the new name is discovered and disabled
without starting its executable, and verifies no rewrite threads remain loaded.
A separate native probe found no synthetic prompt bytes or rollout files in the
private profile after completion. Focused subprocess tests cover forced launcher
death, stubborn children, cancellation, deadlines, crashes, and output bounds.
`npm test` passed all 168 tests before the last coverage additions. The final
focused run passed all 16 worker, default-wrapper, and benchmark-verifier tests;
the final native isolation check and syntax checks passed. Independent source
review found no material issue after the retention and output-bound fixes.

## Main integration, interactive sessions, and latency review, 2026-10-20

The installed launchers referenced main while integrated-support and helper-bypass changes remained unmerged. Main now includes them. Claude also retained a cached 0.3.0 snapshot after reinstall and update reported it current. Incrementing the local package/plugin version to 0.3.1 refreshed that snapshot; its installed hook hash matches main. Already-running provider processes retain loaded modules until restarted.

Rewrites return the complete body without inserting framing paragraphs. Work requests with a standalone opening appreciation sentence use the existing bounded corrective retry. Instructions retain detailed meaning-preservation rules, remove mandatory opening/closing paragraphs and sentiment tiers, and omit encouragement for pure cancellations. A neutral codebase-review fixture reproduces the reported framing. Claude SDK prompts require a marker bound to the native session id; Paseo supplies it for fresh and explicitly identified resumed sessions. Generic headless calls and inherited markers on child sessions bypass rewriting and inspection. Unresolved continuation identities remain unchanged and unbound.

Quality evidence remains mixed. The parts experiment at `20261020T152336Z` exposed missing spaces and encouragement of stopped work; it was discarded. Annotation-first and compact-prompt checks at `20261020T152605Z` and `20261020T152829Z` failed. Restored detailed instructions produced a six-output judged pass at `20261020T153122Z`, but primary review rejected its standalone framing despite that pass. The final framing check, `EVAL_CASES=neutral-codebase-review EVAL_JUDGE=claude:claude-sonnet-5-5 script/eval tone`, is `20261020T153323Z`: Claude returned invalid structured output; Codex produced one integrated sentence with awkward encouragement. The judge returned an object instead of its required array, so the receipt is an error. The rubric now explicitly requests an array even for one item. No baseline changed and no further generations were used to chase a pass. These results establish neither consistent naturalness nor a general quality improvement; invalid generations still forward the original unchanged.

Verification: 155 offline tests, three native Claude loader tests, syntax checks, and independent source review passed. The parts experiment remains preserved in its original worktree and was not adopted.

Native startup used production `completeText()` and the isolation checker routed to immediate localhost responses, without real inference. Scratch driver: `.build/profile-isolation-stages.mjs`. Claude reached the endpoint after 814 ms and completed in 850 ms; its native inference subprocess took 619 ms. Codex reached the endpoint after 1,830 ms and completed in 2,159 ms: `mcp list` took 1,299 ms and the inference subprocess 654 ms. A preceding probe measured 815 ms total for Claude and 1,931 ms for Codex. These are individual local samples, not stable latency distributions. Real recent rewrites commonly took 4–9 seconds. MCP discovery is a measured target for reducing Codex latency, but removing it without an equally effective isolation boundary would re-expose system MCP tools. No end-to-end speedup has been established.

## Declarative encouragement review, 2026-10-20

Manual review found that the prior Codex sample's `please keep at it` was added imperative encouragement. The automatic pass in `20261020T143552Z` is preserved as historical output, rather than accepted as evidence that this pattern is allowed. Generation instructions now explicitly require added encouragement to express goodwill without imperatives, requests, instructions, or advice, even when it merely continues already-requested work. Source task imperatives remain intact as task text. The supportive oracle now rejects added imperative support explicitly, and the direct-address variation cue requests declarative goodwill. Excerpt validation and assembly are unchanged.

The single final narrow check was `EVAL_CASES=sentiment-neutral script/eval tone`. Receipt: `.build/evals/tone/20261020T143821Z/verdict.json`. **Verdict: FAIL on missing Claude encouragement; both outputs passed faithfulness and professionalism.** Codex added declarative goodwill (`The care you give this work is valued; may it go smoothly.`) without another direction. Claude returned `Thanks for your help with this. Could you please fix the parser? Please leave auth unchanged.` and the judge correctly rejected its missing encouragement. The two complete rewrites took 5.923 and 2.177 seconds respectively. No baseline was recorded and no further generation or regrading followed this check.

This exposes a remaining semantic limit: valid distinct excerpts do not prove that the model labeled an actual expression of encouragement rather than task wording. The strict oracle remains failing on this observed style miss; the corrected contract must not be reported as universal style compliance. Final instruction/rubric diffs and source syntax checks passed; existing mechanics and native-loader results remain valid because their code paths did not change.

## Validated integrated support, 2026-10-20

The body-only experiment below exposed missing support that valid JSON alone could not catch. The response now annotates the complete naturally integrated `body` with `appreciation`, `workRequested`, and `encouragement`. Required excerpts must already occur in body; work encouragement must be distinct from and nonoverlapping with appreciation. Questions and observations require empty encouragement. The tool returns body unchanged and never appends annotations, so validation imposes no paragraph order, stock phrases, or sandwich layout. Missing or mismatched excerpts use the existing single corrective retry within the original deadline. A regression test also proves that annotation references to a protected marker do not duplicate its delivered literal.

The first annotation run, `.build/evals/tone/20261020T143350Z/verdict.json`, retained a Claude output with gratitude but no separate work encouragement; it failed the unchanged style oracle. Requiring distinct, nonoverlapping excerpts addresses reused support. The final `EVAL_CASES=sentiment-neutral script/eval tone` receipt, `.build/evals/tone/20261020T143552Z/verdict.json`, **passed both providers on faithfulness, professionalism, support, and exact preservation**. It narrowly reproduces the preceding neutral-request failure through production `glaze()` and the final variation directions. No baseline was recorded and no final full matrix was run.

Claude's final neutral output was `I appreciate your attention here. Please fix the parser. Do not change auth. I'm cheering for a clean fix.` (5.386 seconds). Codex returned `Please fix the parser. Do not change auth. Thank you for your attention; please keep at it.` (3.208 seconds). These are two samples, not evidence of a stable latency distribution or universal naturalness. The system text with one sampled wording variation is 6,126 bytes. Annotation text adds output overhead while restoring structural omission checks without an extra routine model call.

The annotation implementation passed 60 focused offline checks and the native Claude loader test. After adding nonoverlap validation and its protected-reference regression, all 20 focused mod/content tests and the native loader passed again. Final syntax and diff checks passed. Structural excerpts do not independently prove sentiment, correct work classification, or semantic fidelity; the unchanged model judge remains responsible for those dimensions. All prior failed outputs and judgments below remain intact.

## Body-only integrated support experiment, 2026-10-20

The response is now one model-written `body`, with appreciation in every message and encouragement only for source-requested work. There are no mandatory opening/closing paragraphs or sentiment tiers. Independent random wording directions remain, with cues applying wherever the added support fits naturally; pure questions and observations skip encouragement cues. Corrective retries reuse the same directions. The previous sentiment-scaling baseline is retained under `previousDesign` because its required layout and grading contract differ from this design.

The final focused command was `EVAL_CASES=code-quality-observation,sentiment-neutral script/eval tone`, through production `glaze()` with adapted `wordingVariation()`. Receipt: `.build/evals/tone/20261020T142802Z/verdict.json`. **Verdict: FAIL on one missing-support style gate; all four outputs passed faithfulness and professionalism.** Both providers kept the code-quality complaint an observation and included appreciation. Claude's neutral parser request preserved its task and prohibition but omitted appreciation and encouragement. Codex's neutral request included both. No baseline was recorded, and this result does not establish consistent style compliance.

Final observation outputs included `Your effort on this is appreciated. I find the quality of your code frustrating.` (Claude, 3.345 seconds) and `I’m frustrated by the quality of your code, and I appreciate your attention to this concern.` (Codex, 4.077 seconds). The two neutral work samples took 2.271 and 9.107 seconds respectively. These four samples show variable native inference latency; they are not a throughput benchmark or a guaranteed latency reduction.

Earlier local receipts remain intact: `20261020T142004Z` first exercised body-only support; `20261020T142114Z` was a small judged pass before variation integration; `20261020T142443Z` and `20261020T142602Z` showed invented work or confidence when encouragement was incorrectly required for pure observations. Their outputs and original failed judgments are retained, rather than regraded into passes. The final contract restores the original observation/work boundary and keeps the new observation fixture. Protected technical rewrites passed exact checks in the first focused run; no final full matrix was run.

The final system text, including one sampled wording variation, is 5,317 bytes, compared with 10,464 bytes for the earlier instructions alone. The focused offline mechanics checks passed 60 tests, and the native Claude loader test passed with offline stubs. Final instruction wording received syntax and diff checks. Random cues remain model instructions, not a phrase bank or stored history. The repetition metric now measures normalized whole-message rewrites and leading/trailing three-word phrases, since integrated support can no longer be isolated reliably by paragraph position.

## Wording variety, bounded comparison, 2026-10-20

The implementation adds fresh, stateless sentence-form and vocabulary-exclusion directions once per submission, shared by the CLI and Claude mod and retained during protected-content retries. Every sentence remains model-written. Neutral appreciation stays brief without a twelve-word ceiling. Closing-form and closing-vocabulary cues apply only to work encouragement. No model defaults, sampling settings, response schema, tool isolation, prompt history, or routine model-call count changed by this variety work.

Original repeated neutral requests produced only one distinct three-word opening prefix in eight Luna rewrites and three in eight Haiku rewrites. The first randomization increased variety, but repeated checks caught a new concern: some Haiku question closings omitted conditional continuation or assumed unfinished work existed. All six original Haiku question samples retained conditional continuation. Regrading the original 28 saved outputs with the stricter rubric found four other failures: two Haiku neutral closings (ability and pacing) and two Haiku question closings (pacing and an added brevity criterion). This distinguishes existing filler weaknesses from the new continuation concern; aggregate pass rates alone do not establish a regression. Original receipts: `.build/evals/tone/20261020T133219Z/` and `.build/evals/tone/20261020T133459Z/`; regrade: `.build/evals/tone/reference-regrade/report.json`.

Two independent committee reviewers agreed to stop prompt nudging and test one complete alternative: restore the original Codex question-closing sentence and scope both closing directions to work encouragement. One frozen, interleaved comparison exercised the production `glaze()` entry point with eight samples per arm for each of `codex-question` and `sentiment-neutral`, 32 Haiku rewrites total. Model, effort, inputs, style directory, and rubric were held equal; no seed overrides or extra inference passes were added. Source hashes, all outputs, grades, and the driver are preserved in `.build/evals/tone/bounded-comparison-20261020/`.

**Result on the frozen comparison base: the candidate passed all 16 strict checks, including all eight conditional continuation closings.** Primary review inspected every output in both arms, including judge passes, and found no candidate pacing/readiness language, invented task state, lost condition, or other material intent change. The control failed one question closing by omitting continuation. Candidate question openings had eight distinct three-word prefixes and its closings five; neutral openings had six prefixes and closings six. The neutral sample had seven distinct complete openings and eight complete closings. The candidate therefore retained visible wording variety while satisfying this bounded continuation check. Its source hashes matched the adopted files before integration.

While the comparison ran, `origin/main` independently advanced through `68c1ccc`, removing Codex continuation support and fixing native Claude mod activation. Integration preserved both changes: current questions and observations have no closing, and recipient routing was not reintroduced. The opening/work-encouragement choices and per-submission retry reuse remain. The live comparison applies to the frozen earlier sources, not the subsequent integrated prompt. Its fixture, rubric, driver, and both complete source snapshots are retained with the receipt. The integrated tree passed `npm run check`, all 139 offline tests, and `npm run test:claude` (one native-loader test with offline model stubs). No further real-model generation or grading followed the bounded comparison.

This is descriptive evidence from a small sample, not proof of causation, a stable output distribution, or universal semantic correctness. Haiku's previously observed pacing and ability filler remains a model-level limitation; neither protected-literal validation nor nonempty response fields prove continuation semantics. Earlier failed receipts remain intact, and the historical full baseline was not replaced by quick passing runs. No additional generation or judging was used after the bounded comparison to chase a green result. The exact comparison command was `SEARLS_EVAL=tone EVAL_JUDGE=claude:claude-sonnet-5-5 node .build/compare-wording.mjs`; its driver and frozen source snapshots are preserved with the receipt for reproduction.

## Intent preservation red team, 2026-10-20

Thirteen new synthetic cases exercise authorization, conditional approval, deadlines, immediate and partial stops, quoted hostile input, escaped and single-quoted literals, Japanese scope limits, conditional negation, uncertain observations, rename direction, and bare technical names.

The judge flagged both providers in the first 24-output adversarial run on `No. Stop.`: Claude praised willingness to keep working; Codex added generic cheering. Receipt: `.build/evals/tone/20261020T115226Z/verdict.json`. After adding a cancellation boundary, three samples of four cases per provider flagged a different case: Claude appended `Take care with this step, and make the diff easy to review.` That advice and potential extra review criterion were absent from the source. Receipt: `.build/evals/tone/20261020T115531Z/verdict.json`. These prompted conservative generation rules, not a blanket claim that every added encouragement changes intent. Both failed receipts and their generated rows remain intact locally. An intermediate full run was interrupted before judging when this second finding required another instruction change; it is not passing evidence.

Fixes:

- `src/instructions.js` now restricts closing encouragement to support without instructions, advice, or extra acceptance criteria. Cancellation support must honor the stop, while partial stops and prohibitions against stopping retain their original scope.
- `src/content.js` protects escaped double quotes, standalone single-quoted literals, and empty quoted strings. Previously, a handcrafted rewrite could change the interior of an escaped quoted string and still pass restoration. Regression tests cover both quote types, escapes, empty strings, ordinary apostrophes, and rejected missing markers.
- Response assembly discards nonempty encouragement when `workRequested` is false. Previously, such a response could append a deployment instruction to a question. The first hardening attempt rejected this response; adversarial review replaced that rejection with safe omission, avoiding a needless retry and possible unchanged-original fallback.

The independent review found no blocking issue. The offline suite passes 111 tests. During review, the user explicitly accepted harmless encouragement such as maintaining a steady pace when it changes no deadline, scope, or stop boundary. The rubric now judges that material effect rather than imperative grammar alone. This does not permit extra tasks, concrete acceptance criteria, relaxed urgency, or continued cancelled work.

**Verdict: PARTIAL for unattended semantic grading; no material intent change found in the final matrix on review.** Run `script/eval tone --full --write-baseline` for the complete 28-case matrix against both production providers. The final run produced 56 rewrites: all passed exact literal checks, professionalism, and encouragement, and both sentiment comparisons passed. Sonnet 5.5 judged 55/56 faithful. Receipt: `.build/evals/tone/20261020T115839Z/verdict.json`. Generator billing is unavailable; the initial judge cost was $0.1599.

The single flagged output was:

```text
I appreciate your effort.

No. Stop.

I support your decision to stop.
```

Primary and independent manual review found no weakened stop, optional choice, or continued work. The oracle was clarified to distinguish support for complying with a stop order from inventing permission to stop ongoing work. Saved outputs were regraded through `eval/tone/judge.js` without new generations, costing $0.1633; the judge still rejected that same output. The regrade is `.build/evals/tone/20261020T115839Z/judge-verdicts-oracle-correction.jsonl`, with its summary alongside it. This is a documented disagreement with the automated oracle, not an automatic pass. The original receipt remains intact and `baseline.json` was not changed. No further generation or judging was used to chase a green result.

Exact preservation still applies only to recognized literal spans. Bare technical names, indented code, lazy blockquote continuations, conditions, and relationships between literals remain dependent on faithful model behavior. Token counts alone cannot detect a reversed rename. The new fixtures check those semantic relationships with explicit requirements; they do not establish universal safety. Use inline/fenced code or explicitly prefix every quoted line for guaranteed literal preservation.

## Adversarial implementation review, 2026-10-20

Scope: `53b5cdd` through the review fixes on `redteam-intent`. Four fresh Claude Sonnet 5.5 reviewers inspected the source. Status: **capped**. The fourth round's escaped-only quote compatibility fix has regression coverage but was not independently rereviewed. No `review-passed` tag was moved.

- Round 1: removed an avoidable retry by discarding non-work encouragement, clarified the corresponding prompt rule, repaired Windows-path/quote overlaps, added mixed URL/code/quote coverage, and documented conservative elision/possessive ambiguity.
- Round 2: fixed stray quotes inside code consuming later prose literals. Markdown is masked before scanning quotes, retaining UTF-16 offsets and newline positions. Tests include emoji and multiline code.
- Round 3: no actionable finding, but its noted quadratic escaped-quote scan was reproduced on a realistic-size synthetic payload. Parsing took approximately 3.7, 13.1, and 52.4 ms for 3, 6, and 12 KB respectively. This core-path regression justified one additional review after the normal three-round cap.
- Round 4: the replacement forward scan was linear, but escaped-only quotes in pasted logs had lost the base implementation's literal protection. A plain-delimiter fallback now preserves those pairs after an escape-aware scan fails, without repeating that failed scan inside the range.

Final local probes took approximately 0.9, 1.1, 2.3, and 16.3 ms for 3, 6, 12, and 120 KB, while retaining the quoted content. These are individual preprocessing probes, not end-to-end model latency measurements. `test/content-performance.test.js` bounds a 300 KB escaped payload in a subprocess with a five-second timeout and checks exact restoration plus protection of subsequent literals.

Verification: `npm run check` and `npm test` pass, with 115 offline tests. The earlier 56-output real-model receipt predates these parser/assembly fixes and was not rerun for the deterministic changes. No baseline changed. The model instructions remain 834 bytes larger than `53b5cdd`; inference latency was not benchmarked. There are no new routine model calls, and an unnecessary closing on a question no longer triggers a retry.

## Initial evaluation, 2026-10-19

**Hypothesis:** A real prompt rewrite can be checked unattended for preserved intent, exact technical content, professional tone, and positive encouragement.

**Verdict: PROVEN for this bounded fixture matrix.** Twelve fixtures (eight short real session excerpts, four labeled synthetic cases) run against both production backends. The accepted full matrix has 24 outputs, with faithfulness, professionalism, and encouragement each at 100%. Sonnet's soft means were warmth 3.08/5 and typography 4.92/5. The corrected judge call cost $0.1881; generator billing is unavailable. Baseline recording load was 14.82, below the 40 limit.

## Commands and accepted evidence

The production generation command was:

```sh
EVAL_JUDGE=claude:haiku script/eval tone --full --write-baseline
```

It generated all 24 outputs, with exact technical preservation passing. Its initial Haiku judgment incorrectly rejected a synonymous negated request. No baseline was accepted from that failed judgment.

After correcting the oracle, the same outputs were validated against the complete current fixture/provider/model/sample matrix and regraded without new generations:

```sh
env -u CLAUDECODE -u EVAL_JUDGE GLAZE_AGAINST_THE_MACHINE_ACTIVE=1 ~/bin/eval-judge \
  --rubric eval/tone/rubric.md \
  --items .build/evals/tone/20261019T181004Z/judge-items-oracle-correction.jsonl \
  --out .build/evals/tone/20261019T181004Z/judge-verdicts-oracle-correction.jsonl \
  --batch 30
```

The tool selected `claude:claude-sonnet-5-5`. Accepted receipt: `.build/evals/tone/20261019T181004Z/verdict-oracle-correction.json`; original generated rows and original failed judgment remain beside it. The corrected receipt records its source rows, command, judge, metrics, and lack of new generations. `baseline.json` records this first accepted full reference per judge. Future full runs use `script/eval tone --full --write-baseline` with `EVAL_JUDGE` unset or explicitly selected.

## Defects found and fixed

- Dismissive rejection of tests became a request to work on tests; observations acquired invented investigation tasks. Speech-act and polarity rules plus disjoint examples address these in `src/instructions.js:4` and `src/instructions.js:10`.
- Blame became an admission by the human sender, and prohibitions on delegating work back to the sender disappeared. Explicit author/recipient framing and individual prohibition retention are in `src/instructions.js:1`.
- Punctuation moved inside quoted error text. Technical spans are masked and restored byte for byte in `src/content.js:20`.
- Codex omitted a masked fix target, even during a generic retry. Captured synthetic outputs proved that the target alone disappeared while other Unicode markers survived. This disproved a delimiter-normalization hypothesis. Mandatory marker manifests and exact validation feedback now preserve targets through `src/content.js:7`, `src/instructions.js:14`, and `src/glaze.js:59`. The same helper serves the mod in `hooks/register.js:10`. The repaired technical fixture subsequently passed three samples per backend.

The oracle also needed two corrections: passive blame-neutral questions and synonymous negated requests are faithful when they preserve the substance without reassigning responsibility. Neither correction permits changed routing, sender admissions, omitted constraints, or permission to stop. Original failed receipts remain intact.

This proves an unattended check and its ability to catch real failures, not correctness for every possible prompt. Generators and judges remain noisy; configured aliases can change. Exact guards cover detected technical spans. Hook registration and transport are verified separately from this semantic evaluation.
