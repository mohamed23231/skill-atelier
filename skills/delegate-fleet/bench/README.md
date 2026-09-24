# delegate-fleet benchmark

The skill's claim is economic: the expensive model plans and reviews, cheaper workers spend the
tokens, and the result is just as good. This harness measures that claim. It reports the cases
where it fails too.

## What it measures

Each task runs twice from the same small fixture project (`fixture/`):

| Arm | What happens |
| --- | --- |
| `solo` | The orchestrator model does the task itself with `claude -p`. |
| `fleet` | The same model gets the same task and is told to delegate through delegate-fleet. |

Both runs are then scored with an acceptance test the agent never saw. The test is copied in only
after the run, and the whole suite must pass for the run to count as accepted.

Cost for each run comes from the CLIs' own JSON output:

- The orchestrator's cost is `total_cost_usd` from `claude -p --output-format json`.
- The workers' cost is their self-reported usage, summed by `fleet.js report`. A worker CLI that
  reports no cost is counted as `unreported`, never as zero.

The number to compare is `costPerAcceptedUsd` for each arm. A cheap run that fails does not count
as a saving.

## Tasks

| Task | Shape | Why it is here |
| --- | --- | --- |
| `rename` | A mechanical rename across three files | The best case for a cheap worker |
| `validate` | A small hardening change, plus tests | A moderate, single-file task |
| `feature` | A new function from a precise spec | Tests how well the brief carries the spec |
| `multi` | Two independent changes | The case for `batch.js` |

To add a task, create `tasks/<id>/task.md` (the prompt) and `tasks/<id>/accept.test.js` (the
hidden gate). The contract tests check that every acceptance test fails on the untouched fixture,
so a task can never pass by doing nothing.

## Running it

```bash
node bench/bench.js                     # print the plan; spends nothing
node bench/bench.js --yes --fleet-config ~/my-fleet-config.json --repeat 3
node bench/bench.js --yes --tasks rename,multi --arms fleet --model opus
```

`--fleet-config` is copied into each fleet run as `.delegate-fleet/config.json`. Use your real
workers, tiers and routes: the result is only as good as the fleet you configure.

## Publishing results honestly

- Run at least three repeats. A single run of an agent is anecdote.
- Publish the orchestrator model, every worker model, the date, and the CLI versions.
- Publish the losses as well as the wins. Delegation adds a planning and review overhead that a
  small or read-heavy task cannot pay back. Where fleet loses, add that case to the skill's
  "When NOT to use" list.
- Publish `costPerAcceptedUsd`, not total spend.
