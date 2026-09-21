# The delegation brief

The worker starts with **zero conversation history**. The brief is the whole contract, and it is
linted before dispatch because a vague brief fails on every backend.

Write briefs to `.delegate-fleet/briefs/<slug>.md` and keep `.delegate-fleet/` out of version control.

## Template

```markdown
# Objective
<one line: what must be true when this is done>

## Context
<which feature, why this change, ticket or PR if any>

## Scope
- `path/to/File.ts` — what changes here
- `path/to/styles.ts` — what changes here

## Files to read first (do not edit)
- `path/to/Reference.ts` — the pattern to copy

## Non-goals
- <what this slice must not become>

## Acceptance criteria
1. <numbered, checkable statements about the code>
2. ...

## Verification
- Do not run repo-wide tests or linters; the orchestrator runs those.
- Reading a file to confirm an import path or symbol name is fine.
```

## What is linted

**Errors — refuse to dispatch** (`invalid_request`, exit 2, nothing spent):

- missing `# Objective`, `## Scope`, or `## Acceptance criteria`
- under 200 characters
- no backtick-quoted paths under `## Scope`

**Warnings — dispatch, but say so:** no `## Context`, `## Non-goals` or `## Verification`; an
unfilled placeholder (`TBD`, `TODO`, `<like this>`); a single acceptance criterion.

## The safety rules are not yours to write

The relay injects these into **every** run, so they cannot be forgotten or edited away:

- Do not commit, push, stash, revert, or reset.
- Do not modify or "clean up" any file that was already modified before the run started.
- Do not modify files outside `## Scope`; stop and say so instead.
- Do not install dependencies or edit lockfiles.
- Do not run repo-wide tests, linters, or builds.
- List every changed file and one line on why.

A rule you can forget to write is not a rule. This is why the brief lint checks structure, not
whether you remembered to paste boilerplate.

## Scope is load-bearing

The backtick-quoted paths under `## Scope` are exactly what `scope_violation` is computed from. A
path matches if it equals a declared entry or sits under a declared directory — nothing else. Write
them precisely; a vague scope makes the strongest finding in the contract meaningless.

## Always paste the project's own rules

Workers do not read your agent files. Paste the rules that apply to the files in scope, verbatim:
naming, layout, imports, error handling, forbidden APIs, no-touch files. Quote real values from
config rather than paraphrasing. Put the rule a worker most often breaks at the top.

## Size

40–120 lines. Long enough to be unambiguous, short enough to read in one pass. Longer than that
means the slice should be split. The relay refuses a brief that renders past 256 KB.
