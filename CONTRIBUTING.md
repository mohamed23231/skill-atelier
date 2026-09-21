# Contributing to Skill Atelier

Thanks for taking the time to contribute. This document explains how to set up the repository, what the
rules are, and how to get a change merged.

By participating, you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- Fix a bug or a typo.
- Improve a skill's instructions, references, or examples.
- Add a test that reproduces a problem.
- Propose a new skill (read [docs/MAINTAINERS.md](docs/MAINTAINERS.md) first — every skill has a fixed
  packaging shape).
- Improve documentation, install instructions, or CI.

For anything larger than a small fix, open an issue first so the approach can be agreed before you write
code. A rejected pull request that took a weekend is a worse outcome than a short conversation.

## Development setup

The repository has no third-party dependencies. You need Node.js 22 or newer and git.

```bash
git clone https://github.com/mohamed23231/skill-atelier.git
cd skill-atelier

# Run every skill's test suite
node scripts/test-all.js

# Run the structural checks
node scripts/validate-repo.js

# Both at once
node scripts/test-all.js && node scripts/validate-repo.js
```

Both commands must pass before a pull request is ready for review. CI runs them on Node 22 and 24.

## Repository layout

```
skills/<skill-name>/SKILL.md   the skill an agent loads
skills/<skill-name>/...        scripts, references, examples, tests
scripts/                       repository-level tooling
docs/                          install, architecture, maintainer, and launch documentation
.github/                       templates and workflows
```

Each skill is self-contained and must keep working when copied out of this repository on its own. Do not
make one skill import files from another skill or from the repository root at run time.

## Adding or changing a skill

Read [docs/MAINTAINERS.md](docs/MAINTAINERS.md). In short:

- The folder name must match the `name` in `SKILL.md` frontmatter, lowercase, hyphen-separated.
- `SKILL.md` must stay lean; detailed material belongs in `references/`.
- Any bundled script must run on Node 22 with no third-party dependencies, or clearly state its
  requirements in the `compatibility` field.
- A skill that ships executable code must ship tests.

## Code style

- Match the surrounding code. This repository favours small, explicit, dependency-free JavaScript.
- Do not add a runtime dependency without discussing it in an issue first. "No dependencies" is a feature.
- Keep comments rare and load-bearing. Explain why, not what.
- Prefer deleting code to adding an abstraction.

## Commits and pull requests

1. Fork the repository and branch from `main`.
2. Make the change in small commits with clear messages. Conventional Commits prefixes (`feat:`, `fix:`,
   `docs:`, `test:`, `chore:`) are preferred but not enforced.
3. Update the relevant changelog. Repository-wide changes go in the root `CHANGELOG.md`; skill changes go
   in that skill's own `CHANGELOG.md`.
4. Run `node scripts/test-all.js` and `node scripts/validate-repo.js`.
5. Open a pull request and fill in the template. Describe what changed and how you verified it.

A maintainer will review. Reviewers look for correctness, whether the change is grounded in reality, the
absence of new dependencies, and whether the tests actually exercise the change.

## Testing the visualization in a browser

The viewer's behaviour is verified by loading a compiled example in headless Chrome and asserting on the
resulting DOM. The suite skips cleanly when no browser is available.

```bash
node skills/architecture-visualizer/bin/arch-viz.js build \
  skills/architecture-visualizer/examples/3-async-event-driven-workflow/architecture.json \
  -o /tmp/probe.html
```

Then load `/tmp/probe.html` in a browser, or drive it headlessly. See the skill's
[CONTRIBUTING.md](skills/architecture-visualizer/CONTRIBUTING.md) for the probe technique and the layout
engine invariants.

## Reporting bugs and requesting features

Use the issue templates. Include the command you ran, the output you got, and the output you expected. For
visual defects, a screenshot or the spec JSON is worth a page of prose.

Security issues do not go in the issue tracker — follow [SECURITY.md](SECURITY.md).
