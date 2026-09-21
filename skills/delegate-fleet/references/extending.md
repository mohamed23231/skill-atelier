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
  //   verified | documented | unsupported | unknown
  capabilities: {
    edit: 'documented',
    readOnly: 'unknown',
    resumeById: 'unsupported',
    modelSelection: 'documented',
    effort: 'unsupported',
    structuredOutput: 'unknown',
  },

  promptDelivery: 'argv',            // 'argv' | 'stdin' | 'file'
  helpArgs: ['--help'],              // where doctor should look; e.g. ['run','--help']

  // Build the argv. Explicit and readable — no hidden magic.
  build(req) {
    // req: { prompt, mode:'edit'|'read-only', model, effort, session, cwd, promptFile }
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
2. **If read-only cannot be enforced by the CLI, declare it `unsupported`.** Prompt wording is not a
   read-only guarantee. The framework refuses `--read-only` rather than pretend.
3. **Point `helpArgs` at the right help.** Flags often live on a subcommand (`codex exec --help`,
   `opencode run --help`, `oz agent run --help`). Pointing at the wrong one makes `doctor`
   wrongly demote a real capability.
4. **Force off anything that commits.** The worker never owns the commit.
5. **Never build a shell string.** Return an argv array; the relay spawns without a shell.
6. **Keep `build()` readable.** Someone must be able to predict the command by reading it.

## Verify it

```bash
node scripts/fleet.js doctor --backend mycli        # what does the installed version really do?
node scripts/relay.js --backend mycli --brief b.md --workspace "$PWD" --dry-run
node tests/run-tests.js
```

The adapter registry validates shape at load time, so a malformed adapter fails immediately with a
named error rather than at dispatch.
