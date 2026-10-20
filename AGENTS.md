# Release

Distribute through `searlsco/homebrew-tap`, with GitHub source archives.
There is no npm publication or build step. npm is used for runtime dependencies
and development checks.

1. Synchronize `main` and choose the next version. Keep `package.json`, both
   version fields in `package-lock.json`, `.claude-plugin/plugin.json`, and
   the client version in `src/codex-text-worker.js` consistent.
2. Commit and push the version changes, then tag that commit `v<version>` and
   push the tag. Never move an existing release tag.
3. `.github/workflows/release.yml` validates versions, installs dependencies,
   runs syntax checks and tests, creates a GitHub release, then calls
   `update_homebrew_formula.yml` to render `homebrew/glaze_against_the_machine.rb.in`
   with the tag's URL and SHA-256 and commit it to the tap. This also creates
   the formula on the first release.
4. Wait for the release workflow, then verify with `brew update`,
   `brew install searlsco/tap/glaze_against_the_machine` (or `brew upgrade`),
   and `brew test searlsco/tap/glaze_against_the_machine`.

The organization secret `HOMEBREW_TAP_TOKEN` must be available to this repository
and grant Contents write access to `searlsco/homebrew-tap`. The workflow's
`GITHUB_TOKEN` creates releases only in this repository.

If a tap update fails after the release is created, rerun the failed job or
dispatch `update_homebrew_formula.yml` with its `tag` input set to the existing
release tag. Do not publish another version just to retry a tap update.

The formula must include `.claude-plugin` as well as `bin`, `src`, `hooks`,
package metadata, and installed runtime dependencies. Do not configure agents
or change shell files as part of a Homebrew installation.

The Homebrew entry point sets `GLAZE_AGAINST_THE_MACHINE_ROOT` and
`GLAZE_AGAINST_THE_MACHINE_NODE` to stable `opt` paths. Preserve these in
generated terminal and Paseo launchers so upgrades and keg cleanup do not
break integrations. Other installations default to the current source root
and Node executable.
