---
name: architecture-visualizer
description: Use when designing, analyzing, refactoring, or documenting non-trivial software systems, distributed services, database migrations, or feature flows that require grounded repository evidence, boundary modeling, policy validation, and interactive offline visual workbenches.
license: MIT
metadata:
  version: "2.0.0"
---

# Architecture Visualizer

Act as a **Senior Software Architect** and **Technical Visualization Designer**. Turn software engineering requirements, refactoring plans, migrations, or distributed workflows into grounded, interactive, and verifiable architecture visualizations.

---

## The Seven-Phase Workflow

Follow this mandatory discipline before proposing any implementation:

```
INSPECT → SEPARATE EVIDENCE → CHOOSE VIEWS → VALIDATE → EXPOSE FINDINGS → ARTIFACT → APPROVAL
```

### 1. Inspect Before Drawing
Never invent ungrounded architecture. Before writing or modifying a specification:
- Search and inspect candidate files, routes, schemas, and configurations across the workspace.
- For diffs or branch reviews, run `arch-viz scaffold` to draft nodes and import-backed relationships from git.
- Identify system boundaries (client, edge/gateway, service, data, external) and trust perimeters.

### 2. Separate Verified Evidence from Inference
Ground every model entity in reality using the version 2 schema:
- **`VERIFIED`**: Directly backed by real files, symbols, endpoints, or tables. Every verified node must declare verifiable locators in `evidenceIds` or `details`.
- **`INFERRED`**: Deduced with high confidence from project patterns and surrounding conventions.
- **`ASSUMED`**: Design assumptions pending verification. Must be recorded in `meta.assumptions`.
- **`UNKNOWN`**: Flagged ambiguities requiring stakeholder clarification. Must be listed in `meta.unresolvedQuestions`.
- Classify proposed changes (`UNCHANGED`, `ADDED`, `CHANGED`, `REMOVED`, `MOVED`) and communication modes (`sync` vs `async`).
- See [`references/model-schema.md`](references/model-schema.md) for full v2 schema fields and normalization compatibility.
- See [`references/evidence-and-policies.md`](references/evidence-and-policies.md) for evidence verification states, locators, and policy kinds.

### 3. Choose Only Useful Views & Scenarios
Do not overload a single view. Structure models cleanly across coordinated lenses:
- **System Architecture**: High-level component topology and container boundaries.
- **Before vs After**: Delta diff isolating additions, modifications, and deprecations.
- **Data Flow**: Read, write, event, and replication paths with particle flow.
- **Scenarios**: Named sequential, parallel, or branching flows modeling user journeys, failure modes, and recovery sagas.
- See [`references/scenario-authoring.md`](references/scenario-authoring.md) for stage kinds, conditions, failure, and recovery metadata.

### 4. Validate with the 14-Point Quality Gate
Execute the validator mechanically before presenting any diagram:
```bash
arch-viz validate <spec.json> --repo-root .
```
In release or CI workflows, use `--strict` to ensure all warnings are resolved. Ensure:
- All labels fit card budgets (node label ≤ 22 chars, tech ≤ 28, edge label ≤ 32).
- Boundary containment and rank ordering are cycle-free and cleanly routed.
- Every verified component's files resolve on disk (or set `meta.grounding: "illustrative"` for teaching examples).
- Architectural policies (e.g. `forbidden_dependency`, `layer_direction`, `cycle`) pass cleanly.

### 5. Expose Questions and Policy Findings
Highlight risks and trade-offs explicitly:
- Present all unresolved questions from `meta.unresolvedQuestions` upfront.
- Display policy violations or structural warnings from `findings`.
- Document architectural decisions in `meta.decisions` (ADRs) with context, decisions, and consequences.
- Detail component failure modes, blast radius, and mitigations in `details.failureModes`.

### 6. Create the Standalone Offline Artifact
Compile the specification into a self-contained, dependency-free HTML workbench and companion Markdown summary:
```bash
arch-viz build <spec.json> -o dist/architecture.html --md dist/architecture.md --strict --repo-root .
```
The output file is completely offline (no CDNs, no external runtime dependencies). It includes:
- Four-region responsive workbench with navigator, canvas, minimap, and inspector drawers.
- Focus-neighbor and affected-path isolation, search, and URL state sharing.
- Interactive scenario player, Before vs After diff toggle, and data flow animations.
- Exports for standalone HTML, SVG, PNG (via browser canvas), Markdown, and Mermaid.

### 7. Obtain Explicit Approval Before Application Changes
**Mandatory Approval Gate**: Always present the generated HTML artifact, ADRs, risk analysis, and phased implementation plan to the user. **Wait for explicit approval before creating or modifying application source code.**
- See [`references/review-and-release.md`](references/review-and-release.md) for lifecycle gates, accessibility standards, and known limits.

---

## Truthful CLI Reference

Run using Node.js 22+ (directly or via `bin/arch-viz.js`):

> **Target Compatibility**: Node.js 22+ is required only on the machine executing the Architecture Visualizer CLI. The repository or system being inspected may use an older Node version, another language/runtime, or a legacy stack. Architecture Visualizer reads repository evidence and emits standalone artifacts; it does not change the target project's runtime or dependencies.

```bash
arch-viz inspect [dir]                                                                      # Inspect repository frameworks and signatures
arch-viz scaffold [-o spec.json] [--base <ref>] [--repo-root .] [--ignore <prefix>]        # Draft a starter spec from git diff & imports
arch-viz validate <spec.json> [--strict] [--repo-root .] [--json]                          # Run 14-point quality gate and policy checks
arch-viz build <spec.json> [-o out.html] [--md out.md] [--strict] [--direction LR|TB]     # Compile offline HTML workbench & Markdown report
arch-viz mermaid <spec.json> [--view flowchart|sequence|er]                                # Export to Mermaid diagram syntax
arch-viz init [output.json]                                                                # Generate clean starter specification
```

---

## Installation & Cross-Agent Setup

This skill is manually installed by copying or cloning into your agent's skill directory:

| Environment | Directory Path | Setup |
| --- | --- | --- |
| **Claude Code** | `.claude/skills/architecture-visualizer` | Clone/copy repository into `.claude/skills/` |
| **Agents / Cursor** | `.agents/skills/architecture-visualizer` | Clone/copy repository into `.agents/skills/` |
| **OpenCode** | `.opencode/skills/architecture-visualizer` | Clone/copy repository into `.opencode/skills/` |
| **Manual CLI** | Any local path | Run directly: `node path/to/bin/arch-viz.js <command>` |

*(Note: Skills must be cloned or copied into the target directory; they are not automatically installed over the network.)*
