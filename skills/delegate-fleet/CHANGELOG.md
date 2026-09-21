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
