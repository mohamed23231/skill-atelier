# Skill Atelier

[![CI](https://github.com/mohamed23231/skill-atelier/actions/workflows/ci.yml/badge.svg)](https://github.com/mohamed23231/skill-atelier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Vendor-neutral engineering skills for AI coding agents.

Each skill is a self-contained folder with a `SKILL.md`, optional reference material, and dependency-free
scripts. Copy one folder into the skills directory your agent already reads, and it is available. No
installer, no daemon, no account.

The flagship skill is **[architecture-visualizer](skills/architecture-visualizer/)** — a skill and CLI that
turns a feature, migration, refactor, or system design into a grounded, interactive architecture
visualization, and validates the result against a mechanical quality gate before presenting it.

It ships with **[delegate-fleet](skills/delegate-fleet/)** — one brain, many workers. Your orchestrating
model plans, briefs, verifies and commits; the implementation runs on whichever coding-agent CLI you
have. Workers are chosen by **capability**, never by price or reputation: ask for `edit`, `readOnly`
or `resumeById` and the fleet answers with the workers that can actually do it here. 20 backends ship
supported, third-party adapters load from your own project, and a relay sits between as a
deterministic trust boundary that reports facts and never decides whether work is good.

```
skills/
  architecture-visualizer/   grounded architecture visualization + `arch-viz` CLI
  delegate-fleet/            capability-based delegation to worker CLIs + `relay`/`fleet`
```

## See it work

The three reference scenarios that ship with the skill are the fastest way to inspect real output:

| Scenario | What it shows |
| -------- | ------------- |
| [CRUD business feature](skills/architecture-visualizer/examples/1-crud-business-feature/) | A new service, a changed valuation path, an append-only audit log. |
| [Database migration](skills/architecture-visualizer/examples/2-complex-database-migration/) | Zero-downtime partitioning, dual-write, CDC, shadow reads, five-phase cutover. |
| [Event-driven saga](skills/architecture-visualizer/examples/3-async-event-driven-workflow/) | Transactional outbox, Kafka, saga orchestration, DLQ triage, compensation. |

Each scenario folder contains the prompt, the spec JSON, the generated standalone HTML, and the
Markdown report. Open any `index.html` in a browser; it works offline.

## Quick start

Run these from a checkout of this repository. The commands are real, not illustrative.

```bash
git clone https://github.com/mohamed23231/skill-atelier.git
cd skill-atelier

# 1. Install the skill into the cross-client skills directory for this project
mkdir -p .agents/skills
cp -R skills/architecture-visualizer .agents/skills/architecture-visualizer

# 2. Or install it for every project you work on
mkdir -p ~/.agents/skills
cp -R skills/architecture-visualizer ~/.agents/skills/architecture-visualizer

# 3. Or skip the agent and use the CLI directly
node skills/architecture-visualizer/bin/arch-viz.js inspect .
```

Then ask your agent to visualize something, or drive the CLI:

```bash
node skills/architecture-visualizer/bin/arch-viz.js scaffold -o spec.json --base HEAD~1
node skills/architecture-visualizer/bin/arch-viz.js build spec.json -o dist/architecture.html --md dist/architecture.md
node skills/architecture-visualizer/bin/arch-viz.js validate spec.json --repo-root .
```

Per-harness install paths are in [docs/INSTALL.md](docs/INSTALL.md).

## Compatibility

Skills follow the open [Agent Skills](https://agentskills.io/specification) format: a directory with a
`SKILL.md` whose frontmatter has a `name` and a `description`. Any client that implements the format can
read them.

| Harness | Project directory | Personal directory |
| ------- | ----------------- | ------------------ |
| Cross-client standard | `.agents/skills/` | `~/.agents/skills/` |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| OpenCode | `.opencode/skills/` | `~/.config/opencode/skills/` |
| GitHub Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/`, `~/.agents/skills/` |
| Cursor | `.agents/skills/` | `~/.agents/skills/` |
| Codex CLI | `.agents/skills/` | `~/.agents/skills/` |

Client directories change between releases. The `.agents/skills/` path is the cross-client standard and is
the safest default; check a harness's own documentation before relying on a client-specific path.

**Runtime requirements:** the bundled `arch-viz` CLI requires **Node.js 22 or newer**. There are no
third-party runtime dependencies, and nothing here requires Python.

**Node 22+ is required only to run this tool.** The repository or system being inspected may use an older
Node version, another language or runtime, or a legacy stack. The tool reads repository evidence and emits
standalone artifacts; it never changes the target project's runtime, dependencies, or files.

## Skill catalog

| Skill | Description | Status |
| ----- | ----------- | ------ |
| [architecture-visualizer](skills/architecture-visualizer/) | Grounded, interactive architecture visualizations with a 14-point quality gate and a zero-dependency CLI. | Available |
| [delegate-fleet](skills/delegate-fleet/) | Capability-based delegation to 20 coding-agent CLIs. Verifies what each installed CLI can really do, bounds execution, distinguishes worker changes from your uncommitted work, and leaves review, acceptance and the commit with the orchestrator. | Available |

The catalog is intentionally small. New skills are held to the packaging rules in
[docs/MAINTAINERS.md](docs/MAINTAINERS.md).

## The `arch-viz` CLI

`arch-viz` is the engine behind the flagship skill. It is a plain Node script, so it runs anywhere Node 22+
does.

```bash
# Draft a spec from uncommitted changes or a diff against a ref (start here)
node skills/architecture-visualizer/bin/arch-viz.js scaffold [-o spec.json] [--base <ref>] [--repo-root <dir>]

# Compile a spec into a standalone interactive HTML page and a Markdown report
node skills/architecture-visualizer/bin/arch-viz.js build <spec.json> -o out.html [--md out.md] [--strict] [--direction LR|TB]

# Run the 14-point quality gate; --strict turns warnings into a non-zero exit
node skills/architecture-visualizer/bin/arch-viz.js validate <spec.json> [--strict] [--repo-root <dir>] [--json]

# Emit Mermaid as a fallback for tools that only render Mermaid
node skills/architecture-visualizer/bin/arch-viz.js mermaid <spec.json> [--view flowchart|sequence|er]

# Detect frameworks, databases, and queues in a repository as grounding evidence
node skills/architecture-visualizer/bin/arch-viz.js inspect [dir]

# Write a starter spec (refuses to overwrite an existing file)
node skills/architecture-visualizer/bin/arch-viz.js init [output.json]
```

The generated HTML is a single file with no CDN and no network access. It opens offline and can be attached
to a pull request or a message.

## How a change is verified

`architecture-visualizer` does not draw first. It inspects the repository, then models the system:

- Every node carries a status — `VERIFIED`, `INFERRED`, `ASSUMED`, or `UNKNOWN`.
- Every `VERIFIED` node must cite a file, API, or table, and the path is checked against the filesystem
  unless the spec declares itself illustrative.
- Sync and async edges are distinguished and labelled; a sequence step without a modelled edge renders as a
  dashed ghost link rather than silently highlighting nothing.
- The 14-point quality gate runs before the result is presented. Under `--strict` it fails the build.

Details are in the [skill README](skills/architecture-visualizer/README.md) and
[references/reasoning-checklist.md](skills/architecture-visualizer/references/reasoning-checklist.md).

## Safety and trust model

Skills are instructions that an agent will follow, so treat them like code you are about to run.

- **Read before you install.** A skill is plain Markdown plus, at most, small scripts. Inspect `SKILL.md`
  and any `scripts/` before copying it into a directory your agent trusts.
- **No network at runtime.** The bundled CLI reads local files and git state only. The generated
  visualization is fully self-contained and makes no requests.
- **No third-party runtime dependencies.** Nothing is fetched at skill run time. The test suite runs on
  Node's standard library.
- **Pin a revision.** Clone a tag or a commit rather than tracking a moving branch when you care about
  reproducibility.
- **`allowed-tools` is experimental.** Some clients can pre-approve tools a skill may run. Pre-approving
  shell access removes a confirmation step; do it only for skills you have reviewed and trust.
- **Report problems privately.** See [SECURITY.md](SECURITY.md) for the disclosure process.

## Repository layout

```
README.md                    this file
LICENSE                      MIT
CONTRIBUTING.md              how to propose a skill or a fix
CHANGELOG.md                 repo-level changes
docs/
  INSTALL.md                 per-harness install paths and subtree/submodule use
  ARCHITECTURE.md            how the repository and its CI fit together
  MAINTAINERS.md             the rules for adding a new skill
scripts/
  validate-repo.js           dependency-free structural checks
  test-all.js                runs every skill's test suite
skills/
  architecture-visualizer/   the flagship skill
.github/                     issue and PR templates, CI, release workflow
.claude-plugin/              optional Claude Code plugin marketplace entry
```

## Examples

The three scenarios linked under [See it work](#see-it-work) are the canonical examples. Each is built
from a plain-language prompt, and each passes `arch-viz validate --strict` with zero warnings.

## Roadmap

Planned and in-progress work. Nothing here is a commitment or a delivery date.

**Skill** (in `architecture-visualizer`):

- Interactive editing in the browser, writing the spec back out.
- In-place C4 drill-down from a container into its components.
- Structurizr DSL export and cloud provider icon sets.
- Virtual nodes per skipped rank so multi-tier edges reserve a corridor.
- A short reviewer report (`REVIEW.md`) generated from a spec.

**Repository**:

- Additional skills under discussion: code review, execution-flow tracing, change-safety verification.

## Contributing

Contributions are welcome, including narrow ones: a fixed typo, a new reference note, a failing test that
reproduces a bug.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- The rules for adding a skill are in [docs/MAINTAINERS.md](docs/MAINTAINERS.md).
- Report a vulnerability through the process in [SECURITY.md](SECURITY.md), not a public issue.
- Questions and ideas belong in [SUPPORT.md](SUPPORT.md) or a discussion.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT. See [LICENSE](LICENSE).
