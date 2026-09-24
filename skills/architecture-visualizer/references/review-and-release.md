# Review and Release Gates Reference

Architecture Visualizer 2.0 enforces a disciplined verification and review workflow before any architectural proposal or application code change is accepted.

---

## 1. The Six Lifecycle Gates

```
INSPECT → MODEL → VALIDATE → BUILD → REVIEW → RELEASE
```

### Gate 1: Inspect Gate
- **Objective**: Discover existing components, entrypoints, interfaces, database schemas, and dependencies in the target codebase.
- **Commands**:
  - `arch-viz inspect .` — Scans for framework signatures, databases, message queues, and directory structures.
  - `arch-viz scaffold -o spec.json` — Drafts a starter model directly from git diffs and import dependencies.
- **Rule**: Never invent ungrounded architecture. Identify real file paths and existing boundaries before creating or editing nodes.

### Gate 2: Model Gate
- **Objective**: Construct the structured version 2 architecture model.
- **Requirements**:
  - Assign every component to an explicit boundary (≤ 8 boundaries).
  - Explicitly badge status (`VERIFIED`, `INFERRED`, `ASSUMED`, `UNKNOWN`).
  - Classify delta states (`UNCHANGED`, `ADDED`, `CHANGED`, `REMOVED`, `MOVED`).
  - Discriminate communication modes (`sync` vs `async`) and `pathType`.
  - Capture ADRs in `meta.decisions`, explicit assumptions in `meta.assumptions`, and open questions in `meta.unresolvedQuestions`.
  - Link verified components to file, API, or table locators in `evidence`.

### Gate 3: Validate Gate
- **Objective**: Execute the 14-point mechanical and semantic quality gate.
- **Command**:
  ```bash
  arch-viz validate <spec.json> --repo-root .
  ```
- **Requirements**:
  - Ensure zero validation errors.
  - In CI/release pipelines, run with `--strict` so any unhandled warnings fail the check.
  - Confirm all `VERIFIED` files resolve on disk under the repository root (or declare `meta.grounding: "illustrative"` for teaching examples).
  - Resolve or explicitly justify any policy findings.

### Gate 4: Build Gate
- **Objective**: Compile the standalone, offline HTML artifact and companion Markdown document.
- **Command**:
  ```bash
  arch-viz build <spec.json> -o dist/architecture.html --md dist/architecture.md --strict --repo-root .
  ```
- **Requirements**:
  - Output is a single, self-contained HTML file (zero external CDN or runtime npm dependencies).
  - Companion Markdown report is updated with blast radius, ADRs, assumptions, findings, and evidence manifest.

### Gate 5: Review Gate
- **Objective**: Present the interactive artifact to engineers, architects, and stakeholders.
- **Review Checklist**:
  - Walk through the interactive scenario player.
  - Inspect the Before vs After delta diff (`ADDED`, `CHANGED`, `REMOVED`).
  - Examine the blast radius (upstream and downstream dependencies of changed components).
  - Discuss and resolve items in the Unresolved Questions panel.

### Gate 6: Release Gate
- **Objective**: Formal sign-off before modifying application code.
- **Rule**: **Always obtain explicit user or stakeholder approval** on the architecture proposal and implementation plan before modifying production application source files.

---

## 2. Browser & Accessibility Implementation Truth

The generated HTML viewer is an offline single-page application built on standard HTML5, CSS3, and vanilla ES6.

- **Responsive Four-Region Workbench**:
  1. *Header Bar*: Title, metadata, scenario controls, view tabs, search, and export actions.
  2. *Navigator Panel*: Searchable hierarchy of boundaries, nodes, and layers.
  3. *Main Canvas*: Deterministic SVG canvas with pan, zoom, minimap, and edge routing.
  4. *Inspector Drawer*: Component details, evidence, findings, tasks, and failure modes.
- **Mobile Support & Focus Restoration**: Tested across viewports 320px (mobile), 768px (tablet), and 1440px (desktop). On mobile viewports, panels open as accessible modal drawers with focus trapping and automatic focus restoration to the trigger element on close.
- **Search & Highlighting**: Live filtering across node labels, technologies, types, descriptions, and edge labels. Supports focus-neighbor and affected-path isolation.
- **Canvas Controls**: Fullscreen presentation mode, URL state synchronization for shareable view anchors, and model-namespaced `localStorage` persistence for custom node layout positions.
- **Non-Color State Indicators**: Information is never conveyed by color alone:
  - Distinct node shapes: Box (services), Cylinder (databases), Chevron (queues/topics), Pill (boundaries/actors).
  - Edge styles: Solid lines for synchronous RPCs, dashed lines for asynchronous messaging.
  - Status and delta badges carry explicit textual labels and high-contrast borders.
- **Motion & Accessibility**: Fully honors `prefers-reduced-motion` by disabling CSS transitions and halting auto-playing particle streams.
- **Keyboard Shortcuts**: Full keyboard navigation:
  - `F`: Fit to screen.
  - `0`: Reset zoom/pan.
  - `+` / `-`: Zoom in/out.
  - `A`: Toggle animated particle flow.
  - `Arrow keys`: Pan canvas.
  - `Esc`: Close open drawers, modals, or clear node selection.
  - `Tab` / `Shift+Tab`: Traverse focusable nodes and controls.

---

## 3. Automated Test Suite & Performance Truth

- **Automated Test Suite**: 129 automated tests pass cleanly with zero external runtime dependencies.
- **Real-Browser Testing**: Tests run in headless Chrome across 320px, 768px, and 1440px viewports, measuring rendered DOM boxes, SVG paths via `getPointAtLength`, label bounding boxes via `getBBox`, and absence of visual overlap.
- **Readiness Smoke Measurement**: A deterministic stress test of 100 nodes and 250 edges in real headless Chrome measured **74ms** readiness on the maintainer's machine.
  *(Note: This is reported strictly as a local reference measurement under specific hardware conditions, not as a universal benchmark or performance guarantee.)*

---

## 4. Known Limitations

To maintain architectural rigor and zero-dependency reliability, the following boundaries are explicit:

- **No In-Browser Editor**: The generated page is a read-only interactive viewer and exploration workbench. The spec JSON remains the single source of truth.
- **No Collaboration or Hosted Sharing**: There is no hosted cloud service, WebSocket collaboration server, or multi-user editing session. Files are shared as offline HTML or Markdown artifacts.
- **No Force-Directed Layout**: Layout is computed deterministically via hierarchical rank assignment and barycenter crossing minimization. Nodes do not float, spring, or bounce randomly.
- **No DOT or PDF Export**: Supported exports are standalone HTML, SVG (with inlined styles), PNG (rasterized via HTML5 canvas in browser), Markdown, and Mermaid diagram definitions.
- **Comprehension Budget**: While the engine renders hundreds of nodes, diagrams exceeding 25 nodes trigger a Quality Gate 1 glanceability warning, advising decomposition into subsystem views.
