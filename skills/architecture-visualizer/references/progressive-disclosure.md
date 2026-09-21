# Progressive Disclosure in Architecture Visualization

One of the most frequent mistakes in software diagrams is dumping 100 flat boxes onto a single canvas. This results in visual exhaustion and unreadable diagrams.

Arch-Viz prevents this through **Progressive Disclosure**: revealing details only as the reader needs them.

---

## 1. The 3 Tiers of Progressive Disclosure

### Tier 1: Glancable Top-Level Architecture
- What the user sees upon initial render:
  - Clear, tidy boundary containers (`Frontend`, `API Gateway`, `Core Services`, `Data Tier`, `External Services`).
  - High-level nodes with clear names and technology labels.
  - Directional edges showing the core communication pathways.
- Result: The user understands system topology in 15 seconds.

### Tier 2: Interactive Exploration & Drilling In
- When the user wants to understand relationships:
  - **Click any node:** The Inspector Drawer slides in, displaying:
    - Complete responsibility summary.
    - Upstream and downstream dependencies.
    - Linked repository files and API contracts.
    - DB tables, test suites, and tasks.
  - **Dependency Highlighting:** Clicking "Highlight Dependency Chain" dims the rest of the canvas and highlights only the upstream and downstream blast radius.
  - **Collapsible Boundaries:** Click a boundary title (or focus it and press Enter) to collapse the whole tier into
    a pill. Its nodes and every edge touching them disappear together, so a collapsed tier never leaves dangling arrows.

### Tier 3: Coordinated Deep-Dive Views
- When the user needs a specialized lens, switch view tabs:
  - **Before vs After:** To examine a migration or refactor blast radius.
  - **Data Flow:** To follow data transformation with animated particle packets.
  - **Sequence Flow:** To walk step-by-step through a complex request or saga.
  - **Database ER:** To view physical tables, foreign keys, and indexes.
  - **Implementation Plan:** To review phased engineering tasks and PR breakdowns.

---

## 2. What This Skill Does NOT Do (and what to do instead)

There is no in-place child expansion: clicking `Orders Service` does not unfold `OrdersController` /
`OrdersRepository` inside the same canvas. Boundaries collapse, nodes do not.

For a genuine C4 drill-down, emit **one spec per level** and link them from the Markdown report:

```
architecture-context.json     # C4 L1 - systems and actors
architecture-container.json   # C4 L2 - deployable units inside one system
architecture-orders.json      # C4 L3 - components inside the Orders container
```

Each level stays inside the ~25-node comprehension budget that gate 1 enforces, which is the outcome progressive
disclosure is really after. Child-node expansion is on the roadmap.
