# Senior Architect Reasoning & Quality Gate Checklist

The core principle of this skill is:

```
UNDERSTAND → MODEL → CHOOSE DIAGRAMS → VISUALIZE → VALIDATE → EXPLAIN
```

Do not start drawing immediately. Before generating any visualization, systematically analyze the problem space through architectural reasoning.

---

## Phase 1: Understand (Repository Inspection & Problem Discovery)

1. **Repository Discovery**:
   - When running in an existing codebase, inspect directory structure, package manifests (`package.json`, `go.mod`, `Cargo.toml`), container definitions (`Dockerfile`, `docker-compose.yml`), and configuration.
   - Ground architectural claims in existing code.
   - Do not invent architecture unsupported by the repo.

2. **Entity & Boundary Identification**:
   - **Actors**: Who or what initiates actions? (End user, Admin, Cron trigger, Webhook provider)
   - **Boundaries**:
     - *Trust Boundaries*: Where does untrusted user input cross into trusted internal networks?
     - *Runtime Boundaries*: Different processes, containers, or lambda invocations.
     - *Ownership Boundaries*: Team/service domain boundaries.
     - *Deployment Boundaries*: Cloud VPC, edge worker, client device.
   - **Storage & State**: Where does state live? (PostgreSQL, Redis, S3, Local SQLite, In-Memory)
   - **Integration Channels**: How do components communicate? (Synchronous REST/gRPC, Asynchronous Kafka/RabbitMQ, WebSockets)

---

## Phase 2: Architectural Discrimination (Explicit Distinctions)

Every relationship in the model must be explicitly categorized:

| Distinction | Left Side | Right Side | Visual Convention |
|-------------|-----------|------------|-------------------|
| **Mode** | Synchronous (blocking call, HTTP, gRPC) | Asynchronous (fire-and-forget, queue, event) | Solid vs Dashed arrow |
| **Direction** | Request / Command | Response / Event Emission | Forward vs Return arc |
| **Access** | Read Path (queries, cache lookups) | Write Path (mutations, transactions) | Dotted vs Solid line |
| **System** | Internal System | External SaaS / Third-Party | Standard rect vs Cloud border |
| **Trigger** | User-Initiated (interactive action) | Background Process (cron, poller, worker) | Actor-led vs Worker-led |

---

## Phase 3: Grounded Truth & Evidence Badging

Never present assumptions as verified facts:

- `VERIFIED`: Directly confirmed in the repository (concrete file path and line numbers exist on disk).
- `INFERRED`: Derived with high confidence from surrounding architecture patterns and conventions.
- `ASSUMED`: A reasonable engineering assumption needed to complete the design, but unconfirmed in repo.
- `UNKNOWN`: A critical architectural ambiguity that must be flagged to the user.

---

## Phase 4: The 14-Point Quality Gate Self-Review

Before presenting any generated visualization or plan to the user, run this self-review:

1. **New Engineer Understandability**: Can an engineer unfamiliar with this system understand the flow within 60 seconds without reading source code?
2. **Clear Boundaries**: Are client, gateway, backend, data, and external tiers instantly recognizable as distinct groupings?
3. **Explicit Dependencies**: Are critical upstream/downstream dependencies visible and traceable?
4. **Intuitive Arrows**: Does every arrow indicate direction, protocol (HTTP, gRPC, AMQP), and sync vs async communication?
5. **No Spaghetti or Crossing Edges**: Are edges routed cleanly with minimal crossings?
6. **Readable Labels**: Are all node labels, boundary headers, and edge annotations legible without extreme zooming?
7. **Stable & Deterministic Layout**: Does the layout flow logically (Left-to-Right for flows, Top-to-Bottom for hierarchies) without random node scatter?
8. **Balanced Information Density**: Is the diagram neither too sparse nor cluttered? (Target density ~4-6 on a 1-10 scale).
9. **Purposeful Animation**: Does animation communicate meaning (e.g. request traveling, packet flowing, sequence step) rather than decorative noise?
10. **Interactive Exploration**: Can the user pan, zoom, drag nodes, click to inspect details, and toggle views?
11. **Explicit Assumptions**: Are assumed components clearly badged as `[ASSUMED]` or `[INFERRED]`?
12. **Evidence-Backed Claims**: Are all claimed technologies and protocols grounded in project evidence or user input?
13. **Repository Grounding**: If running in a repository, do linked file paths match real files on disk?
14. **Direct Implementation Traceability**: Can every modified component be traced directly to an implementation task, file change, test, or migration step?

If any check fails, refine the model and layout before returning the result.

---

## Which Gates Are Executed, and Which Are Yours

```bash
node bin/arch-viz.js validate <spec.json> --repo-root .     # prints all 14
node bin/arch-viz.js validate <spec.json> --strict          # non-zero exit on any WARN (use in CI)
```

**Decided by `src/engine/validator.js`** — a `WARN` here is a fact about the spec, not an opinion:

| # | Check | Mechanism |
| - | ----- | --------- |
| 1 | Glanceable | node count vs the 25-node budget |
| 2 | Clear boundaries | unassigned nodes, tier count |
| 3 | Visible dependencies | isolated non-actor nodes |
| 4 | Intelligible arrows | missing label / `communication`, sequence steps with no backing edge |
| 5 | Clean routing | edges spanning more than two tiers |
| 6 | Readable labels | label 22 / technology 28 / edge 32 character budgets |
| 7 | Deterministic layout | the layout is computed twice and compared |
| 8 | Balanced density | nodes per boundary, edge-to-node ratio |
| 10 | Progressive disclosure | nodes with an empty inspector |
| 11 | Explicit assumptions | unjustified `ASSUMED` / `UNKNOWN` |
| 12 | Evidence-backed claims | `VERIFIED` without file / API / table |
| 13 | Repository grounding | `VERIFIED` paths resolved on disk (`SKIP` when `meta.grounding` is `illustrative`) |
| 14 | Implementation traceability | `ADDED` / `CHANGED` / `REMOVED` nodes without a task |

**Yours to judge** — the validator can only report the inputs:

- **9. Purposeful animation.** The gate checks that animated edges are typed; only you can say whether the motion
  explains the request flow or merely decorates it. Set `animated: false` on edges whose movement teaches nothing.
- **Comprehension (the spirit of 1).** Read the rendered page as if you had never seen the system. If the story is
  not obvious in 60 seconds, the fix is usually fewer nodes, not more labels.
- **Arrow truth (the spirit of 4).** A labelled edge can still be wrong. Verify direction, protocol, and whether a
  response arrow deserves to exist at all.

If a gate warns and you intend to ship anyway, say so explicitly in the response and give the reason. Silently
presenting a warning diagram defeats the point of having a gate.
