# Independent verification

Execution and verification are separate, and the separation is the point.

> The worker says: "I implemented it."
> The relay says: "These are the facts about what happened."
> **You** say: "I accept, or I do not."

The relay never runs your tests. It deliberately has no idea what your project's gates are, because
a generic framework that hardcodes `npm test` is wrong in most repositories. It provides the
mechanism — a trustworthy account of what changed — and you compose your own checks on top.

## The checklist

1. **Read `status` and `reason` first.** Nothing else matters until you understand them.
2. **Read every finding.** `blocked: true` means a decision is required from you.
3. **Read the diff yourself, in full.** `completed` is a statement about a process, not about
   quality. A worker that confidently writes the wrong thing exits 0.
4. **Check `repository.scope.outOfScope`.** Inspect each path. Never blanket-revert — you do not
   know which of those edits was actually necessary.
5. **Check `repository.preExistingModified` and `vanished`.** These are someone else's uncommitted
   work. Report immediately; never quietly restore them.
6. **Check `repository.head.changed`.** If the worker committed, say so before anything else. Do not
   let its commit become the record of acceptance.
7. **Run the project's own gates** on the changed files — tests, typecheck, lint, build, migrations,
   whatever this repository actually uses.
8. **Then commit, as yourself.**

## Composing project checks

Keep them yours, outside the relay:

```bash
node scripts/relay.js --backend opencode --brief briefs/slice-2.md --workspace "$PWD" --json > run.json
test "$(node -p "require('./run.json').blocked")" = false || exit 1
pnpm test && pnpm typecheck && pnpm lint
git add -A && git commit   # you, not the worker
```

`verification.checks` is left empty by the relay and reserved for an orchestrator that wants to
record what it ran alongside the run.

## A second opinion

To have a diff reviewed by another model, dispatch a **read-only** run on a **different** backend
than the one that wrote it, with a brief that points at the diff. Never ask a worker to review its
own output, and never let a review run have write access.

`verified` is produced by `doctor` and by nothing else. An adapter that declares a capability as
`verified` is reporting its author's machine, so the merged view downgrades it to `documented`
until local evidence exists. A verification record is also tied to the executable it was taken
from: if `cli` now resolves elsewhere, the record is dropped and the run says so.

A probe cannot invent support either. Help text says which flags *exist*, not which ones the
adapter passes, so probe output is clamped to what `build()` actually reads — and read-only is
clamped away entirely unless the read-only invocation carries an argument the edit invocation does
not. Omitting a write flag and trusting the CLI's default is not an enforcement.

Note that `--read-only` is only accepted when that backend's read-only is `verified` on this
machine. That is the point: a review run that can write is not a review run.
