# Changelog

All notable changes to the `delegate-fleet` skill.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this skill
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
