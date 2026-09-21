# Support

## Where to ask

- **Bug or unexpected behaviour:** open an issue using the bug template. Include the command you ran, the
  result, and what you expected.
- **Idea or feature request:** open an issue using the feature template, or start a discussion if the idea
  is early and you want to explore it before committing to a shape.
- **Proposing a new skill:** open an issue using the new-skill template. Read
  [docs/MAINTAINERS.md](docs/MAINTAINERS.md) first.
- **Security problem:** follow [SECURITY.md](SECURITY.md). Never a public issue.
- **Code of Conduct concern:** see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before opening an issue

1. Check the skill's own README and `SKILL.md`; the answer is often there.
2. Search existing issues and discussions.
3. Reproduce on the latest `main`.
4. Run `node skills/architecture-visualizer/tests/run-tests.js` and include the output if a test fails.

## What a good report contains

- The exact command or prompt, copied verbatim.
- The Node.js version (`node --version`) and operating system.
- The spec JSON, or the smallest one that reproduces the problem.
- For visual defects, a screenshot and the browser you used.
- What you expected to happen and what happened instead.

## Maintainer response

This is a volunteer project. Maintainers triage as time allows and cannot promise a response time. Clearly
reproducible issues with a minimal example are the fastest to resolve.
