# Changelog

All notable changes to the `architecture-visualizer` open-source skill will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Every scenario step reads as a sentence**: stages and interactions without an authored `narrative` get a generated one at build time ("Outbox Relay Worker sends Publish OrderCreated to Apache Kafka Event Bus. Payload: orderId=9901."), marked `narrativeGenerated` so the page and report can say so; authored narratives are never changed. The Markdown report gains a Scenarios section that tells each scenario as numbered steps, with outcomes nested under decisions and generated sentences marked. Scenarios with no authored narrative produce a validation notice (not a warning, so `--strict` builds are unaffected).
- **Freshness is real**: `arch-viz validate --stamp` records the commit the evidence was checked against as `meta.groundedAt`; `build` marks every evidence record whose file changed since then (or is untracked) as `stale` with `staleSince`, and records `meta.builtFrom`; `arch-viz validate --fresh` lists stale records and exits 1 on drift, so CI can block a stale diagram. Paths are matched relative to `--repo-root`, which may be a folder inside a larger repository. Illustrative specs are never stamped or checked, and their builds stay reproducible.
- **The lens engine** (`scripts/lenses.js`): Structure, Evidence, Change and Risk as pure functions from the model to an encoding per component and connection (stroke, line style, tint, badge words, struck name, muted text, exception marker), ghost connections for policies (forbidden and absent, required and missing, at most three unless one is selected) and a key listing only the states present. Encodings are token names, never colors, and never opacity, so a lens composes with any spotlight. Rendering them arrives with the lens switcher.
- **The walkthrough engine** (`scripts/walkthrough.js`): a scenario plus the reader's outcome choices becomes one path of numbered steps, decisions and outcome ends, with nested branches, parallel stages, a default outcome (`default: true`, else the first) and per-path step numbers; each entry says which components and connections it puts in focus, numbered markers for parallel hops, and ghost links for hops with no modelled connection.
- **A command palette (⌘K / Ctrl+K)**: one keyboard-first place to jump to any component, connection, view or scenario stage, and to run every workbench command (fit, reset, presentation, fullscreen, animate, theme, quality gate, copy link, show neighbours, show blast radius) and every export. Arrow keys, Home/End, Enter and Escape work as in any combobox; Escape returns focus to where it was and leaves the selection alone. It is the new home of the navigator's search, and the header Search button opens it at every width.
- **A trust model** (`scripts/trust.js`): per-component evidence state (Verified, Declared, Declared but not checked, Missing, Stale, Asserted, Planned, Inferred/Assumed/Unknown, the worst record deciding) and the summary behind the coming trust strip: grounding, evidence ("6/6 existing backed · 4 planned"), rule results, open items and the gate line ("13 of 14 pass · 1 skipped"). Every number comes from the validator's embedded output. A component lacks evidence only when it claims some that is not there; actors are not counted, since nothing in a repository can back them; and an empty model reads as unchecked, never as verified.

### Changed

