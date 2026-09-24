# Changelog

All notable changes to the `delegate-fleet` skill.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this skill
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-09-24

### Added

- **Fix loop.** `--fix-attempts N` (0–3, or `fixAttempts` in config) re-runs the same worker with
  only the failing check tails when checks fail on a clean, completed run. It stops at any finding,
  at an attempt that changes nothing, or at N. Findings accumulate against the original baseline,
  usage is summed, and each attempt is listed in `result.attempts`.
- **Routes.** `routes` in config map a task class to ordered candidates that own the flags (model,
  effort, limits, fixAttempts). `--route <class>` takes the first candidate that is installed,
  capable, under its tier limit and not out of quota, and records the skipped ones in
  `result.route`.
- **Tier budgets.** `limits.runsPer24h` per tier. Routes skip a tier that is over its limit, and
  naming its worker directly is refused before dispatch.
- **Quota awareness.** A failed run whose output looks like an account limit marks the worker out of
  quota for 60 minutes (`.delegate-fleet/quota.json`), and routes skip it. `fleet.js quota` lists,
  marks and clears.
- **`batch.js`.** Runs a plan of slices in parallel, each in its own detached worktree, and returns
  one summary, a patch per slice and a landing order. Dependent slices start from commit objects
  built with plumbing: no ref moves and no hooks run. It warns when the main checkout changes during
  a batch. `--cleanup` removes only that batch's worktrees.
- **`fleet.js report`.** Worker runs, outcomes, tokens and USD per tier and per worker. Unreported
  usage is counted as unknown, never as zero.
- **`bench/`.** An A/B benchmark (solo orchestrator vs fleet) on a fixture project, scored with
  hidden acceptance tests and ranked by cost per accepted run. The contract tests prove that every
  task fails untouched and passes its reference solution.
- **`tests/smoke.js`.** An opt-in run of a tiny brief through every installed real CLI. It proves
  the argv, the permission mode and the output parsing against the real thing.
- `relay.js --state-root` keeps the ledger in one checkout while slices run in others.

### Changed

- SKILL.md is rewritten around the cost workflow (routes, checks, the fix loop, batch) and trimmed
  from 261 to about 150 lines. The detail moved to `references/routing.md`, `references/batch.md`
  and the result contract.
- The skill description now also triggers on offloading implementation to cheaper models and on
  parallel slices.
- Recommended brief size is 15–60 lines.
- Unknown top-level keys in `config.json` are rejected.

## [2.2.0] - 2026-09-24

### Added

- **Worker report.** `result.worker` carries the worker's final message (capped at 2 KB, tail kept),
  its session id, and token usage and cost, parsed from JSON results or JSON-lines streams with a
  plain-text fallback. Adapters may export `parseReport(stdout)`. Self-reported; never affects
  `status`, `findings` or `blocked`.
- **`--check "<command>"`.** The relay runs orchestrator-named gates after a `completed` edit run,
  without a shell, and records pass/fail plus a 40-line tail in `verification.checks`; full output
  goes to `check-<n>.log`. A failing check blocks the result. `--check-timeout` bounds each one.
- **Cost tiers.** `workers.<id>.tier` (`cheap`, `standard`, `premium`) in config. `fleet.js select`
  lists capable workers cheapest first and `--max-tier` drops pricier ones. The tier is recorded on
  `result.backend.tier`.

### Changed

- Worker selection is capability first, then cost. The skill now tells the orchestrator to route
  mechanical slices to the cheapest capable tier and to read `worker` and `verification.checks`
  instead of raw logs.

## [2.1.0] - 2026-09-22

### Added

- **Operational controls.** `--max-turns` and `--max-budget-usd` options with first-class `turnLimit`
  and `budgetLimit` capabilities, supported on `grok` and `claude` respectively.
- **Worker configuration defaults.** Per-worker defaults for `maxTurns` and `maxBudgetUsd` in
  `.delegate-fleet/config.json`, validated at load time and overridable via CLI flags.
- **Live streaming.** `--stream` tees worker stdout and stderr chunks in real time to relay stderr
  while keeping stdout pure JSON for automation pipelines.
- **Safe live progress logging.** Live logs write to a private temporary directory outside the
  workspace during execution (`delegate-fleet-live-`), copying to run artifacts only after the
  post-run snapshot to eliminate snapshot pollution.
- **Pre-dispatch banner.** Non-`--json` invocations report backend ID, resolved executable path,
  mode, timeout, and the live log location before dispatching.
- **`framework_state_modified` finding.** Detects worker modifications or creations under
  `.delegate-fleet/` (outside `runs/`), such as config mutations or planted adapters, even in
  repositories where `.delegate-fleet/` is gitignored.

### Changed

- **Trigger precision.** Skill description rewritten to focus on bounded delegation and independent
  diff verification, removing vendor rosters and generic keywords that caused false activations.
