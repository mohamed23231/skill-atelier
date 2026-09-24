---
name: delegate-fleet
description: Dispatches bounded implementation slices to external coding-agent CLIs (such as Claude Code or Codex) and verifies their diffs independently before landing. Use when explicitly asked to delegate work via delegate-fleet, dispatch tasks through the relay, perform capability-based worker selection, inspect installed workers with fleet.js doctor, or run a sub-task through an external agent CLI while keeping planning, review, and git commits on the orchestrator.
license: MIT
metadata:
  version: "2.1.0"
---

# Delegate Fleet

**One brain. Many workers. You own the decision.**

You are the orchestrator. You analyze, plan, brief, verify, and commit. A worker is replaceable
execution capacity. The relay is the trust boundary between you, and it reports facts — never
opinions about whether the work is good.

```
ORCHESTRATOR ── plan ── brief ── select worker by capability
                                        │
                                     DISPATCH
                                        │
                                     WORKER
                                        │
                                       RELAY  ← the trust boundary
                               ┌─────────┴─────────┐
                         execution facts     repository facts
                               └─────────┬─────────┘
                                  STRUCTURED RESULT
                                        │
                               INDEPENDENT VERIFICATION  ← you, not the worker
                                        │
                           ACCEPT ─── RETRY ─── ESCALATE
                              │
                           COMMIT  ← only ever you
```

Three separate questions, never conflated:

| Question | Answer lives in | Command |
| --- | --- | --- |
| Is this backend **supported**? | the framework's adapter registry | always yes, on every machine |
| Is it **available** here? | this machine, at runtime | `fleet.js discover` |
| What can the **installed version** really do? | recorded local evidence | `fleet.js doctor` |

### When NOT to use delegate-fleet

- **You have not planned yet.** If you cannot specify the exact files, patterns, and acceptance criteria from memory, do not delegate. Planning belongs on the orchestrator.
- **Trivial edits.** Small, single-line or single-file fixes take fewer tokens and less time to apply directly in your session than writing a brief and running an external process.
- **Interactive or exploratory debugging.** Tasks requiring rapid multi-turn dialogue, live browser inspection, or open-ended trial-and-error.
- **Concurrent runs in the same workspace.** Two workers editing the same working tree make diffs and findings unattributable. Use separate git worktrees (`--workspace`) for concurrent runs.
- **Strict filesystem sandboxing is required** but the chosen backend only provides withheld tool surfaces.

---

## 1. Know your fleet

```bash
node <skill>/scripts/fleet.js discover     # supported vs available here
node <skill>/scripts/fleet.js doctor       # verify what the installed CLIs really support
```

- `discover` inspects the environment at runtime: checks whether the CLI executable is installed on PATH (or configured in `config.json`), without running active probes. It matches the CLI against saved verification records if present and still matching the executable.
- `doctor` actively executes probe commands (`--help`, `--version`, and optional `evidenceArgs`) against each installed CLI on this machine, recording findings in `.delegate-fleet/verification.json`. It **promotes** a documented claim to `verified` and **demotes** one that turns out to be wrong. Run it once per machine, and again after any CLI upgrade.

### Four evidence states

Every capability claim has an explicit evidence state:
- `verified`: Proven locally by a probe of the installed CLI on this machine.
- `documented`: Sourced from vendor documentation or upstream claims; plausible, but not yet proven here.
- `unsupported`: The CLI genuinely cannot perform this capability.
- `unknown`: State not established; never treated as supported.

**`verified` requires a local CLI probe.** `doctor` records probe results for discovery, while
read-only dispatch and `select --verified` probe again at dispatch before relying on them. An adapter file
records what its author checked on their machine, so without local evidence its claim reads as
`documented`. A declaration cannot verify itself. Evidence is tied to one executable identity (path, size, mtime): change a
backend's `cli` or replace the binary, and the old record is discarded.

A backend that is not installed here is `unavailable`, never unsupported. Say that plainly instead of
silently substituting a different worker.

## 2. Plan before you delegate

Decide the approach yourself: files, patterns, interfaces, the order of slices. A worker implements
*your* plan; it does not architect. If you cannot write the file list from memory, go read the code
first — you have not planned yet.

