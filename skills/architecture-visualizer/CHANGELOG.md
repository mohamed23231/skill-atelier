# Changelog

All notable changes to the `architecture-visualizer` open-source skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Fixed

- **Workbench panels**: inspector visibility is driven solely by `data-open`, panels use `role="dialog"`, closed panels are marked `inert` and `aria-hidden="true"`, and `aria-modal` is set only for open overlay drawers.
- **Workbench docking & canvas reflow**: docked panels reflow canvas and fit view when `userMovedView` is false; selection on canvas nodes opens inspector via `setDrawerOpen()` with proper responsive reflow and backdrop handling.
- **Tabs bar**: minimize toggle is placed outside `role="tablist"` navigation, vertical wheel scrolling respects scroll boundaries and deltaMode without locking vertical page scroll, and active view tabs synchronize on URL restoration and view switching.
- **Shape-aware geometry**: external nodes use matching 14px corner radius (`nodeCornerRadius`) so edge endpoints land accurately on the rendered outline.
- **Shipped examples**: regenerated from current template.

---

## [2.0.0] - 2026-09-21

Major architecture modeling and workbench release introducing the version 2 model schema, first-class evidence verification, policy enforcement, multi-scenario playback, and an overhauled responsive four-region workbench.

### Added

- **Version 2 Model Schema**: Introduced `schemaVersion: 2` with full backward-compatibility normalization for version 1 specifications.
- **Evidence Verification Subsystem**: First-class `evidence` array supporting `file`, `symbol`, `api`, `table`, `command`, `document`, and `assertion` locators with automated verification status evaluation (`verified`, `unresolved`, `stale`, `asserted`, `compatibility`).
- **Policy Engine & Structured Findings**: Built-in and customizable policies (`forbidden_dependency`, `required_dependency`, `layer_direction`, `cycle`, `required_evidence`, `fan_in`, `fan_out`, and `evidence.*`) with structured `findings` reported across the CLI, workbench, and Markdown reports.
- **Execution Scenarios**: Multi-scenario player supporting named serial, parallel, and branching stages with guard conditions, payload details, optional steps, failure modes, and automated recovery actions.
- **Review & Traceability Metadata**: Automated blast radius calculation (upstream and downstream dependencies of modified components), explicit assumptions, unresolved stakeholder questions, and implementation task traceability.
- **Responsive Four-Region Workbench**: Overhauled UI comprising a unified header bar, collapsible hierarchical navigator, main SVG canvas with minimap, and inspector drawers.
- **Mobile & Accessibility Enhancements**: Modal drawer behaviors on mobile viewports (320px/768px) with focus trapping and focus restoration on close; complete keyboard shortcuts; high-contrast non-color state indicators (shapes, borders, line dashes); and native `prefers-reduced-motion` support.
- **Canvas Exploration**: Focus-neighbor and affected-path isolation, search across nodes and edges, fullscreen presentation mode, URL state synchronization, and model-namespaced `localStorage` layout persistence.
- **Shared Geometry Runtime**: Unified `geometry.js` shared between compiler and client runtime providing reciprocal routing, port allocation, total visual bounds computation, and deterministic label collision avoidance.
- **Headless Chrome Automated Test Suite**: Expanded automated suite to 129 passing tests, including real Chrome validation at 320px, 768px, and 1440px viewports. A deterministic 100-node / 250-edge real-Chrome readiness smoke test measured 74ms on the maintainer machine (reported as a local reference measurement, not a universal benchmark).

### Changed

- **Normalization Standard**: V1 specifications with legacy `details.files`, `details.apis`, `details.tables`, and `views.sequence.steps` are automatically normalized into first-class `evidence` and `scenarios` structures.
- **Quality Gate Integration**: Quality Gate checks evaluate evidence resolution and policy findings alongside visual legibility metrics.
- **Package & Author Metadata**: Updated package version to `2.0.0` with author set to `Skill Atelier contributors`.

---

## [1.3.0] - 2026-09-17

Rendering-correctness release. Driven by visual correctness analysis of the generated page; every defect below
was reproduced and measured before it was changed, and re-measured after.

### Added

