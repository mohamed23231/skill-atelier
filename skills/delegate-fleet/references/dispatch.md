# Dispatch

```bash
node <skill>/scripts/relay.js --backend <id> --brief <file.md> --workspace "$PWD" [options]
```

| Flag | Purpose |
| --- | --- |
| `--backend <id>` | Which worker. Must be available here |
| `--brief <file>` | Linted before dispatch; a vague brief is refused |
| `--read-only` | Analysis run. Requires read-only **verified** on this machine |
| `--model <id>` | Rejected if the backend cannot select a model |
| `--effort <level>` | Rejected if the backend has no effort control |
| `--session <id>` | Rejected if the backend cannot resume by id |
| `--timeout <s>` | Positive integer, default 1200, max 86400 |
| `--workspace <dir>` | The repository the worker runs in. Pass it explicitly |
| `--out-dir <dir>` | Artifacts location. Default `<workspace>/.delegate-fleet/runs/<stamp>` |
| `--dry-run` | Print the exact argv and lint result; dispatch nothing |
| `--json` | Print only the result JSON |
| `--allow-unverified` | Accept a safety-critical capability that is only documented |

Every one of these either changes the invocation or is rejected. Nothing is parsed and ignored.

## Always dry-run a backend you have not used here

```bash
node scripts/relay.js --backend opencode --brief briefs/slice-2.md --workspace "$PWD" --dry-run
```

It prints the exact `command` and `args`, the effective capabilities, and whether they were verified
locally. There is no hidden argv construction: what you see is what runs.

## Background a slow run

```bash
node scripts/relay.js --backend opencode --brief briefs/slice-2.md --workspace "$PWD" --json \
  > .delegate-fleet/runs/slice-2.json 2>&1 &
```

Tell the user which worker has which slice, then keep planning. Do not block the session.

## Artifacts

Each run gets its own directory, so runs never overwrite each other:

```
.delegate-fleet/runs/<stamp>-<backend>-<slug>/
  result.json    the full contract
  stdout.log     everything the worker printed
  stderr.log     the worker's own errors — read this first on a failure
  command.json   the exact command, argv and cwd
```

Artifacts are written **after** the post-run snapshot and are excluded from repository facts, so
they can never be mistaken for worker changes.

## Configuration

`.delegate-fleet/config.json`, entirely optional:

```json
{
  "workers": {
    "opencode": { "model": "deepseek/deepseek-chat" },
    "codex":    { "effort": "high", "timeoutSeconds": 2400 },
    "commandcode": { "cli": "/opt/commandcode/bin/cmd" }
  }
}
```

Exactly four keys are valid: `cli`, `model`, `effort`, `timeoutSeconds`. Every one is consumed at
dispatch and has an integration test proving it reaches the invocation. **Any other key is a hard
error**, because a config field with no consumer is a lie — that was the defining bug of the
previous version. Explicit flags always beat configured defaults.

## Failure forensics

1. `status` and `reason` — nothing else matters until you understand them.
2. `stderr.log` — the worker's own error, verbatim.
3. `repository.changed` against the brief's scope.
4. `preExistingModified`, `vanished`, `head.changed` — did it touch what it must not?
5. Then decide: better brief on the same worker, a different worker, or do it yourself.

## Resuming

`--session <id>` where the backend supports it. Resuming replays prior context, so it is rarely
cheaper than a fresh run with a better brief. Resume for rework on the same slice, never to start
the next one. Prefer an explicit id over "the last one": with two runs in flight, "last" is
ambiguous. On a backend that cannot resume by id, `--session` is **rejected**, never ignored.