- **Open-source test suite.** Renamed internal defect/task test titles across the contract test
  suite to describe the exact behaviour proven.
- **Complete result taxonomy documentation.** Documented all nine process statuses (including
  `launch_failure` and `aborted`) and all six repository findings (including `worker_stash` and
  `framework_state_modified`) across `SKILL.md` and reference guides.

### Fixed

- **Read-only authorization at trust boundary.** Read-only dispatch and verified-only selection
  re-probe the installed CLI, preventing hand-edited or stale `verification.json` files from
  authorizing read-only runs.
- **Fresh probe reflection.** `backend.capabilitiesVerifiedLocally` reports `true` in result JSON
  when the relay's fresh probe verified read-only without requiring a pre-existing `doctor` record.
- **Evidence preservation.** Probes with empty `--help` and `--version` output preserve evidence
  when `evidenceArgs` probes return non-empty output.
- **Dirty-tree & framework snapshot resilience.** Planted FIFOs fail closed, symlinked directories
  under `.delegate-fleet/` are not traversed, and unreadable files or submodules poison the
  snapshot rather than reporting a false clean status.
- **Recorded unsupported precedence.** A recorded `unsupported` read-only status cannot be bypassed
  by `--allow-unverified` when a fresh probe is inconclusive.
- **Adapter validation.** OpenCode validates `plan` agent availability via `evidenceArgs`, Grok
  probes exact option values, and adapters declaring capabilities must express them in `build()`.

## [2.0.0] - 2026-09-21

A rewrite around a capability-based core. The previous cost-tier model was removed entirely.

### Added

- **Capability model.** Workers are selected by what they can do — `edit`, `readOnly`,
  `resumeById`, `modelSelection`, `effort`, `structuredOutput` — with an explicit evidence state per
  capability (`verified` / `documented` / `unsupported` / `unknown`).
- **Three separate questions.** *Supported* by the framework, *available* on this machine, and
  *verified* for the installed version are tracked independently. A backend is never removed
  because its CLI is absent locally.
- **`fleet.js doctor`.** Runs each installed CLI's own help and records observed capabilities,
  promoting a documented claim to verified and demoting a wrong one.
- **`fleet.js select --need`.** Lists available workers satisfying a capability set.
- **Safety gate on read-only.** A read-only run is refused unless that backend's read-only is
  verified on this machine; `--allow-unverified` accepts the risk explicitly.
- **Content-addressed repository snapshots.** Pre-existing uncommitted work is distinguished from
  worker changes, including further edits to a file that was already modified.
- **Failure taxonomy.** `invalid_request`, `backend_unavailable`, `launch_failure`, `timeout`,
  `aborted`, `process_failure`, `implementer_failure`, `noop`, `completed`, kept separate from
  repository findings (`scope_violation`, `unexpected_repository_change`, `worker_commit`,
  `worker_stash`, `read_only_violation`).
- **20 backends** as explicit one-file adapters, plus third-party adapters loaded from
  `.delegate-fleet/adapters/*.js` without forking.
- **Prompt delivery modes** (`argv` / `stdin` / `file`) for CLIs that cannot take a brief in argv.
- **62 contract tests** covering dirty-tree attribution, process-tree termination, shell-injection
  resistance, concurrency, and every configuration option reaching the backend invocation.

### Changed

- The result contract is versioned (`schemaVersion: 2`) and separates process facts from repository
  facts, with a mechanical `blocked` flag.
- The relay never verifies and never accepts; `acceptance.accepted` is always `null`.
- Non-negotiable constraints are injected into every prompt rather than linted for in the brief.
- Briefs use `# Objective` / `## Scope` / `## Acceptance criteria`.

### Removed

- **Cost tiers** (`free` / `budget` / `premium`) and all routing built on them. Cost is not a
  property of a binary, and the orchestrator cannot verify it.
- **`ollama` as a backend.** `ollama run` has no file tools and cannot implement a slice. Local
  models are reached through a provider-agnostic backend's `--model` instead.

### Fixed

Found by adversarial review of this rewrite, before release:

- **`verified` could be self-asserted.** An adapter declaring a capability as `verified` satisfied
  the safety gate with no local evidence at all, so `--read-only` dispatched on eight backends
  without `doctor` ever running. A declared `verified` is now downgraded to `documented` until
  local evidence exists, so `verified` can only come from `doctor`.
- **A probe could promote a capability the invocation drops.** `probe()` reads help text, which
  says which flags *exist*, not which ones the adapter passes. Probe output is now clamped to what
  `build()` actually reads, which closes the same "parsed then silently discarded" class of defect
  on `copilot`, `crush`, `kimi`, `warp`, `vibe` and `zcode`.
