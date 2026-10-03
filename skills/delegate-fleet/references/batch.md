# Batch: parallel slices in worktrees

Dispatching slices one by one costs the orchestrator a round trip for every step: one dispatch, one
wait and one result read per slice, each re-reading the whole conversation. `batch.js` runs a whole
plan in one command and returns one table.

```bash
node scripts/batch.js .delegate-fleet/plan.json            # run
node scripts/batch.js .delegate-fleet/plan.json --dry-run  # validate and show the waves
node scripts/batch.js --cleanup <batch-id>                 # remove that batch's worktrees
```

## The plan

```json
{
  "concurrency": 3,
  "setup": ["pnpm install --frozen-lockfile --offline"],
  "link": ["node_modules"],
  "slices": [
    { "id": "api",  "brief": "briefs/api.md",  "route": "mechanical",
      "checks": ["pnpm test -- api"], "fixAttempts": 2 },
    { "id": "ui",   "brief": "briefs/ui.md",   "backend": "codex", "dependsOn": ["api"] },
    { "id": "docs", "brief": "briefs/docs.md", "route": "mechanical" }
  ]
}
```

Brief paths are relative to the plan file. Each slice sets exactly one of `backend` or `route`, and
may set `model`, `effort`, `checks`, `fixAttempts`, `timeoutSeconds` and `dependsOn`. Unknown keys,
duplicate ids, missing briefs and dependency cycles are all refused before anything runs.

- `setup` runs in every worktree before dispatch, without a shell. A fresh worktree has no
  `node_modules`, so this is where installs go.
- `link` symlinks paths from your workspace into each worktree, which is faster than installing.
  Linked paths are never part of a patch.

## What it does to your repository

- `git worktree add --detach` creates one worktree per slice, outside the repository (by default in
  the system temp directory; change it with `--worktree-root`).
- For a slice with dependencies, it builds a base **commit object** from the dependencies' patches
  with plumbing: a private index, `apply --cached`, then `commit-tree`. No branch or ref moves, no
  hook runs, and your working tree and index are never touched.
- Each worktree gets a copy of your `.delegate-fleet/` config, verification record and adapters. The
  relay runs there with `--state-root` pointing back at your checkout, so quota marks, limits and the
  run history stay in one place.
- It writes `batch.json`, `summary.json`, one `<slice>.patch` per slice, and each slice's full relay
  result to `.delegate-fleet/runs/batch-<id>/`.

It never commits to a branch, never lands a patch, and never deletes anything unless you pass
`--cleanup <id>`. Cleanup removes only the worktrees that batch recorded, and keeps the patches.

## Scheduling

Slices start as soon as their dependencies have settled, up to `concurrency` at a time (default 3,
maximum 8). A slice runs only when every dependency finished `completed` **and** unblocked. If a
dependency needs a decision, its dependents are `skipped`, with the reason.

**Uncommitted work in your checkout is not carried into the worktrees.** They start from `--base`
(default `HEAD`). The batch warns when your checkout is dirty.

## Guards

- **Each slice** gets the full relay treatment: snapshots, scope, findings, checks and the fix loop,
  all inside its own worktree.
- **Across the batch**, workers should write only inside their worktrees. The batch fingerprints your
  main checkout (`git status` and the framework files under `.delegate-fleet/`) before and after. If
  anything changed, it warns and exits 1. Find out who made the change before you land anything.

## Landing

```
[batch] 2026-…: 3 slice(s) · 2 clean · 1 need a decision · worker spend $0.04
  api    opencode [cheap]  clean    +1 ~2 -0  checks 2/2
  ui     codex             BLOCKED  +0 ~1 -0  scope_violation(1)
  docs   opencode [cheap]  clean    +0 ~1 -0
[batch] review each clean slice (git -C <worktree> diff), then land in this order:
  git apply .delegate-fleet/runs/batch-…/api.patch
  git apply .delegate-fleet/runs/batch-…/docs.patch
```

Review each clean slice in its worktree, then apply the patches in the order printed and commit as
yourself. A dependent slice's patch contains only its own changes, so land its dependencies first.
For a blocked slice, open its `result.json`: the reason is there.

The exit code is 0 only when every slice is clean and the main checkout did not change.