Slice so each slice is independently verifiable and independently revertable. One slice, one brief,
one run.

## 3. Select by capability, never by reputation or price

```bash
node <skill>/scripts/fleet.js select --need edit,readOnly --verified
```

Ask for the behaviour the slice needs — `edit`, `readOnly`, `resumeById`, `modelSelection`,
`effort`, `structuredOutput`, `turnLimit`, `budgetLimit` — and take any available worker that has it. If nothing satisfies the
need, that route is closed: say so rather than downgrade the requirement silently.

### Read-only vs edit runs

- **Edit runs** (`mode: "edit"`, default): Expect code modifications within declared scope. If exit code is 0 but the tree is unchanged, the relay reports `noop` (treated as a silent refusal until the log says otherwise).
- **Read-only runs** (`--read-only`, `mode: "read-only"`): Enforce analysis-only execution using backend restriction flags (e.g. `--sandbox read-only`, `--agent plan`, `--plan`). If any workspace file is created, modified, deleted, or renamed, the relay records a `read_only_violation` finding and blocks the result.
- **Why `--read-only` is refused when unverified**: Prompt wording alone does not prevent writes. A review run that modifies code can quietly destroy uncommitted work. The relay refuses `--read-only` unless that backend's read-only enforcement has been verified by a local probe on this machine. `--allow-unverified` explicitly downgrades this refusal to a warning when you choose to accept the risk.

Announce the choice in one line before dispatching, so the user can veto:

> Dispatching slice 2 to `opencode` — mechanical CRUD wiring; needs `edit` only.

## 4. Write a bounded brief

The worker starts with **zero** conversation history. The brief is the entire contract. Required
sections are `# Objective`, `## Scope`, `## Acceptance criteria`; see
[`references/brief-format.md`](references/brief-format.md).

You never write the safety rules — the relay injects them into every run, so they cannot be
forgotten. The backtick-quoted paths under `## Scope` are what scope violations are measured against,
so write them precisely.

## 5. Dispatch

```bash
node <skill>/scripts/relay.js --backend opencode --brief .delegate-fleet/briefs/slice-2.md \
  --workspace "$PWD" --json > /tmp/slice-2.json
```

Run it in the background for anything slow, tell the user which worker has which slice, and keep
working. `--dry-run` prints the exact argv first. Details in
[`references/dispatch.md`](references/dispatch.md).

### Operational controls

- `--timeout <seconds>`: Watchdog timer (default 1200, max 86400). When it fires, the relay terminates the entire process tree. Honoured for all backends.
- `--max-turns <n>`: Caps the number of agent turns. Honoured by backends with `turnLimit` (`grok`). Rejected before dispatch on backends that lack it.
- `--max-budget-usd <n>`: Caps spend in USD. Honoured by backends with `budgetLimit` (`claude`). Rejected before dispatch on backends that lack it.
- `--stream`: Tees worker stdout and stderr chunks in real time to relay stderr while leaving stdout clean for JSON parsing. Honoured for all backends.
- Per-worker defaults can be set in `.delegate-fleet/config.json` (`timeoutSeconds`, `maxTurns`, `maxBudgetUsd`, `model`, `effort`, `cli`). Command-line flags override defaults.

### Installation and project adapters

