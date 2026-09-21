# AGENTS.md

Guidance for AI coding agents working in this repository. The cross-client standard is a `SKILL.md`
folder; this file is the contributor-facing index, not a skill.

## What this repository is

A collection of vendor-neutral Agent Skills. Each skill is a self-contained directory under `skills/` with
a `SKILL.md` at its root and optional `scripts/`, `references/`, `examples/`, and `tests/`.

## Commands

```bash
node scripts/test-all.js        # run every skill test suite
node scripts/validate-repo.js   # structural checks: frontmatter, layout, no leaked paths
node scripts/test-all.js && node scripts/validate-repo.js
```

There are no third-party dependencies. Do not add one without discussing it in an issue first.

## Rules

1. A skill folder name must match the `name` in its `SKILL.md` frontmatter (lowercase, hyphens).
2. `SKILL.md` must have a `name` and a `description`; keep it lean and move detail into `references/`.
3. A skill must keep working when copied out of this repository on its own. No cross-skill imports at run
   time. No repository-relative paths inside a skill's scripts.
4. Bundled scripts must run on Node 22 with the standard library only, or declare their requirements in
   the `compatibility` field.
5. A skill that ships executable code must ship tests.
6. Never commit secrets, personal filesystem paths, or private data. `scripts/validate-repo.js` rejects
   common offenders.
7. Update the matching `CHANGELOG.md` — root for repository changes, the skill's own for skill changes.

## Adding a skill

See [docs/MAINTAINERS.md](docs/MAINTAINERS.md) for the full checklist and the review criteria.
