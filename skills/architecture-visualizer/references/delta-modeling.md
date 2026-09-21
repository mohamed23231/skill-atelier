# Delta Modeling: Before vs After Conventions

When visualizing an architectural change (new feature, refactoring, or migration), you must clearly distinguish what exists today from what is changing.

---

## 1. Delta Statuses

Every node and edge in a delta-aware architecture model must declare its `delta` status:

| Delta Status | Visual Marker | Color Code | Meaning |
|--------------|---------------|------------|---------|
| `UNCHANGED` | Standard outline | Slate / Muted | Existing component that remains untouched |
| `ADDED` | Solid border, `[+]` badge | Emerald / Green (`#34d399`) | Brand-new component, endpoint, table, or worker |
| `CHANGED` | Solid border, `[~]` badge | Amber / Yellow (`#fbbf24`) | Existing component whose interface, schema, or logic is modified |
| `REMOVED` | Dashed border, `[-]` strikethrough | Rose / Red (`#fb7185`) | Legacy component being deprecated or deleted |
| `MOVED` | Dotted border, `[→]` badge | Indigo / Purple (`#818cf8`) | Existing logic migrated to a new service or module |

---

## 2. The Three-State Delta View

The interactive visualizer provides three coordinated delta view modes:

1. **Current State (`current`)**:
   - Renders only `UNCHANGED`, `CHANGED`, and `REMOVED` components.
   - Hides `ADDED` components.
   - Represents the exact baseline as it functions today.

2. **Proposed State (`proposed`)**:
   - Renders only `UNCHANGED`, `CHANGED`, and `ADDED` components.
   - Hides `REMOVED` components.
   - Represents the target architecture after rollout.

3. **Delta Diff (`diff`)**:
   - Renders all components simultaneously.
   - Clearly highlights `[+ ADDED]` in green, `[~ CHANGED]` in amber, `[- REMOVED]` in red strikethrough, and dims `UNCHANGED` components.
   - Allows instant mental diffing of the blast radius.

---

## 3. Implementation Traceability for Deltas

For every node with `delta: ADDED` or `delta: CHANGED`:
- Must have at least one file linked in `details.files`.
- Must have implementation tasks in `details.tasks`.
- Must have associated failure modes or risks in `details.failureModes`.
- If database entities change, the table or column change must be listed in `views.database_er` with its delta status.
