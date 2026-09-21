---
name: delegate-fleet
description: Use when implementation work should be delegated to another coding-agent CLI — when the user asks to delegate, use a worker model, run a fleet of agents, parallelize implementation, or hand mechanical work to Codex/Claude/Cursor/OpenCode/Gemini/Antigravity/Grok/Kimi/GLM/Copilot/Aider and similar CLIs. Plans and reviews on the orchestrator, implements on a capability-matched worker, and verifies every diff independently before it lands.
license: MIT
metadata:
  version: "2.0.0"
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

---

## 1. Know your fleet

```bash
node <skill>/scripts/fleet.js discover     # supported vs available here
node <skill>/scripts/fleet.js doctor       # verify what the installed CLIs really support
```

`doctor` runs each installed CLI's own `--help` and records what it observes. It **promotes** a
documented claim to `verified` and **demotes** one that turns out to be wrong. Run it once per
machine, and again after any CLI upgrade.

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
`effort`, `structuredOutput` — and take any available worker that has it. If nothing satisfies the
need, that route is closed: say so rather than downgrade the requirement silently.

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

## 6. Read the result — status and findings are different questions

`status` is what happened to the process. `findings` are what happened to the repository. A run can
exit 0 and still be blocked.

| status | What it means |
| --- | --- |
| `completed` | The process succeeded and something changed |
| `noop` | Exit 0 on an edit run, tree unchanged — treat as a silent refusal |
| `implementer_failure` | Exit 0, but the worker refused or could not authenticate |
| `process_failure` | Non-zero exit or a fatal signal |
| `timeout` / `aborted` | The relay killed it; **partial edits are likely** |
| `backend_unavailable` | Supported, but its CLI is not installed here |
| `invalid_request` | Refused before dispatch; nothing ran, nothing was spent |

| finding | What you must do |
| --- | --- |
| `scope_violation` | Inspect each path. Never auto-revert |
| `unexpected_repository_change` | The worker touched work that was already uncommitted. Say so immediately |
| `worker_commit` / `worker_stash` | The worker took ownership it does not have. Report before anything else |
| `read_only_violation` | An analysis run wrote. Treat the backend's read-only claim as broken |

`blocked` is `true` whenever the status is not `completed` or any finding is present. It is
arithmetic, not judgement.

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
