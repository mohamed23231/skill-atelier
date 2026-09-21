# Maintainer guide

This is the reference for adding a skill to Skill Atelier and for reviewing one. It exists so the
collection stays consistent as it grows.

## What a skill is

Per the [Agent Skills specification](https://agentskills.io/specification), a skill is a directory with a
`SKILL.md` at its root. The frontmatter carries `name` and `description`; the body carries the instructions
an agent reads when the skill is activated. Optional `references/`, `scripts/`, and `assets/` directories
hold detail that is loaded only when needed.

Agents load skills in three stages: metadata at startup (roughly 50-100 tokens per skill), the full
`SKILL.md` on activation, and supporting files on demand. That shapes every rule below.

## Adding a skill

### 1. Name it

- The folder name is the skill name. Lowercase, words separated by single hyphens.
- It must match the `name` field in `SKILL.md` exactly.
- Prefer a name that reads as a capability, not a product: `database-migration-planner`, not `MigratePro`.
- Check for an existing skill with the same name in the community directories before you commit to one.

### 2. Write `SKILL.md`

Required frontmatter:

```yaml
---
name: database-migration-planner
description: Plans zero-downtime database migrations. Use when the user asks to change a schema on a live
  database, add or backfill a column, or cut over to a new table.
---
```

- The `description` is what the agent matches against a task. Say what the skill does and when to use it,
  and include the words a user would actually type.
- Keep the body under about 500 lines. Move long material into `references/`.
- Make the procedure explicit: inputs, steps, and the conditions under which the skill should stop and ask.
- Optional fields: `license`, `compatibility`, `metadata` (use `metadata.version`), and the experimental
  `allowed-tools`.

### 3. Make it portable

- A skill must keep working when copied out of this repository on its own.
- Scripts must not import from another skill or from the repository root at run time.
- Use paths relative to the skill directory, and keep references one level deep from `SKILL.md`.
- Declare any runtime requirement in `compatibility`. Prefer none. Node 22 with the standard library is
  the default. Do not add a third-party dependency without discussing it first.

### 4. Ship tests if you ship code

- A skill with a `scripts/` or `bin/` directory must have `tests/run-tests.js` that runs with no setup
  beyond Node and exits non-zero on failure.
- Test behaviour, not implementation. A test should fail if the guarantee it names is broken.
- Do not assert on `console.log` output when you can assert on a return value or a file on disk.

### 5. Document and record

- Add or update the skill's `README.md` if a human needs more than `SKILL.md` provides.
- Add a `CHANGELOG.md` entry under the skill, or under the root changelog for repository-wide changes.
- Add the skill to the catalog table in the root `README.md`.

### 6. Verify

```bash
node scripts/validate-repo.js
node scripts/test-all.js
```

Both must pass. CI runs them on Node 22 and 24.

## Review criteria

A reviewer should be able to answer yes to each.

- **Does the description match the tasks it should activate on?** Vague descriptions cause false
  activations; over-specific ones cause the skill to never load.
- **Is the SKILL.md body lean, with detail pushed into references?** The whole body enters the agent's
  context on activation.
- **Is the procedure grounded?** Where the skill talks about a codebase, does it tell the agent to verify
  rather than assume, and to label what it could not verify?
- **Is it portable?** Would it still work copied into a bare skills directory?
- **Is it dependency-free?** If not, is the dependency justified and declared?
- **Do the tests actually exercise the guarantee?** Mutation-check the important ones: break the code,
  confirm the test fails, restore the code.
- **Are the checks green?** Validation and tests both pass.

## Deprecating a skill

Do not delete a skill silently. Mark it deprecated in its `SKILL.md` description and in the catalog table,
point to the replacement, and keep it for at least one release so existing installs do not break without
warning.

## Repository-level changes

- Structure and CI live under `docs/ARCHITECTURE.md` and `scripts/`.
- Changes to `scripts/validate-repo.js` should come with a test or a clear manual verification, since that
  script is the guard for every other skill.
- Never weaken a check to make a contribution pass. Fix the contribution.