- **Read-only that only omitted a write flag.** An adapter that dropped its `--yes` and trusted the
  CLI's default was accepted as read-only. A read-only invocation must now carry an argument the
  edit invocation does not, checked mechanically.
- **Probes that matched a flag rather than the value `build()` emits.** Tightened for `claude`
  (`acceptEdits`), `qwen` and `qoder` (the write mode), `grok` (`--sandbox read-only`), `cline`
  (`--plan` *and* `--auto-approve`) and `opencode` (the `plan` agent must exist, now verified via
  `evidenceArgs`). Where a flag exists but the help never names the value, the state is `unknown`
  rather than a false `unsupported`.
- **`structuredOutput` was unchecked.** It has no per-run switch, so nothing caught an adapter that
  claimed it and then asked for a human-readable stream. The built invocation must now contain a
  token naming JSON; `vibe` was claiming it while emitting `--output streaming`, and is corrected
  to `unsupported`. `readOnly` is enforced the same way at load time, not only when clamping.
- **A failed probe inside a nested repository became a stable hash.** If `HEAD` read but `git
  status` timed out, the submodule hashed identically before and after a run and hid every edit
  inside it. Such a path now poisons the snapshot, so the repository reports as unobserved.
- **A config file that could not be read was treated as absent.** `EACCES` or `EISDIR` silently
  became "use the defaults", running with options the user did not configure. Only `ENOENT` is
  absence.
- **Verification survived a change of executable.** Evidence was keyed by backend id, so pointing
  `cli` elsewhere kept applying the old record. Records now carry an identity for the binary they
  were taken from — path, size and mtime, one stat rather than a process spawn — and are discarded
  when it no longer matches, which also covers an upgrade that replaces the binary in place. A
  record that identifies no executable is unusable. `doctor` deletes a record when re-verification
  fails instead of leaving stale evidence behind.
- **Worker writes under `.delegate-fleet/` were filtered out of scope reconciliation.** A worker
  could plant `.delegate-fleet/adapters/*.js` with no finding raised, and the next run would
  `require()` it. Nothing is filtered from the diff any more.
- **Config defaults bypassed the capability check.** `model` or `effort` from
  `.delegate-fleet/config.json` was applied after validation and reached the invocation unchecked.
- **An unobserved repository reported as clean.** When git could not be read, `blocked` was
  `false` although scope, noop and commit detection were all disabled.
- **A first commit in a repository with an unborn HEAD was not detected** as a worker commit.
- **Same-size rewrites of files over 16 MiB were invisible**, because the hash fell back to size
  and mtime. Files are now hashed in bounded chunks regardless of size, and a submodule is
  addressed by its own HEAD and status instead of a constant.
- **A deny marker outranked a real process failure**, so a crash that printed "permission denied"
  was reported as a refusal. Deny markers now classify a cooperative exit 0 only.
- **A read-only violation omitted rename endpoints**, naming no paths at all for a pure rename.
- **A scope of `.` marked every change out of scope.**
- **A nested `### Scope` shadowed the real `## Scope`**, reconciling the run against the wrong
  paths. Only `#` and `##` are section headings now.
- **An empty `## Acceptance criteria` passed the brief lint**, dispatching with no oracle.
- **A malformed `config.json` was treated as absent**, so a mistyped config silently became
  defaults. Invalid JSON, a non-object root and a non-object `workers` are all errors now.
- **`doctor` recorded capabilities from a failed `--help`**, treating crash output as evidence.
- **`fleet.js --backend` with no value silently widened a targeted run to the whole fleet.**
- **Captured worker output was capped in UTF-16 code units and decoded per chunk**, so the cap
  varied by alphabet and any multi-byte character crossing a chunk boundary was corrupted.
- **An unreadable `.delegate-fleet/adapters/` was treated as absent**, silently ignoring a
  project's adapter override.
- **`opencode` was invoked without `--dir`.** It does not take the spawned process cwd as its
  project root, so it resolved relative paths against its own last-used project — reading and
  writing a repository the relay was not observing.

Defects carried from 1.0.0, each now covered by a test:

- `fleet.json` `cli` override was ignored; every adapter hardcoded its command name.
- `fleet.json` `model` was parsed and never used.
- `--read-only` was a no-op on `opencode`, `crush`, `aider` and `ollama` — only the prompt changed.
- `--session` was parsed, documented, and silently discarded.
- `--timeout` was unvalidated; `NaN` killed the worker immediately.
- A file already dirty before dispatch and edited further by the worker was invisible to the
  status-code-only baseline.
- Renames in `git status` porcelain were parsed as a single malformed path.
- A worker commit was inferred from vanished files rather than from HEAD movement.
- `opencode` write runs omitted `--auto` and would stall on a permission prompt.

## [1.0.0] - 2026-09-20

- Initial release: cost-tier routing, `discover.js` and `relay.js`.
