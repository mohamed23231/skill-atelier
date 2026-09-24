# Adding a backend

One file. No fork, no framework changes, no registry surgery.

## Where

- **Ship it with the framework:** `scripts/adapters/<id>.js`, then add one `require` line to
  `scripts/adapters/index.js`.
- **Keep it to your project:** `<workspace>/.delegate-fleet/adapters/<id>.js`. It is discovered
  automatically, validated exactly as strictly as a built-in, and may override one by id.

## The contract

```js
'use strict';
module.exports = {
  id: 'mycli',                       // unique; what --backend takes
  cli: 'mycli',                      // the executable name, or an absolute path
  title: 'My CLI',
  docs: 'https://…',

  // What it can do, and on what evidence. Never claim what you have not checked.
  // All 8 capabilities must be declared: verified | documented | unsupported | unknown
  capabilities: {
    edit: 'documented',
    readOnly: 'unknown',
    resumeById: 'unsupported',
    modelSelection: 'documented',
    effort: 'unsupported',
    structuredOutput: 'unknown',
    turnLimit: 'unsupported',
    budgetLimit: 'unsupported',
  },

  promptDelivery: 'argv',            // 'argv' | 'stdin' | 'file'
  helpArgs: ['--help'],              // where doctor should look; e.g. ['run','--help']
  evidenceArgs: [['agent', 'list']], // optional: extra probes whose output joins the evidence,
                                     // for facts --help cannot show (does agent `plan` exist?)

  // Build the argv. Explicit and readable — no hidden magic.
  build(req) {
    // req: { prompt, mode:'edit'|'read-only', model, effort, session, maxTurns, maxBudgetUsd, cwd, promptFile }
    const args = ['run'];
    if (req.mode === 'read-only') args.push('--plan');
    else args.push('--yes');
    if (req.model) args.push('--model', req.model);
    args.push(req.prompt);
    return { args };
  },

  // Local verification: given the CLI's own --help, what is actually there?
  probe(help) {
    return {
      edit: /--yes/.test(help) ? 'verified' : 'unknown',
      readOnly: /--plan/.test(help) ? 'verified' : 'unsupported',
    };
  },

  // Output markers that mean "refused or could not authenticate" despite exit 0.
  denyPatterns: [/not authenticated/i],
};
```

## The rules

1. **Never claim a capability you have not checked.** `unknown` is a perfectly good answer, and the
   framework will refuse to lean on it for anything safety-critical. A wrong `verified` is a bug.
   Declaring `verified` buys you nothing anyway: it is downgraded to `documented` until `doctor`
   has run on the machine in question.
2. **If read-only cannot be enforced by the CLI, declare it `unsupported`.** Prompt wording is not a
   read-only guarantee. The framework refuses `--read-only` rather than pretend. It also checks
   this mechanically: your read-only argv must contain an argument your edit argv does not. Merely
   omitting `--yes` and hoping the default is safe will be clamped to `unsupported`.
3. **Only claim what `build()` reads.** Declaring `modelSelection` while `build()` ignores
   `req.model` is refused at load time, and a `probe()` that matches a flag `build()` never passes
   is clamped away. A capability is a promise about the invocation, not about the help text.
4. **Match the exact token `build()` emits.** If `build()` passes `--sandbox read-only`, probe for
   the profile, not for `--sandbox`. If the help documents the flag but never names the value, say
   `unknown` — that is honest, where `unsupported` would be a claim you cannot make either.
5. **Point `helpArgs` at the right help.** Flags often live on a subcommand (`codex exec --help`,
   `opencode run --help`, `oz agent run --help`). Pointing at the wrong one makes `doctor`
   wrongly demote a real capability. Use `evidenceArgs` for anything `--help` cannot show.
6. **Force off anything that commits.** The worker never owns the commit.
7. **Never build a shell string.** Return an argv array; the relay spawns without a shell.
8. **Keep `build()` readable.** Someone must be able to predict the command by reading it.

## Verify it

```bash
node scripts/fleet.js doctor --backend mycli        # what does the installed version really do?
node scripts/relay.js --backend mycli --brief b.md --workspace "$PWD" --dry-run
node tests/run-tests.js
```

The adapter registry validates shape at load time, so a malformed adapter fails immediately with a
named error rather than at dispatch.
