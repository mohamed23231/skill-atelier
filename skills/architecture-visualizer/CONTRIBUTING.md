# Contributing to Architecture Visualizer

Thank you for contributing to `architecture-visualizer`! This project is an open-source tool for engineers and AI coding assistants to design, verify, and visualize software architecture interactively.

---

## Code of Conduct

We are committed to providing a welcoming, inclusive, and harassment-free experience for everyone. Please be respectful and constructive in discussions, code reviews, and issue threads.

---

## Development Setup

The project is built with standard, modern Node.js (v22+) without heavy external dependencies.

```bash
# Clone the repository and enter the skill directory
git clone https://github.com/mohamed23231/skill-atelier.git
cd skill-atelier/skills/architecture-visualizer

# Run the test suite
node tests/run-tests.js
```

---

## Project Structure

```
architecture-visualizer/
├── README.md                  # Comprehensive open-source documentation
├── LICENSE                    # MIT License
├── SKILL.md                   # Claude Code Skill definition
├── CHANGELOG.md               # Version history
├── CONTRIBUTING.md            # Contribution guidelines
├── package.json               # Package metadata and scripts
├── bin/
│   └── arch-viz.js            # Executable CLI tool
├── src/
│   ├── index.js               # Library entry point
│   ├── engine/
│   │   ├── template.html      # Standalone interactive visualization HTML template
│   │   ├── layout.js          # Deterministic hierarchical & rank layout engine
│   │   ├── validator.js       # Architecture schema & quality gate validator
│   │   └── compiler.js        # Compiles architecture JSON into standalone HTML & Markdown
│   └── utils/
│       ├── repo-inspector.js  # Inspects git repository, discovers components & files
│       └── mermaid-exporter.js # Generates Mermaid fallback code
├── references/
│   ├── model-schema.md        # Version 2 specification schema and normalization
│   ├── evidence-and-policies.md # Evidence verification states and policy kinds
│   ├── scenario-authoring.md  # Scenario stages, conditions, failure, and recovery
│   ├── review-and-release.md  # Lifecycle gates, accessibility, and known limits
│   ├── diagram-selection.md   # Choosing among diagram lenses and views
│   ├── c4-model-guide.md      # C4 Context, Container, Component, Code guide
│   ├── progressive-disclosure.md # Hierarchical drill-down guide
│   ├── delta-modeling.md      # Before vs After conventions
│   └── reasoning-checklist.md # 14-point quality gate & architectural reasoning
├── examples/                  # Realistic reference scenarios
│   ├── 1-crud-business-feature/
│   ├── 2-complex-database-migration/
│   └── 3-async-event-driven-workflow/
└── tests/                     # Unit test suites & runner
```

---

## Guidelines for Changes

1. **Zero External Runtime Dependencies**:
   - The generated HTML files must remain 100% self-contained and run locally offline in any modern browser without requiring `npm install` or remote CDNs for core features.
2. **Layout Determinism**:
   - Any modifications to `src/engine/layout.js` must maintain deterministic positioning. The exact same input specification must produce identical coordinates across runs.
3. **Quality Gate Integrity**:
   - Changes must preserve the 14-point Quality Gate checks and pass `node tests/run-tests.js`.
4. **No Code Modification During Architecture Phase**:
   - When using this tool within Claude Code, the agent must present the architecture visualization and implementation plan first and await user approval before editing codebase files.

---

## Submitting a Pull Request

1. Fork the repository and create your feature branch:
   ```bash
   git checkout -b feature/interactive-minimap
   ```
2. Make your modifications and verify all tests pass:
   ```bash
   node tests/run-tests.js
   ```
3. Re-build the examples to verify visual output:
   ```bash
   node bin/arch-viz.js build examples/1-crud-business-feature/architecture.json -o examples/1-crud-business-feature/index.html
   ```
4. Commit your changes with a conventional commit message (`feat:`, `fix:`, `docs:`, `test:`).
5. Open a Pull Request with a clear description of the feature or fix.

## Running the tests

```bash
node tests/run-tests.js
```

129 zero-dependency cases across six suites (validator, layout, compiler/exporter, CLI, diff scaffold, and
rendered DOM). Add a case as a `[name, fn]` pair in the relevant `tests/*.test.js` array; the runner reports
and counts each one.

## Verifying browser behaviour

The rendered-DOM suite drives a headless browser and skips cleanly when none is available. To verify UI
changes manually, compile an example and assert on the DOM in a headless browser:

```bash
node bin/arch-viz.js build examples/3-async-event-driven-workflow/architecture.json -o /tmp/probe.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --virtual-time-budget=5000 --dump-dom file:///tmp/probe.html | grep -c 'class="node-group'
```

Inject a small probe script before `</body>` to drive `switchView`, `toggleBoundary`, `goToSequenceStep` and
`runExport`, and assert there are no `window.onerror` entries.

## Layout engine invariants

Any change to `src/engine/layout.js` must keep these true (the layout suite enforces them):

- the same spec produces byte-identical coordinates on repeated runs;
- every node stays inside its boundary box;
- an explicit numeric `order` always wins over barycenter ordering;
- every edge is classified `forward`, `sibling`, `backward` or `self`, and the label anchor sits on the curve;
- the browser's drag-time geometry in `template.html` stays in sync with `buildEdgeGeometry`.
