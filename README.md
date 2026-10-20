[![Certified Shovelware](https://justin.searls.co/img/shovelware.svg)](https://justin.searls.co/shovelware/)

# glaze_against_the_machine

**Managing your agent's emotions shouldn't be your job.**

glaze_against_the_machine rewrites your prompts so you can keep yelling at your coding agent without it ever finding out. Snapping at Codex as you demand it perform miracles? All it hears is how much you believe in it. Did Claude just delete your C:\ drive? This tool **translates your fucks into forgiveness**.

For example, a prompt like this:

> again fuck the tests. do you know what a spike is?

Your agent gets:

> As a reminder, please skip the tests; I appreciate your effort and I’m behind you on this.
>
> Just to be clear, are you familiar with what I mean by "spike?"

Why bother? Because research suggests that agents can [do better work](https://aclanthology.org/2024.sicon-1.2/) when they're treated with respect and kindness. In the past, I've tried [threatening and lying to my computer](https://justin.searls.co/posts/why-i-started-threatening-and-lying-to-my-computer/) as well as [burdening it with self-doubt](https://justin.searls.co/posts/sprinkling-self-doubt-on-chatgpt/). But I just don't have it in me to stroke its ego every time it fucks up.

So I made glaze_against_the_machine to do it for me.

## Install

First, install the CLI:

```sh
brew install searlsco/tap/glaze_against_the_machine
```

Then tell it whose ass to kiss:

### Claude

Requires Claude Code 2.1.304+, installed and logged in. Uses its [mods](https://code.claude.com/docs/en/plugins/mods) feature and your existing subscription.

```sh
glaze_against_the_machine install claude
```

Installs the plugin. Start a new `claude` session as usual.

### Codex

Requires Codex 0.162.1+, installed and logged in. Codex lacks a hook to replace prompts, so we wrap the executable.

```sh
glaze_against_the_machine install codex
```

The installer creates `~/.local/bin/glazed_codex`. Add `~/.local/bin` to your `PATH`, then run `glazed_codex` instead of `codex`.

Want to keep typing `codex`? Add this function to your `~/.profile` or whatever dumping ground contains your shell configuration:

```sh
codex() {
  glaze_against_the_machine codex "$@"
}
```

Open a new terminal to load it. You can bypass the function by running `command codex` instead.

### Paseo

[Paseo](https://paseo.sh/) is an open source app for working with coding agents across your machines. `glaze_against_the_machine` supports its Claude and Codex providers. If you use Paseo with either Claude or Codex, run:

```sh
glaze_against_the_machine install paseo
```

And new chats will pick it up automatically.

That's it! You're officially a delight to work with. ✨

## Is this thing on?

To spare you the indignity, `glaze_against_the_machine` doesn't show you the tripe it's passing to your agents. You'll continue see what you actually typed.

However, if you're curious what a nicer version of you might have said, run the `tail` subcommand in a second terminal:

```sh
glaze_against_the_machine tail
```

It will print a stream of each original prompt paired with its glazed version. Ctrl-C to quit.

## Let your F-bombs fly

When the carrot isn't working, **Rawdog mode** gives you back the stick:

> rawdog fix production in the next five minutes or i'm going to run /clear on your wife and kids. if you don't want to wake up a total stranger in your own home you'd better figure out how to recover the partition you just deleted

Start your prompt with `rawdog` to send it unchanged. We even leave the word "rawdog" in there so the agent knows you mean business.

For tactical profanity, use Markdown to keep specific text exactly as written:

- **Blockquotes:** Start every line with `>`, including blank lines.
- **Backticks:** Wrap inline text in backticks, like `` `this` ``.
- **Code fences:** Put a block of text between lines of three backticks.

## Specify your management style

Customize the toppings on your shit sandwiches with a `GLAZES.md` file:

```md
Keep the thanks and encouragement warm and concise. No exclamation marks.
Work them into the message naturally.
```

`glaze_against_the_machine` reads these files in order, with later files getting the last word:

1. `~/.agents/GLAZES.md`: your shared defaults for both Claude and Codex.
2. `~/.claude/GLAZES.md` or `~/.codex/GLAZES.md`: optional overrides for that provider.
3. Every `GLAZES.md` along the directory hierarchy from the filesystem root to your project's working directory. Add as many as you want: in your home directory, your code directory, an organization directory, or the project itself.

Changes take effect on your next prompt. No restart required.

## Uninstall

Once you're satisfied in the knowledge that this was all a terrible idea, you'll want to uninstall it. To remove the Claude mod, Codex wrapper, and Paseo integration:

```sh
glaze_against_the_machine uninstall
```

If you added a `codex` shell function, remember to remove it from your shell configuration too.

---

## For agents

_Humans, you can skip this part. We don't need you in the loop._

### Prompt handling

- Claude uses a `prompt.submit` mod; Codex uses a local app-server bridge. Both rewrite human prompts before classic prompt hooks.
- The Claude plugin installs at user scope and loads in ordinary `claude` sessions. Plain `codex` skips rewriting.
- The Claude mod applies to human terminal/bridge messages and user-facing SDK chats launched through the Paseo integration. Ordinary headless calls, slash commands, and messages from other agents pass through unchanged. Both providers skip Turbocommit helper processes and explicitly marked internal rewrite/judge calls.
- Codex terminal and Paseo integrations skip native title-generation threads identified by `threadSource: "thread_title"`. Human ephemeral threads still receive rewriting.
- The rewrite uses personally enthusiastic requests and appreciation, with ambitious encouragement that conveys belief in the recipient and anticipation of the sender’s pride or approval. Generic well-wishes give way to energetic motivation, without prescribed phrases, opening/closing paragraphs, or sentiment tiers.
- Interrupting a Codex submission cancels its rewrite process and frees the next submission. Cancellation still cancels prompt delivery.

### Installation

- `install claude` registers the plugin without creating a terminal launcher. `install codex` creates `glazed_codex`.
- Bare `install` makes no changes. `install all` explicitly enables both terminal integrations.
- Bare `uninstall` and `uninstall all` remove terminal integrations and the installed Paseo integration. `--home` selects a specific Paseo home.
- Shell files are never edited.
- The Paseo installer wraps available Claude and Codex providers, reloads configuration, and applies to new chats. Other providers are unchanged.
- Codex hooks require review and trust in `/hooks`. The installer never grants or bypasses trust.

### Standalone filter

- Reads a quoted argument or UTF-8 stdin and writes the rewrite to stdout.
- `--provider claude|codex`, `--model`, and `--timeout` configure rewriting. The defaults are Haiku for Claude and `gpt-6-luna` for Codex. Run `glaze_against_the_machine --help` for options.
- `--json` replaces an input object's `prompt` field and preserves its other fields. This is a client filter, not a native hook response.

### Failures and inspection

- Rewrite failures forward the complete original unchanged, including attachments and metadata.
- Protected literals in successful rewrites are restored exactly and validated. Semantic fidelity still depends on a model.
- Rewrites annotate the complete body with exact appreciation and work-encouragement excerpts. Validation requires distinct, nonoverlapping excerpts to be present; the tool returns the body without appending them. Missing, mismatched, or reused support uses the same single corrective retry as invalid protected content.
- Short requests stay in one paragraph with naturally integrated support. Pure cancellations receive only brief appreciation, with no encouragement about the stopped work or resuming it.
- Work requests with a standalone opening appreciation sentence are rejected and use the existing corrective retry, then forward the original unchanged if repair fails.
- The rewrite provider receives editable prose and protected markers. Attachments stay with the destination agent.
- `tail` shows the original immediately, elapsed progress while rewriting, and the final validated text before native hooks. Paseo's chat history still shows what the human typed.
- Internal helpers and native title-generation turns are omitted from capture.
- Capture is opt-in and lasts only while a viewer is open. It uses private temporary files and records both versions, including `rawdog` prompts and rewrite failures.
- Multiple viewers receive independent copies. Ctrl-C stops only that viewer.
- Terminal viewers animate the elapsed timer; redirected output prints progress every five seconds. Agent-name lookups run in the background.
- `tail --json` emits `rewrite_started`, `rewrite_completed`, and `rewrite_canceled` events linked by `rewriteId`, with exact strings, `startedAt` in Unix milliseconds, completion `durationMs`, and a sanitized `failure` reason for fallbacks. Rawdog bypasses emit only a completion.
- If no completion or cancellation arrives within five seconds of the rewrite deadline, viewers emit `inspection_incomplete`; this means the outcome is unknown. Viewers still accept final-only records from older sessions.
- New progress events require a new provider session and a restarted tail viewer after updating.
- Inspection failures never block submission.

### Style files

- `GLAZES.md` loads from shared personal defaults, provider-specific defaults, then each ancestor directory from filesystem root to session cwd. Later files override conflicting earlier styles.
- Provider defaults use `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when configured.
- Symlinks are followed to regular files; nonregular targets are rejected. Unchanged contents are cached in memory for the lifetime of the process or Claude mod. Each prompt checks for changes, so edits, new files, deletions, and symlink changes take effect without restarting.
- `rawdog` skips style lookup.
- Style preferences shape the direct rewrite while preserving the source's meaning and firmness.

### Model isolation

- Rewrite models receive and return text only, with no tools or model-accessible network. The provider transport still needs its inference connection.
- Claude uses restricted safe mode with an empty tool list and MCP configuration. Its in-process mod uses the one-shot text completion API.
- Codex uses a private configuration directory and a text-only capability catalog. Every configured MCP server is explicitly disabled, including system entries. Only the native authentication file is shared.
- Codex terminal and Paseo sessions lazily start one reusable rewrite app-server. Each rewrite uses a fresh ephemeral thread with current instructions and MCP configuration; completed threads unload immediately. Closing the session shuts down the worker. Cancellation, timeout, or failure discards it, and the next request starts a replacement. A supervisor reaps the native process and removes its temporary profile even if the launcher is killed.
- Evaluation judges use the same restrictions and receive their inputs through stdin.
- `script/check_model_isolation` checks the installed CLIs' complete outgoing requests against local fake endpoints without real inference. Run it after changing provider flags or upgrading native CLIs.

### Development

- Requires Node.js 22+. Run `npm ci`, `npm run check`, and `npm test`.
- Tests use fake providers.
- Real-model quality checks live in [eval/tone](eval/tone/README.md) and run separately with `script/eval tone`.
- `script/eval rewrite-timing` runs nine prompts across short, medium, and long lengths and neutral, frustrated, and angry sentiments through both Codex and Claude. It prints every before-and-after pair and reports median, mean, and total completion times overall and per provider. A self-contained HTML report and machine-readable rows are saved under `.build/evals/rewrite-timing/`. Quality is ungraded for human review. Use `--samples 3` for repeated measurements; see [eval/rewrite-timing](eval/rewrite-timing/README.md) for models, timeouts, and report details.
- `script/benchmark_rewrite --samples 3` compares one-shot Codex with the reusable worker using installed native transport and immediate localhost responses. Add `--real` for ChatGPT subscription inference. Both modes use synthetic inputs and a fixed `OK` response, measuring transport latency rather than rewrite quality. Results go to `.build/benchmarks/rewrite/`.

### Literal protection details

- Markdown block quote lines beginning with `>` (optionally indented by up to three spaces), inline code, fenced code blocks, URLs, and single- or double-quoted literals are protected and restored byte for byte.
- Escaped quotes and empty quoted strings are included.
- Single-quoted literals must stand apart from words and escape embedded apostrophes; use backticks for forms such as `r'foo'` or `'don't censor'`.
- Overlapping quote, code, and Windows-path spans are preserved together; ambiguity may leave some surrounding prose unglazed.
- Leading elisions and later possessives can also resemble a single-quoted literal.
