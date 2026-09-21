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
  "verification": { "performedByRelay": false, "requiredFromOrchestrator": true, "checks": [] },
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

| Type | Meaning |
| --- | --- |
| `scope_violation` | Paths changed outside the brief's `## Scope` |
| `unexpected_repository_change` | The worker altered files that were already uncommitted |
| `worker_commit` | HEAD moved during the run |
| `worker_stash` | The stash ref moved during the run |
| `read_only_violation` | A read-only run changed the tree — the backend's claim is broken |

## blocked

`blocked = status !== "completed" || findings.length > 0 || repository.observed === false`.
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