- **A reading rail replaces the inspector drawer**: the right-hand rail holds chapters (Walkthrough, Review, Data, Plan) and a component sheet that opens over the current chapter, with Back to return and Show neighbours / Show blast radius on the sheet. Review gathers the quality gate, rules, findings, assumptions, open questions and decisions; Data and Plan replace the full-screen Data Model and Plan tabs, which no longer sit under the navigator. The rail docks at 1100px and wider (400px from 1280px), collapses and reopens from the header, and is a focus-trapped drawer below 1100px. Links gain `c=<chapter>`, and old `view=database_er` / `view=implementation_plan` links open the matching chapter. The gate panel, the two tabs and the header Focus/Impact buttons are gone; their features live in the rail and the palette.
- **Built pages drop leading indentation** (about 35 KB): no workbench text depends on it, and a test guards that.
- **Built pages are about 45 KB smaller**: the embedded specification and layout are written as compact JSON instead of indented JSON. The data is identical; example 3 drops from 390 KB to 344 KB, leaving room in the 400 KB offline budget for the reading rail.
- **The header no longer pushes its controls off screen**: a long title ellipsizes instead of overflowing, so on a phone the menu, theme and search buttons stay reachable. Below 1100px the header drops Present, Fullscreen, Animate, Focus and Impact, which are palette commands.
- **Shared links are version 2, and old links keep working**: the URL hash is now `#v=2&n=<node>&s=<scenario>&at=<stage id>&step=<step number>&cam=<x>,<y>,<width>…`. Scenario stages and sequence steps are linked by their authored id and number instead of a position, so a link survives stages being added before it. The camera is a world region (centre and visible width) instead of screen pixels, so a link frames the same part of the diagram on any screen size and keeps framing it while panels dock or the window settles, until the reader moves the camera. An untouched, fitted view and a link to a scenario stage carry no camera, so they fit whatever screen opens them. Version 1 links (`view`, `node`, `scenario`, `stage`, `z`, `x`, `y`, …) still restore exactly as before. A link naming a component, connection, scenario, stage or step the model no longer has drops that part and says so in one sentence ("Step stage_x no longer exists; showing the walkthrough start."), and a link from a newer version is not half-applied.
- **View state has one writer**: theme, view, selection, filter, search, focus, presentation, scenario, stage, sequence step and camera change only through the named actions in `scripts/store.js`; a test fails if any other module writes them directly. The URL codec (`scripts/url.js`) is pure and unit-tested on its own.
- **A design system for the workbench**: one token set for both themes (`styles/tokens.css`) with an accent that means active and ok, warn and risk that carry meaning; three type voices (interface sans, explanation serif, mono for protocols, paths and technology); and one line-icon set for every component kind and control, so no emoji remain. Cards show an icon tile, a name that wraps to two lines instead of being cut, technology in mono, at most one change badge, and a dashed ring when a component is not verified, in place of the bracketed `[VERIFIED] [CHANGED]` tags. Boundaries are quiet tinted lanes; highlighted edges end in an accent arrowhead; focus rings use the accent instead of amber; data-model keys are chips instead of `[PK]` and `[FK→x]`. Behavior and geometry are unchanged: node, edge and label positions, camera and URL state, and every control's role are identical to the previous release.
- **Accessible names for icon-only buttons**: close, zoom, fit, reset, theme and the panel toggles carry an `aria-label` now that their glyphs are icons; several had no usable name before.

- **The workbench template is split into modules**: the 3,600-line `src/engine/template.html` is now `src/workbench/shell.html` plus 8 style and 18 script modules, joined by `src/workbench/assemble.js` into the same single offline HTML file. Behavior is unchanged: the assembled template is byte-identical to the old file, and the built examples render pixel-identical at 1440×900 in both themes. New tests check that every module is included exactly once, that the compiled page loads nothing from outside the file, and that every example stays within a 400 KB budget.

### Fixed

- **SVG and PNG exports carry every color**: the export copied a hand-kept list of variables, three of which did not exist (`--bg-main`, `--border`, `--bg-elevated`), so exported files lost colors and always used a hard-coded dark background. Exports now resolve the full token list for the current theme, and component icons live inside the canvas so exported files include them.

