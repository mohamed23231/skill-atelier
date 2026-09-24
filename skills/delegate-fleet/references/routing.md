# Routing, tiers, budgets and quota

The orchestrator should spend its judgement on *what kind of work a slice is*, not on remembering
which CLI flag gives the cheapest model today. So routing splits the job:

- **The model classifies.** It names a task class: `--route mechanical`.
- **Code owns the flags.** `.delegate-fleet/config.json` maps that class to a backend, a model, an
  effort level and limits. A route is reviewed once, then reused.

## Tiers

```json
{ "workers": { "opencode": { "tier": "cheap", "model": "deepseek/deepseek-chat" },
               "codex":    { "tier": "standard" },
               "claude":   { "tier": "premium" } } }
```

A tier is `cheap`, `standard` or `premium`. It describes the model you configured, not the CLI:
`opencode` on a local model is cheap, and on a frontier model it is premium. That is why tiers live in
config and never in an adapter. An untiered worker is unranked, not cheap.

`fleet.js select --need edit` lists capable workers cheapest first. `--max-tier standard` drops the
pricier ones. Capability is always the hard filter: a tier never lets in a worker that cannot do the
job.

## Routes

```json
{ "routes": {
    "mechanical": [
      { "backend": "opencode", "model": "deepseek/deepseek-chat" },
      { "backend": "codex", "effort": "low" }
    ],
    "moderate": { "backend": "codex", "effort": "medium", "fixAttempts": 2, "timeoutSeconds": 1800 }
} }
```

A route is one candidate or an ordered list of them. Each candidate names a `backend` and may set
`model`, `effort`, `timeoutSeconds`, `maxTurns`, `maxBudgetUsd` and `fixAttempts`. These beat the
worker's own defaults, and explicit flags beat both. Route names are lowercase letters, digits and
hyphens. Any other key is a hard error.

`relay.js --route <class>` walks the candidates in order and takes the first one that:

1. has a CLI installed on this machine;
2. has every capability the run needs (`--read-only`, `--effort`, `--model`, …);
3. is under its tier's `limits.runsPer24h`;
4. is not marked out of quota.

`result.route` records the class, the chosen candidate, and every candidate that was skipped and why.
When no candidate is installed, the status is `backend_unavailable`. When candidates are installed
but none qualifies, the request is refused as `invalid_request`. Either way nothing runs and nothing
is spent.

## Budgets

```json
{ "limits": { "runsPer24h": { "premium": 3, "standard": 40 } } }
```

A limit counts the runs each tier started in the rolling 24 hours, read from
`.delegate-fleet/runs/`. Routes skip a tier that is over its limit. Naming such a worker directly
with `--backend` is refused before dispatch, with a message that says how to raise the limit. The
count is a guard, not a lock: parallel runs that start at the same moment can each pass it.

## Quota

When a run fails and its output looks like an account limit rather than a task failure ("usage limit
reached", "quota exceeded", "rate limit exceeded", …), the relay marks the worker exhausted for 60
minutes in `.delegate-fleet/quota.json`, and routes skip it until then. The run's status is never
changed, and a successful run is never marked, whatever it printed.

```bash
node scripts/fleet.js quota                              # who is marked, and until when
node scripts/fleet.js quota --mark codex --until 21:30   # or +2h, or an ISO time
node scripts/fleet.js quota --clear codex
```

Naming a marked worker directly with `--backend` still dispatches, with a warning. You named it, so
the choice is yours.

## Spend

```bash
node scripts/fleet.js report --since 7d
```

The report sums the runs, their outcomes, and the tokens and USD each worker reported, grouped by
tier and by worker. Workers that report nothing are counted as `unreported`, never as zero. The
report cannot see the orchestrator's own tokens. For solo-vs-fleet numbers, use `bench/`.