- `tests/rendered.test.js` — builds each example, runs it in **headless Chrome**, and asserts
  against the rendered DOM: path ends via `getPointAtLength`, every box via `getBBox` (so cylinder,
  chevron and pill node shapes are measured, not silently skipped), no label overlapping another
  label or a node, endpoints 6-20px outside their target, zero console errors. Skips cleanly when
  no browser is present. Mutation-verified: forcing `EDGE_END_GAP = 0` fails it with the offending
  edge and target named.
- Port distribution: edges arriving on the same node face fan out along it instead of stacking.
- Candidate-route scoring extended with a curve-sanity score that rejects a route whose curve
  reverses direction, folds back, or loops near its own end point.
- Deterministic label-overlap resolution pass after placement, plus endpoint zones as obstacles so
  a chip cannot cover an arrowhead.
- Boundary drag: a boundary moves with every node inside it, via a full-width invisible header hit
  strip (the title's real hit area was 13x5px of glyph).
- Regression tests for arrowhead orientation, arrowhead/line alignment, and shared arrival points.

### Fixed

- **Arrowheads scaled with stroke width.** The markers had no `markerUnits`, so SVG defaulted to
  `strokeWidth`: ~10.5px normally and ~21px on a highlighted edge. Now `userSpaceOnUse` at a fixed
  size.
- **Arrowheads stacked into a star-shaped blob** where several edges shared one arrival point
  (3 such points in the saga example). Port distribution fixes it: 0.
- **Arrowheads pointed the wrong way** — 18 of 43. SVG orients a marker along the curve's end
  tangent, which is set entirely by the last control point; `skip` and `sibling` detour routes put
  it off-axis. The last control point now sits on the arrival face's inward normal.
- **Arrowheads were rotated away from their own line** — 23 of 43, up to 63 degrees. Fixing the
  previous item snapped the tangent perpendicular while the curve body still arrived at an angle,
  leaving a visible corner under the arrow. Approach distance is now proportional to endpoint
  separation instead of a fixed 12-28px clamp. Worst case is now 10 degrees.
- **Curves folded back on themselves** between vertically adjacent cards: the sibling detour bowed
  ~140px sideways to cross a 34px gap.
- **Label chips overlapped** (`state + handlers` rendered as `tate + handlers`).
- **The boundary header painted the browser's default focus ring** over its label —
  `.boundary-toggle` had `tabindex="0"` but no `:focus-visible` rule.
- **Boundary tiers had ragged bottoms** (six tiers ending at 268/528/398/528/398/398). Equalised as
  a render-time display height; no node or edge moves.
- Contrast: light-theme accents darkened, badge tints split out with `currentColor` borders,
  `.filter-chip.active` corrected. Dead `--accent-indigo` removed; the dot grid was invisible in
  both themes (1.12:1 and 1.08:1).
- No `resize` handling at all: `overflow: hidden` plus a fixed transform stranded content with no
  way back. Added `dvh` units with `vh` fallbacks, a responsive inspector width, and a debounced
  re-fit gated behind a "user moved the view" latch.
- `validate --json` ignored `--strict`, so CI passed specs that failed locally.

### Changed

- Verification standard: model-level assertions are no longer sufficient on their own. Several
  checks in 1.2.0 scored a visibly broken page as clean, because they measured `computeLayout`'s
  output rather than what the browser paints. Rendered-DOM assertions are now the primary guard.
- Test count 67 -> 83.

---

## [1.2.0] - 2026-09-17

Review release. Three independent reviews (UI/UX, architecture, teaching) ran against the 1.1.0 output; everything
below was reproduced before it was changed, and measured after.

### Added

- `arch-viz scaffold` — drafts a spec from `git status` or `git diff --name-status <base>`: one node per changed
  file, boundaries grouped by directory, `delta` from the git status code, deleted files marked `INFERRED`/`REMOVED`,
  and edges derived from real `import`/`require` statements. Runs in under a second on a 21-file diff.
- `build` opens the generated page in the default browser by default; `--no-open` / `ARCH_VIZ_NO_OPEN=1` suppress it.
- Candidate-route scoring in the layout engine: each edge is drawn with the least-colliding of several deterministic
  routes (direct, channel above/below the content band via the side or the face, sibling detour left/right).
- Two-dimensional label placement: the anchor search now walks nine points along the curve **and** nine perpendicular
  offsets, treating other placed labels and boundary headers as obstacles.
- 25 tests (67 total), covering the diff scaffold, hostile placeholder content, CLI exit codes, label anchoring,
  edge/card crossings, and `failureModes` shape handling.

### Fixed

- **`failureModes` authored as strings rendered as `undefined`.** Both the Markdown report and the inspector read
  `{failure, impact, mitigation}`; the shipped spec used plain strings, so 7 real risk notes printed as
  `⚠️ **undefined** (Impact: *undefined*) -> Mitigation: undefined`. Both renderers now accept either shape, and the
  validator raises a hard error on an object with no `failure` text.
- **Placeholder substitution could emit a syntactically broken page and exit 0.** Placeholders were resolved left to
  right, so spec content containing a later placeholder's literal text was rescanned and replaced. Offsets are now
  computed against the pristine template and spliced from the last one backwards; duplicates are rejected.
- **`.delta-removed .node-rect` set `opacity: 0.6`**, making REMOVED cards translucent so edges and labels bled
  through them. Now `stroke-opacity`, leaving the card opaque.
- **Edge labels were pinned to `t = 0.5`** with no awareness of node boxes. Measured across the three examples and
  the working-tree diagram: 12 labels sat on a card and 1 pair overlapped; now 0 and 0.
- **The label anchor search compared a full collision sum against partial sums** (an early `break` that only fired
  once a best existed), making the winner depend on node array order.
- **The compiler and the browser reserved different label widths** (`len*5.6+12` vs `len*6.5`), so a "collision-free"
  anchor was not collision-free and labels jumped on the first drag. Both now use one `estimateLabelWidth`.
- **Backward edges exited through the top of their own card**, arching through whatever sat above them in the same
  column; they now leave sideways like a mirrored forward edge.
- **Edges spanning two or more tiers ran at near-constant `y` straight through every card in between.** Routing
  through a channel plus candidate scoring cut edges crossing a non-endpoint card from 14/43 to 6/43.
- **`scaffold --repo-root <subdir>` produced a wrong spec**: git reports paths relative to the repository root, so
  every node was mis-badged `INFERRED` and every edge lost. The real root is resolved with `rev-parse --show-toplevel`
  and `--repo-root` now scopes the diff instead.
- **`scaffold` invented edges from imports mentioned in comments and string literals**, and resolved an ambiguous
  trailing path to whichever file sorted first. Comments and strings are stripped; an ambiguous match yields no edge
  and is recorded in `meta.assumptions`.
- **`validate --json` ignored `--strict`** and exited 0 on warnings — the exact mode CI uses.
- **Status and delta badges had no matching CSS.** Only `.PROPOSED` and `.ACCEPTED` existed, so `VERIFIED`,
  `CHANGED`, `IN_REVIEW`, `REMOVED` and the rest rendered as bare uppercase text.
- **`.edge-path.read` cancelled the async dash** at equal specificity, leaving async encoded by colour alone.
- **`fitToScreen` counted its padding twice and then discounted by 0.9**, fitting at 0.52 zoom — card text landed at
  under 7px. Now 0.69 on the same diagram.
- **`resetView` showed 58% of the canvas anchored top-left**; it now clears selection and fits.
- Non-`VERIFIED` status text used `--text-dim` (3.07:1 at 9px); it is now amber at 10px.
- `init` and `scaffold` crashed with a raw `ENOENT` stack on a nested output path.
- `scaffold` id suffixes compounded (`card_card_2_3`); non-ASCII paths were C-quoted by porcelain v1 and never
  resolved (both now use `-z`).
- `openInBrowser` reported success before `spawn` could fail.
- Header tab labels wrapped onto three lines; they are now a single non-wrapping, scrollable row, and the subtitle
  is clamped to one line with the full text in its tooltip.

### Changed

- Gate 5 ("Clean routing") now **measures the drawing**: it samples every computed curve and counts the ones passing
  through a card that is not an endpoint. It previously counted rank distance and passed diagrams whose edges were
  drawn straight over components. Tolerance is 15% of edges; above that it warns and names them.
- Card metrics tightened for legibility: 240×110 → 200×96, title 13px → 15px, technology 11px → 10px uppercase,
  badges 9px → 10px, boundary gutter 90 → 120 with padding 36 → 20.
- Edge labels are painted at a maximum of 20 characters, with the full text in the element tooltip.
- `examples/2-complex-database-migration` pins `order` on its CDC tier, which removes a real edge/card crossing.

---

## [1.1.0] - 2026-09-17

Correctness release. Several 1.0.0 capabilities were documented but not implemented; they are implemented now, and
the documentation was rewritten to describe only what the code does.

### Added
- **Working exports**: SVG (theme variables inlined), PNG (2× canvas rasterization), Markdown report, and Mermaid
  source in a copyable modal, alongside standalone HTML. 1.0.0 shipped an HTML-only button.
- **Collapsible boundaries**: clicking (or keyboard-activating) a boundary title collapses the tier into a pill and
  hides its nodes *and their edges*. In 1.0.0 `collapsedBoundaries` was declared in state and never used.
- **Working Data Flow tab**: keeps `read` / `write` / `event` / `replication` paths, dims control traffic, starts the
  animation. In 1.0.0 the tab did nothing.
- **Executable quality gate**: `validateArchitecture` now returns all 14 gate results (`PASS` / `WARN` / `SKIP`), the
  CLI prints them, `compileArchitecture` embeds them in the page, and the Markdown report tabulates them.
  New checks: legibility, density, routing spans, layout determinism (computed twice and compared), inspector
  content, assumption justification, `VERIFIED` evidence, and implementation traceability.
- **CLI**: `mermaid` and `inspect` commands; `--strict`, `--repo-root` and `--json` on `validate`; `--repo-root` on
  `build`; unknown commands/options and missing option values now exit non-zero; `init` refuses to overwrite.
- **Slash commands** in `commands/` (`/visualize`, `/architecture`, `/design`, `/review-architecture`) with an install
  step. 1.0.0 claimed Claude Code registered them automatically; it does not.
- **Accessibility & input**: focusable nodes and boundary toggles with `role`/`aria-label`, Enter/Space activation,
  `<title>` tooltips carrying untruncated text, keyboard shortcuts (`F`, `0`, `+`/`−`, `A`, arrows, `Esc`),
  one-finger touch panning, shape-based node encoding (cylinder, chevron, pill, dashed border) so meaning never
  depends on colour alone, and `prefers-reduced-motion` support.
- **Theming**: follows `prefers-color-scheme` on first load and persists the manual toggle in `localStorage`.
- **Tests**: 42 cases across validator, layout, compiler/exporter and CLI suites, with per-case reporting.
- **`meta.grounding: "illustrative"`** to mark teaching examples whose file paths are not meant to exist.

### Fixed
- **Dangling edges**: hiding a node in `Current State` / `Proposed State` left its edges floating. Visibility is now
  computed in one pass over nodes *and* edges.
- **Edge labels during drag**: dragging a node moved its curves but left the labels behind; labels now follow, and the
  browser re-uses the compiler's bezier maths, including the backward and self-edge cases the drag handler ignored.
- **Label anchoring**: labels sit on the curve (cubic at t=0.5) instead of at the straight-line midpoint, which put
  them off the path on arcs.
- **Same-rank and self edges**: previously routed right-edge-to-left-edge and looped back through the node; they are
  now classified as `sibling` / `self` and routed accordingly.
- **Script injection**: spec JSON is `\u003c`-escaped before inlining, so a `</script>` in a description can no longer
  break out of the page; every DOM sink (inspector, ER view, plan view) escapes HTML.
- **`$&` corruption**: template placeholder substitution used `String.replace`, so a `$&` or `$'` inside the spec
  mangled the embedded JSON. Replacement is now literal.
- **Sequence player**: leaving the tab left nodes stuck in the selected state; steps with no backing edge highlighted
  nothing silently and now draw a dashed ghost link (and warn at validation time). `durationMs` per step is honoured.
- **Layout crash**: `computeLayout` threw a bare `TypeError` on a spec without `nodes`; it now fails with a message
  that says to validate first.
- **Non-deterministic particles**: initial particle offsets used `Math.random()` and the speed was per-frame, so the
  animation ran twice as fast on 120 Hz displays. Offsets are index-derived and the speed is time-based.
- **Crossing minimization**: 1.0.0 sorted nodes by in-degree and called it barycenter ordering. Real iterative
  barycenter sweeps are now implemented, with explicit `order` still pinning a node.
- **CLI `--strict` on validate** was documented but never parsed; `--md` no longer claims a default it does not have.

### Changed
- Examples are now `grounding: "illustrative"`, carry labels that fit the card, cite evidence for every `VERIFIED`
  node, include the saga's compensation edges that the sequence already referenced, and pass `validate --strict`.
- README rewritten: the "25 diagram types" claim is now a lens → view mapping, the layout engine is described as
  barycenter ordering over boundary ranks (not a full Sugiyama pipeline), and limitations list what is genuinely
  missing (no in-place C4 drill-down, PNG needs a browser, ER view is a card list).

---

## [1.0.0] - 2026-09-17

### Added
- **Initial Open Source Release** of `architecture-visualizer` for Claude Code, Cursor, and software engineering teams.
- **Core Reasoning Principle**: Implemented the 6-phase architectural workflow: `UNDERSTAND → MODEL → CHOOSE DIAGRAMS → VISUALIZE → VALIDATE → EXPLAIN`.
- **25 Supported Diagram Types**: Documented diagram selection matrix across system architectures, C4 models, data flows, sequence lifecycles, database ER diagrams, sagas, and migrations.
- **Deterministic Hierarchical Layout Engine**: Sugiyama-style rank assignment, barycenter crossings minimization, and smooth cubic bezier edge routing with zero random placement.
- **Zero-Dependency Interactive HTML Viewer**:
  - Fullscreen SVG canvas with matrix-based pan and smooth wheel zoom.
  - Draggable nodes with real-time dynamic edge updates.
  - Collapsible hierarchical boundary containers (`Frontend`, `API Gateway`, `Core Services`, `Data Tier`, `External`).
  - Side Inspector Drawer displaying responsibilities, repo source files, APIs, DB tables, test suites, checkable implementation tasks, and failure modes.
  - 1-click "Highlight Dependency Chain" isolating upstream and downstream blast radius.
  - Animated SVG particle flows communicating synchronous requests vs asynchronous events.
  - Step-by-step sequence player with Prev, Next, Play/Pause, and scrubber slider.
  - Before vs After 3-mode toggle: `Current State`, `Proposed State`, and `Delta Diff` (`ADDED`, `CHANGED`, `REMOVED`).
  - Search and filter bar by layer, delta status, and verification status.
  - Dual dark/light theme support.
  - Export suite: standalone HTML, SVG, PNG, Markdown reports, and Mermaid code.
- **Grounded Truth Verification**: Badges components as `VERIFIED`, `INFERRED`, `ASSUMED`, or `UNKNOWN`, verifying file paths against the repository on disk.
- **14-Point Quality Gate & Validator**: Automated structural and cross-reference validation engine.
- **Command-Line Interface (`arch-viz`)**:
  - `arch-viz build <spec.json>`: Compiles spec into interactive HTML and companion Markdown.
  - `arch-viz validate <spec.json>`: Runs quality gate validation.
  - `arch-viz init [output.json]`: Scaffolds a complete starter architecture model.
- **Three Realistic Production Scenarios**:
  1. *CRUD Business Feature*: Supplier Discounts & Volume Rebates in Inventory Valuation.
  2. *Complex Database Migration*: Zero-Downtime Monolithic Orders Table Partitioning with Dual-Writes & Debezium CDC.
  3. *Asynchronous Event-Driven Workflow*: Distributed Order Fulfillment Saga with Outbox Pattern, Kafka, DLQ, and Compensating Rollbacks.
- **Zero-Dependency Test Runner**: Comprehensive unit test suites for validator, layout engine, and compiler.
