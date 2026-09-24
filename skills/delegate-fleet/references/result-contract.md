# Result contract

Versioned (`schemaVersion: 2`), small, and stable. Written to `<out-dir>/result.json` and printed
with `--json`. The two axes are independent on purpose.

```json
{
  "schemaVersion": 2,
  "status": "completed",
  "reason": null,
  "blocked": false,
  "findings": [],
  "warnings": [],
  "request":  { "backend": "opencode", "mode": "edit", "model": null, "timeoutSeconds": 1200, "briefPath": "..." },
  "backend":  { "id": "opencode", "cli": "opencode", "cliPath": "/usr/local/bin/opencode",
                "capabilities": { "edit": "verified", "readOnly": "verified" },
                "capabilitiesVerifiedLocally": true },
  "execution":{ "outcome": "exited", "exitCode": 0, "signal": null,
                "startedAt": "...", "durationSeconds": 94, "outputTruncated": false },
  "repository": {
    "observed": true,
    "changed": { "created": [], "modified": ["src/b.js"], "deleted": [], "renamed": [] },
    "scope":   { "declared": ["src/b.js"], "inScope": ["src/b.js"], "outOfScope": [] },
    "preExisting": ["notes.md"],
    "preExistingModified": [],
    "vanished": [],
    "head": { "before": "abc…", "after": "abc…", "changed": false },
    "stashChanged": false
  },
  "worker": { "selfReported": true, "source": "structured", "summary": "Renamed … Changed: src/b.js",
              "summaryTruncated": false, "sessionId": "…",
              "usage": { "inputTokens": 1200, "outputTokens": 300, "cacheReadTokens": 5000, "costUsd": 0.0123 } },
  "verification": { "performedByRelay": true, "requiredFromOrchestrator": true,
                    "checks": [{ "command": "pnpm test", "outcome": "exited", "exitCode": 0, "passed": true,
                                 "durationSeconds": 12, "tail": "…last 40 lines…", "log": ".../check-1.log" }] },
  "acceptance":   { "decidedBy": "orchestrator", "accepted": null, "committedBy": null },
  "artifacts": { "dir": "...", "stdout": "...", "stderr": "...", "result": "..." }
}
```

## status — what happened to the process

Exactly one, terminal.

| Value | Meaning | Typical next move |
| --- | --- | --- |
| `invalid_request` | Refused before dispatch. Nothing ran, nothing spent | Fix the request or the brief |
| `backend_unavailable` | Supported, but the CLI is not installed here | Pick another available worker, or install it |
| `launch_failure` | The process could not be started | Check the `cli` path and permissions |
| `timeout` | The watchdog fired | **Inspect the tree first** — partial edits are likely |
| `aborted` | The relay was killed and forwarded the kill | Same as timeout |
| `process_failure` | Non-zero exit or fatal signal | Read `stderr.log` |
| `implementer_failure` | Exit 0, but the worker refused or could not authenticate | Fix auth, or the permission mode |
| `noop` | Exit 0 on an edit run, tree unchanged | Almost always the brief. Read the log before retrying |
| `completed` | Exit 0 and the run did something | Review the diff |

`timeout` does **not** mean "retry". The worker may have half-finished an edit.

## findings — what happened to the repository

Zero or more, computed **even when the process failed**, because a worker that times out can have
violated scope first.

| Type | Meaning | What you must do |
| --- | --- | --- |
| `scope_violation` | Paths changed outside the brief's `## Scope` | Inspect each path. Never auto-revert |
| `unexpected_repository_change` | The worker altered files that were already uncommitted | Say so immediately; that work is someone else's |
| `worker_commit` | HEAD moved during the run | Report it before anything else |
| `worker_stash` | The stash ref moved during the run | Report it before anything else |
| `read_only_violation` | A read-only run changed the tree — the backend's claim is broken | Stop trusting that backend's read-only |
| `framework_state_modified` | The worker modified framework state under `.delegate-fleet/` (outside `runs/`) | Inspect config and adapters before the next run loads them |

With a fix loop, findings accumulate across attempts against the **original** baseline: a violation
made by attempt 1 and undone by attempt 2 is still reported.

## worker — what the worker says about itself

Parsed from the worker's stdout so the orchestrator never has to read the raw log to learn what
happened. `source` is `structured` (a JSON result or JSON-lines stream), `text-tail` (the last 2 KB
of plain output), `adapter` (the adapter's own `parseReport`), or `none`.

- `summary` — the worker's final message, capped at 2000 characters, keeping the **end**.
- `sessionId` — pass it to `--session` to resume this exact run.
- `usage` — tokens and cost as the CLI reported them. A final cumulative `result` object wins;
  otherwise per-turn events are summed. Any field the CLI did not report is `null`.

All of it is **self-reported**. It never feeds `status`, `findings`, or `blocked`: a worker that
claims success on an unchanged tree is still `noop`.

## route

`null` for `--backend`. For `--route`, it records `{ name, chosen, candidate, skipped: [{ backend,
reason }] }`: the class, the backend that ran, its position in the list, and why each earlier
candidate was passed over (not installed, missing a capability, over its tier limit, out of quota).

## attempts and the fix loop

One entry per worker run: `{ attempt, status, exitCode, durationSeconds, checksFailed, usage, dir }`.
Without `--fix-attempts` there is exactly one. Attempt 2 onwards keep their logs in
`<run>/attempt-N/`. The top-level `status`, `worker` and `verification.checks` describe the last
attempt; `repository` is always cumulative from the original baseline; `worker.usage` is summed
across attempts (`worker.usageAcrossAttempts: true`).

The loop continues only while the attempt `completed`, no finding is outstanding, and a check still
fails. An attempt that changes nothing ends the loop and is recorded as `noop`. The overall status
stays `completed`, because the tree still holds the previous attempt's work.

`worker.quotaExhausted: true` means the failed run's output looked like an account limit, and the
worker was marked out of quota. See [routing.md](routing.md).

## verification.checks

One entry per `--check`, in order. Every check runs even after one fails. `outcome` is `exited`,
`timeout`, `launch_failure`, or `skipped` (the run did not complete, so no check ran and `passed` is
`null`). `tail` is the last 40 lines (at most 4000 characters) of combined output; `log` holds all of
it. A check that changes the working tree is reported as a warning and never undone.

## blocked

`blocked = status !== "completed" || findings.length > 0 || repository.observed === false || any check failed`.
Mechanical, so an orchestrator can gate on it. It means "a human decision is required", never
"this is bad work".

The third term matters: when git could not be read, scope, noop and commit detection were all
disabled. Such a run has not been checked at all, so it is never reported as clean.

## repository.observed

`false` when git could not report (not a work tree, or `git status` failed). Then the absence of
findings means **unknown**, not clean: scope, noop and commit detection are all disabled, and a
warning says so.

## Exit codes

`0` completed with no findings · `1` dispatched but blocked · `2` invalid request, nothing dispatched.
