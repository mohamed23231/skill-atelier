# Architecture

Five layers, each answering one question. Keeping them apart is the whole design.

| Layer | Question | Where | Changes when |
| --- | --- | --- | --- |
| Backend definition | What is this worker? | `scripts/adapters/<id>.js` | a new CLI is supported |
| Backend adapter | How do I invoke it? | the same file's `build()` | that CLI's flags change |
| Capability declaration | What can it do, on what evidence? | the same file's `capabilities` | reality changes |
| Environment discovery | Is it installed *here*? | `lib/environment.js`, at runtime | per machine |
| Local verification | What does the *installed version* do? | `.delegate-fleet/verification.json` | you run `doctor` |

A backend is **supported** by the framework on every machine. **Available** is a runtime property of
one machine. **Verified** is a property of one installed version. An absent CLI is `unavailable`, and
nothing is ever deleted because of it.

## Responsibilities

```
ORCHESTRATOR          judgement: plan, brief, select, verify, accept, commit
    │
  RELAY               facts: bounded execution + repository observation
    │
  WORKER              execution capacity, replaceable
```

The relay is deliberately boring and deterministic. It contains no model, makes no quality
judgement, and has no opinion about whether work should be accepted. Everything it reports is
mechanically derived from a process outcome or from two git snapshots.

## What the relay guarantees

1. **The worker is launched without a shell.** `spawn` with an argv array, `shell: false`. No brief
   content can ever be interpreted as a shell metacharacter.
2. **Pre-existing work is distinguished from worker work.** A content-addressed snapshot is taken
   before and after. A file that was already `M` and is edited further is still detected — a
   status-code-only baseline cannot see that, and that blind spot is how a worker quietly mangles
   uncommitted work.
3. **The repository is never modified by the relay.** It never commits, resets, checks out, stashes
   or cleans. Not on success, not on failure, not on timeout.
4. **Bounded execution.** A validated timeout, a watchdog, and a kill that reaches the whole process
   group so a grandchild cannot outlive the run or hold the pipe open.
5. **Scope is reconciled, not enforced.** Changes outside the brief are reported as
   `scope_violation`. The relay does not revert them, because deciding what to do with them is the
   orchestrator's job.
6. **The exit code is never trusted alone.** Several CLIs exit 0 after refusing, after signing out,
   or after silently falling back. Status is derived from the outcome, the output markers, and the
   tree.
7. **Artifacts cannot pollute the observation.** They are written only after the post-run snapshot,
   so they never appear in the diff. Framework state under `.delegate-fleet/` (such as `config.json`
   and `adapters/`) is tracked explicitly even when git ignores that directory. A worker creating or
   modifying framework state raises `framework_state_modified` and is blocked automatically,
   preventing a worker from silently planting an adapter that the next run would load with `require()`.

## What the relay explicitly does NOT guarantee

- **Containment.** A write run is as wide as the backend's own permission model. When writes outside
  the target tree are unacceptable, use a git worktree, a container, or a backend whose read-only is
  an OS sandbox. `codex` is the only supported backend whose read-only is sandbox-enforced rather
  than a withheld tool surface.
- **Visibility of other untracked-and-ignored writes.** Repository facts mostly come from `git status`.
  The framework state tracking under `.delegate-fleet/` is explicit; other gitignored paths outside
  framework state and writes outside the repository root are not observable.
- **That the worker told the truth.** Its final message is evidence, not fact. The diff is fact.

## Parallelism

Run slices sequentially in one working tree by default. Concurrent runs need **separate workspaces**
(git worktrees): scope reconciliation is baseline-based, and two writers in one tree make every
finding unattributable. Concurrency across separate workspaces is tested and safe.