- **The diagram opens fitted, and shared links restore**: during boot the scenario navigator wrote the default camera (`z=1&x=0&y=0`) into the URL before `restoreUrlState()` read it, so every page undid its own fit-to-screen and every shared deep link was overwritten before it could be applied. URL state is now written only after the incoming hash has been read, a missing `x`/`y`/`z` parameter no longer reads as `0`, and fit-to-screen uses the same zoom floor as the zoom controls so wide diagrams also fit on a phone.
- **Scenario stages light up the canvas**: stepping, scrubbing or playing a scenario now spotlights its participants and edges (and draws a ghost link for a hop with no modelled edge), a branch stage shows every path it can take, and Esc ends the walkthrough. The stage panel shows stage names, node labels and payloads instead of raw ids. Sequence playback and scenarios share one spotlight.
- **Flat scenario stages are normalized**: stages written as one hop (`type`, `from`/`source`, `to`/`target`, `label`, `payload`, …) and parallel stages that nest `stages` are lifted into the canonical `{ kind, interactions }` shape on ingest. They were previously neither rendered nor validated, so a bad node reference inside one passed silently. All three shipped examples used this shape.
- **Overlays no longer stack on each other**: the quality gate opens as a popover under its own button instead of underneath the navigator, the delta mode switch sits below the filter bar instead of over it, the sequence playback bar centres on the canvas, clears the minimap and zoom controls, and wraps onto two rows on narrow screens, and the legend is a collapsed disclosure stacked above the minimap, clear of the playback bar at any width.
- **Displaced edge labels keep a leader**: when collision avoidance pushes a label more than 24px from its edge, a thin dashed leader ties it back to the point on the curve it belongs to (`geometry.labelLeader`, with the curve point recorded as `labelTether`), so it no longer floats as an orphan.

- **Repository grounding is confined to the repository root**: evidence and `details.files` paths now have to resolve strictly under `--repo-root`. Absolute paths elsewhere, `../` escapes, symlinks that lead out of the root, and the root itself are `unresolved` and raise the new `evidence.outside_repo` finding and a Gate 13 warning (which fails `--strict`). Previously `/etc/hosts` could verify a node.
- **No machine-local paths in artifacts**: evaluated evidence records `resolvedPath` (repo-relative) instead of `absolutePath`, and the compiler rewrites absolute paths written in the spec (evidence locators and `details.files`) before embedding them: repo-relative when under the root, the file name alone otherwise. A `../` path that leaves the root is reduced the same way. Built HTML and Markdown no longer carry the author's home directory. `RepoInspector#verifyFiles` returns `insideRepo` and `resolvedPath` in place of `absolutePath`.
- **Outside-root evidence is reported for every node**: an `INFERRED` or `ASSUMED` node citing a path outside the repository also raises `evidence.outside_repo`. A missing file under a symlink that leads out of the repository is classified as outside too.
- **API evidence**: `locator.path` on `api` evidence is the route (`/api/orders`), so it is no longer checked as a file. Set `locator.file` to tie an endpoint to its handler file; without it the record stays `compatibility`.
- **Stricter symbol evidence**: a symbol must appear as a whole identifier, so `create` no longer verifies against `createOrder` or `createΩ` (Unicode identifier characters count), and it must fall inside `startLine`–`endLine` when a range is given.
- **`scaffold --repo-root <subdir>`**: paths are written relative to the requested root, so `validate --repo-root <subdir>` resolves them, and a changed symlink leading out of that root is scaffolded as `INFERRED`, not `VERIFIED`. Previously they were git-root-relative and failed Gate 13. `--ignore` prefixes are now matched against those root-relative paths.

- **Workbench panels**: inspector visibility is driven solely by `data-open`, panels use `role="dialog"`, closed panels are marked `inert` and `aria-hidden="true"`, and `aria-modal` is set only for open overlay drawers.
- **Workbench docking & canvas reflow**: docked panels reflow canvas and fit view when `userMovedView` is false; selection on canvas nodes opens inspector via `setDrawerOpen()` with proper responsive reflow and backdrop handling.
- **Tabs bar**: minimize toggle is placed outside `role="tablist"` navigation, vertical wheel scrolling respects scroll boundaries and deltaMode without locking vertical page scroll, and active view tabs synchronize on URL restoration and view switching.
- **Shape-aware geometry**: external nodes use matching 14px corner radius (`nodeCornerRadius`) so edge endpoints land accurately on the rendered outline.
- **Shipped examples**: regenerated from current template.

### Added

- **Illustrative marker**: specs with `meta.grounding: "illustrative"` show an *Illustrative* badge in the workbench filter bar, so example diagrams cannot pass for verified ones.

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
