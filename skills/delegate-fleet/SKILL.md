---
name: delegate-fleet
description: Plans on the orchestrator and dispatches bounded implementation slices to cheaper external coding-agent CLIs (Claude Code, Codex, OpenCode, Gemini and more), runs the project's checks, loops failures back to the same worker, and verifies every diff independently before landing. Use when asked to delegate or offload implementation to worker CLIs or cheaper models, to run independent slices in parallel worktrees, to route work by task class or cost tier, or to use delegate-fleet's relay, batch, select, report or doctor commands. Planning, review and git commits stay on the orchestrator.
license: MIT
metadata:
  version: "2.3.0"
---

# Delegate Fleet

**One brain. Many workers. You own the decision.**

You plan, brief, verify and commit. Workers are replaceable, cheaper execution capacity. The relay
between you reports facts — process outcome, repository changes, check results — never opinions.
The point is economic: your expensive tokens go to judgement, the workers' cheap tokens go to typing.

```
YOU: plan ─ slice ─ brief ─┬─ relay --route <class> --check … --fix-attempts N   (one slice)
                           └─ batch.js plan.json                                  (independent slices, parallel worktrees)
RELAY: worker runs → checks run → failing tails go back to the SAME worker (bounded) → facts
YOU: read summary + checks → read the diff → accept, retry with a better brief, or do it yourself → commit
```

## When NOT to use it

- **You have not planned.** If you cannot name the files, the pattern and the acceptance criteria, read
  the code first. Planning never leaves the orchestrator.
- **The change is small or read-heavy.** A one-file fix, or a task that is mostly reading code, costs
  less to do yourself than to brief, dispatch and review.
- **Exploratory debugging.** Rapid trial and error needs a live loop, not a brief.
- **Two workers, one working tree.** Findings become unattributable. Use `batch.js`, which gives each
  slice its own worktree.

## 1. Know the fleet (once per machine)

```bash
node <skill>/scripts/fleet.js discover   # every supported backend, and which are installed here
node <skill>/scripts/fleet.js doctor     # probe installed CLIs; records what they really support
node <skill>/scripts/fleet.js init       # starter .delegate-fleet/config.json
```

Supported (the framework has an adapter), available (installed here) and verified (probed here) are
separate facts. A missing CLI is `unavailable`, never unsupported — say so rather than silently
substituting. Evidence states and probing: [`references/backends.md`](references/backends.md).

## 2. Configure routes — the model classifies, code owns the flags

In `.delegate-fleet/config.json`, tag each worker with a cost `tier` and map task classes to ordered
candidates. You then name a class; the config decides backend, model and effort.

```json
{
  "workers": { "opencode": { "tier": "cheap" }, "codex": { "tier": "standard" }, "claude": { "tier": "premium" } },
  "routes": {
    "mechanical": [{ "backend": "opencode", "model": "deepseek/deepseek-chat" }, { "backend": "codex", "effort": "low" }],
    "moderate":   [{ "backend": "codex", "effort": "medium", "fixAttempts": 2 }]
  },
  "limits": { "runsPer24h": { "premium": 3 } }
}
```

A route takes its first candidate that is installed, has the capabilities the run needs, is under its
tier's 24-hour limit, and is not marked out of quota. Workers whose output says they hit a usage
limit are marked for an hour automatically (`fleet.js quota`). Details:
[`references/routing.md`](references/routing.md).

- **Mechanical** (renames, wiring, CRUD, tests from a spec) → a `cheap` route.
- **Moderate** (a contained feature with a pattern to copy) → a `standard` route.
- **Judgement-heavy** → do not delegate it.

## 3. Write a bounded brief

The worker starts with **zero** history; the brief is the whole contract. Required: `# Objective`,
`## Scope` (backtick-quoted paths — scope violations are measured against them), `## Acceptance
criteria`. Keep it a card, not an essay: 15–60 lines. Paste the project rules that apply; workers do
not read your agent files. The relay injects the safety rules itself. Template:
[`references/brief-format.md`](references/brief-format.md).

## 4. Dispatch

One slice:

```bash
node <skill>/scripts/relay.js --route mechanical --brief .delegate-fleet/briefs/slice-2.md \
  --workspace "$PWD" --check "pnpm typecheck" --check "pnpm test -- src/settings" --fix-attempts 2 --json
```

- `--check` runs a gate after a completed run, without a shell (use a script for `&&` or pipes). Only a
  40-line tail reaches you; the full log is an artifact. A failing check blocks the result.
- `--fix-attempts N` (0–3) sends failing tails back to the **same** worker. It stops at any finding, at
  an attempt that changes nothing, or at N.
- `--backend <id>` instead of `--route` names a worker directly. `--dry-run` prints the exact argv.

Independent slices, in parallel, each in its own worktree:

```bash
node <skill>/scripts/batch.js .delegate-fleet/plan.json
```

A slice with `dependsOn` starts from its dependencies' results. You get one table, a `.patch` per
slice, and the landing order. Nothing lands on its own. Details: [`references/batch.md`](references/batch.md).

Announce each dispatch in one line so the user can veto it: *"Slice 2 → route `mechanical`
(opencode, cheap): CRUD wiring."* Run slow work in the background and keep planning.

## 5. Read the result, not the logs

- `status` is what happened to the process. `findings` are what happened to the repository.
  `blocked` is true when either needs you, when a check failed, or when git could not be observed.
- `worker.summary` (the worker's final message, capped at 2 KB), `worker.usage` and
  `verification.checks` are all you usually need. Open `stdout.log` only when a failure is unexplained.
- Everything under `worker` is self-reported. The diff is the fact.

Every status and finding, and what to do about each: [`references/result-contract.md`](references/result-contract.md).

## 6. Verify — never delegated

1. Checks failing after the fix loop → retry with a **better brief** on the same worker, or do it yourself.
2. Read the diff (`git diff -- <changed paths>`, or `git -C <worktree> diff` for a batch slice).
   Green checks and `completed` are claims about processes, not about quality.
3. For a second opinion, dispatch a `--read-only` run to a **different** backend. Never ask a worker
   to review its own diff.
4. Land it (`git apply <patch>` for batch slices, in the order given), then commit as yourself.

Checklist: [`references/verification.md`](references/verification.md). Spend so far:
`fleet.js report`.

## Hard rules

- You own the review, the acceptance, the commit and any revert. Always.
- Never report success without reading the diff, whatever the exit code or checks said.
- Out-of-scope files are a finding, not a bonus. Report them; never quietly revert them.
- Never destroy pre-existing uncommitted work. Never `git reset` or `checkout` to tidy up after a worker.
- `--read-only` is honest only when that backend's read-only is verified on this machine.
- A failed run gets a better brief before a pricier worker. A bad brief fails on every model.

## Files

- `scripts/relay.js` — one slice: route, dispatch, checks, fix loop, facts.
- `scripts/batch.js` — many slices in parallel worktrees, one summary, patches.
- `scripts/fleet.js` — `discover`, `doctor`, `select`, `init`, `report`, `quota`.
- `scripts/adapters/` — one file per backend; add your own under `.delegate-fleet/adapters/`
  ([`references/extending.md`](references/extending.md)).
- `references/` — architecture, backends, brief format, dispatch, routing, batch, result contract,
  verification.
- `bench/` — the A/B benchmark (solo vs fleet); `tests/smoke.js` — opt-in runs against real CLIs.
