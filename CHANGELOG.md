# Changelog

Notable changes to Skill Atelier are documented in this file. Individual skills keep their own changelog
next to their `SKILL.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for repository releases.

## [Unreleased]

### Added

- `delegate-fleet` is listed in the Claude Code plugin marketplace (`.claude-plugin/marketplace.json`).
- README: delegate-fleet 2.3.0 workflow (routes, checks with the fix loop, `batch.js`, `fleet.js
  report`, the benchmark).

- `skills/delegate-fleet/` 2.0.0: capability-based delegation. Workers are selected by what they can
  do rather than what they cost, with an explicit evidence state per capability and a clean
  separation between *supported by the framework*, *available on this machine*, and *verified for
  the installed version*. `fleet.js` discovers and verifies the local fleet; `relay.js` is a
  deterministic trust boundary that bounds execution, distinguishes worker changes from
  pre-existing uncommitted work, reconciles declared scope, and never verifies, accepts, or
  commits. 20 backends ship as one-file adapters, and projects can add their own without forking.
- Repository scaffold: root README, license, contribution and governance files, CI, release workflow, and
  dependency-free repository validation.
- `skills/architecture-visualizer/` 2.0.0 as the flagship skill: evidence verification, a policy engine,
  scenario playback, an offline four-region workbench, and the zero-dependency `arch-viz` CLI.
- Issue and pull-request templates, Dependabot configuration, and an optional Claude Code plugin
  marketplace entry.
- Maintainer documentation for packaging future skills consistently.

### Changed

- Repository validation now handles bare home paths, common Windows path forms, and fine-grained
  GitHub tokens. Private rule files are validated before use and cannot skip alternating matches.
- `scripts/validate-repo.js` no longer carries a denylist of private names. A public repository
  that lists the employer and project names it wants kept out has published them; those rules move
  to an optional, gitignored `.validate-repo-private.json`, documented in `docs/MAINTAINERS.md`.
  The built-in rules stay generic and gained absolute Windows home paths, private key material,
  GitHub tokens, `sk-` API keys and AWS access key ids.
- `scripts/validate-repo.js` skips paths that git already ignores. A tool's local state directory is
  not part of the repository, so it should not fail the personal-path rule on the machine that
  created it.
- Root tooling and CI run on Node.js 22 and 24. Node 22+ is required only to run the bundled CLI; target
  repositories are read-only and may use any runtime.

### Fixed

- Workbench panels: inspector visibility is driven solely by `data-open` (the × close control works reliably
  on desktop), and the navigator docks as a column on wide viewports instead of overlaying the canvas.
- Tabs bar: vertical mouse-wheel scrolling reaches hidden views, and a minimize toggle collapses the strip
  to the active tab.
- Edge endpoints now land on the drawn shape outline (queue/topic chevron, actor pill, database cylinder,
  rounded cards) instead of the rectangular bounding box, so arrows and flow-animation particles travel to
  the visible end of every edge.
- Shipped examples regenerated from the current template (they previously embedded an older UI).