Install the skill by copying `skills/delegate-fleet/` into `.agents/skills/delegate-fleet` (or your client's skills directory).

Project-supplied adapters live in `<workspace>/.delegate-fleet/adapters/<id>.js`. The relay and `fleet.js` discover them automatically, validate them with the same `assertShape` rules as built-in adapters, and allow you to add custom backends or override built-in ones without modifying the skill repository.

## 6. Read the result — status and findings are different questions

`status` is what happened to the process. `findings` are what happened to the repository. A run can
exit 0 and still be blocked.

| status | What it means |
| --- | --- |
| `completed` | The process succeeded and changes were made |
| `noop` | Exit 0 on an edit run, tree unchanged — treat as a silent refusal |
| `implementer_failure` | Exit 0, but the worker refused or could not authenticate |
| `process_failure` | Non-zero exit or a fatal signal |
| `timeout` | The relay watchdog fired; **partial edits are likely** |
| `aborted` | The relay was killed and forwarded the kill; **partial edits are likely** |
| `launch_failure` | The worker process could not be started |
| `backend_unavailable` | Supported by the framework, but its CLI is not installed here |
| `invalid_request` | Refused before dispatch; nothing ran, nothing was spent |

| finding | What you must do |
| --- | --- |
| `scope_violation` | Inspect each path. Never auto-revert |
| `unexpected_repository_change` | The worker touched work that was already uncommitted. Say so immediately |
| `worker_commit` | The worker took ownership it does not have. Report before anything else |
| `worker_stash` | The stash ref moved during the run. Report before anything else |
| `read_only_violation` | An analysis run wrote. Treat the backend's read-only claim as broken |
| `framework_state_modified` | The worker modified framework state under `.delegate-fleet/` (outside `runs/`), such as config or adapters |

`blocked` is `true` whenever the status is not `completed`, any finding is present, or the repository could not be observed (`repository.observed === false`). It is arithmetic, not judgement.

## Dirty-tree protection and honest limits

The relay takes content-addressed snapshots before and after execution:
- **What it catches**:
  - Differentiates pre-existing uncommitted changes from worker changes. A file already dirty before dispatch and edited further by the worker is detected (`unexpected_repository_change`).
  - Detects out-of-scope creations, edits, deletions, and renames (`scope_violation`).
  - Catches worker git operations (`worker_commit`, `worker_stash`).
  - Catches writes to framework configuration or planted adapters under `.delegate-fleet/` even in repositories where `.delegate-fleet/` is gitignored (`framework_state_modified`).
- **Honest limits**:
  - Gitignored files outside `.delegate-fleet/` are not tracked by git snapshots and cannot be observed.
  - Filesystem modifications outside the repository workspace are unobserved.
  - Containment: The relay does not sandbox worker processes. A worker run with `--auto` or `--yolo` has whatever permissions the running user has. Only `codex` has OS-level sandbox enforcement (`--sandbox read-only`); all other backends enforce read-only by withholding tool access. When strict containment is required, use separate git worktrees or container isolation.

## 7. Verify independently — this is never delegated

The worker says "I implemented it." The relay says "here are the facts." **You** decide.

1. Read the diff yourself, in full. `status: completed` is a claim about a process, not about quality.
2. Run the project's own gates — tests, typecheck, lint, build — on the changed files.
3. Only then commit. The worker never commits; if it did, that is a finding, not a shortcut.

See [`references/verification.md`](references/verification.md).

## 8. Accept, retry, or escalate

Different failures need different decisions — this is why the taxonomy is not collapsed into "failed":

- `noop` → read the log. Usually a brief problem, not a model problem.
- `timeout` → inspect the tree **before** re-dispatching; partial edits are likely.
- `scope_violation` → inspect and decide; never blanket-revert.
- `process_failure` → read the worker's own error in `stderr.log` first.
- A failed run is retried with a **better brief on the same worker** before escalating. A bad brief
  fails on every model; escalation without a changed brief buys the same failure.

---

## Hard rules

- The orchestrator owns review, acceptance, the commit, and the revert. Always.
- Never report a run as successful without reading its diff, whatever the exit code said.
- Never delegate the review of a diff to the worker that produced it.
- Files outside the brief are a finding, not a bonus. Report them; never quietly revert them.
- Never destroy pre-existing uncommitted work, and never `git reset`/`checkout` to tidy up a worker.
- `--read-only` is only honest when the backend's read-only is verified here. Do not paper over it
  with prompt wording.
- Paste the project's own rules into the brief. Workers do not read your agent files.

## Files

- `scripts/relay.js` — dispatch one brief, bounded, and report facts.
- `scripts/fleet.js` — `discover`, `doctor`, `select`, `init`.
- `scripts/adapters/` — one small file per backend: how to invoke it, what it can do, on what evidence.
- `scripts/lib/` — capability model, environment, brief, repository facts, execution, result contract.
- `references/architecture.md` — the five layers and what each guarantees.
- `references/brief-format.md` — the brief template and what is linted.
- `references/result-contract.md` — every field, every status, every finding.
- `references/backends.md` — the supported backends and their honest limits.
- `references/verification.md` — the review checklist you run yourself.
- `references/extending.md` — add a backend in one file, without forking.
