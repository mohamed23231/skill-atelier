# Repository architecture

This document describes how Skill Atelier is put together: the layout, the packaging rules, the checks
that guard them, and the reasoning behind the constraints.

## Goals

1. **Portability.** A skill must keep working when it is copied out of this repository into an agent's
   skills directory, on its own.
2. **No runtime dependencies.** Skills run with Node's standard library. Nothing is fetched at run time.
3. **Vendor neutrality.** No skill assumes a specific agent product or a specific vendor path.
4. **Grounded output.** A skill that reasons about a codebase should distinguish what it verified from
   what it assumed, and say so.
5. **Cheap to verify.** A contributor can run every check locally, in seconds, without network access.

## Layout

```
skills/<skill-name>/
  SKILL.md          required: YAML frontmatter plus the instructions an agent loads
  references/       optional: detail loaded on demand, kept out of the main SKILL.md
  scripts/          optional: executable helpers
  examples/         optional: worked inputs and their expected outputs
  tests/            required when the skill ships executable code
  package.json      optional: metadata for a skill with a CLI
  README.md         optional: human-facing documentation for the skill
  CHANGELOG.md      optional: a changelog scoped to the skill
  CONTRIBUTING.md   optional: contribution notes scoped to the skill
docs/               repository-level documentation (this file and its siblings)
scripts/            repository-level tooling
.github/            templates and workflows
.claude-plugin/     optional Claude Code plugin marketplace entry
```

Each skill is a sealed unit. A skill's scripts must not import from a sibling skill or from the repository
root at run time, because the skill will be copied somewhere those paths do not exist.

## Why skills and not one big tool

An agent loads only a skill's `name` and `description` at startup, then reads the full `SKILL.md` when a
task matches. That is the progressive-disclosure model from the Agent Skills specification. Keeping
capabilities in separate skills means an unrelated task does not pay for their context, and a skill can be
reviewed, versioned, and installed independently.

## The flagships' shape

`architecture-visualizer` is representative of the intended packaging:

- `SKILL.md` is the procedure the agent follows. It stays lean and points to `references/` for detail.
- `references/` holds the long-form material: diagram selection, the delta model, the reasoning checklist.
- `bin/` and `src/` hold the CLI engine: a validator, a deterministic layout engine, a compiler that emits
  a standalone HTML page, and exporters.
- `examples/` holds complete, validated scenarios: the prompt, the spec, the generated HTML, and the
  Markdown report.
- `tests/` holds the suites, including a headless-browser suite that asserts on the rendered DOM.

The engine is dependency-free by design. The generated visualization is a single HTML file with no CDN and
no network access, so it can be attached to a pull request and opened offline.

## Checks

Two dependency-free scripts guard the repository.

### `scripts/validate-repo.js`

Structural checks, run on every push and pull request:

- required files and directories exist;
- every `skills/*/SKILL.md` has valid frontmatter, a `name` that matches its folder, and a `description`
  within the specification's limits;
- JSON files parse;
- issue templates and workflows have the top-level keys GitHub requires;
- relative links in the top-level documents resolve;
- no absolute user paths, personal identifiers, private project names, or private keys are committed, and
  no stray `.DS_Store` files exist.

### `scripts/test-all.js`

Runs each skill's `tests/run-tests.js` and fails if any suite fails. A skill's suite is expected to be
runnable with no setup beyond Node.

## CI and release

- `.github/workflows/ci.yml` runs `validate-repo.js` once and `test-all.js` on Node 22 and 24.
- `.github/workflows/release.yml` runs on a `v*` tag, re-runs both checks, and creates a GitHub release
  with generated notes.
- `.github/dependabot.yml` keeps the pinned GitHub Actions up to date. There is no npm ecosystem entry
  because the repository has no package dependencies.

## Decisions

- **Copy, do not install.** A skills directory is a plain folder. Adding a package manager or an installer
  script would add a dependency and a failure mode for no benefit.
- **A cross-client default.** `.agents/skills/` is the standard path. Client-specific paths are documented
  but not assumed.
- **Repository-level validation, skill-level tests.** Structure is a repository concern, so it is checked
  centrally. Behaviour is a skill concern, so each skill owns its tests.
- **No third-party actions beyond the official ones.** Workflows use `actions/checkout` and
  `actions/setup-node`, plus the preinstalled `gh` CLI for releases. This keeps the supply-chain surface
  small and auditable.
- **Feature branches are checked, not gated on coverage numbers.** Tests earn their place by reproducing a
  real defect or pinning a real guarantee; a coverage threshold would reward tests that assert nothing.
