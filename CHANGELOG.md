# Changelog

Notable changes to Skill Atelier are documented in this file. Individual skills keep their own changelog
next to their `SKILL.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) for repository releases.

## [Unreleased]

### Added

- Repository scaffold: root README, license, contribution and governance files, CI, release workflow, and
  dependency-free repository validation.
- `skills/architecture-visualizer/` 2.0.0 as the flagship skill: evidence verification, a policy engine,
  scenario playback, an offline four-region workbench, and the zero-dependency `arch-viz` CLI.
- Issue and pull-request templates, Dependabot configuration, and an optional Claude Code plugin
  marketplace entry.
- Maintainer documentation for packaging future skills consistently.

### Changed

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
