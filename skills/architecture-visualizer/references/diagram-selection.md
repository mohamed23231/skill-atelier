# Architecture Diagram Selection Matrix

This reference guides the Senior Software Architect when choosing among the **25 supported diagram types** and architectural lenses.

The core rule is: **Do not force everything into one diagram type.** Complex problems require coordinated multi-lens visualizations.

---

## 1. The 25 Supported Diagram Types

| # | Diagram Type | Best Used For | Primary Focus | Recommended View in Arch-Viz |
|---|--------------|---------------|---------------|-------------------------------|
| 1 | **System Architecture** | High-level topology across entire platform | Systems, boundaries, external SaaS | Architecture View (Tiered LR) |
| 2 | **C4 Context** | Non-technical stakeholders, enterprise boundaries | People, software systems, external systems | Architecture View (Context mode) |
| 3 | **C4 Container** | High-level technical architecture | Web apps, mobile apps, DBs, services | Architecture View (Container mode) |
| 4 | **C4 Component** | Inside a single container/service | Controllers, services, repositories | Architecture View (Component drill-down) |
| 5 | **Sequence Diagram** | Multi-step request/response or inter-service calls | Chronological interaction order | Sequence Tab (Step-by-step player) |
| 6 | **Data Flow Diagram (DFD)** | How data transforms as it moves through nodes | Inputs, processing steps, storage, sinks | Data Flow Tab (with particle animation) |
| 7 | **API Request Lifecycle** | Tracing a single HTTP/gRPC request end-to-end | Gateway, auth middleware, handler, DB | Sequence Tab or Data Flow Tab |
| 8 | **Database ER Diagram** | Relational schemas, foreign keys, table design | Tables, columns, PK/FK, cardinality | Database ER Tab |
| 9 | **State Machine** | Lifecycle transitions of an entity (Order, Refund) | States, transitions, guards, side-effects | Architecture / State View |
| 10 | **Event-Driven Architecture** | Message brokers, Kafka, RabbitMQ, SQS | Producers, topics, consumer groups, sagas | Architecture View (Async dashed edges) |
| 11 | **Auth & Authorization Flow** | OAuth2, OIDC, JWT, SAML, RBAC/ABAC | User, IdP, Gateway, Token validation | Sequence Tab (Multi-actor auth steps) |
| 12 | **Frontend Architecture** | SPAs, SSR, Micro-frontends, state management | Components, hooks, store, API client | Architecture View (Client boundary) |
| 13 | **Backend Architecture** | Microservices, monolith internals, modular monolith | Domains, service interfaces, persistence | Architecture View (Services boundary) |
| 14 | **Mobile Architecture** | iOS/Android app internals, native modules | Native bridge, offline sync, SQLite | Architecture View (Mobile container) |
| 15 | **Infrastructure & Deployment** | Cloud resources, VPCs, Kubernetes, CDN, Load Balancers | Subnets, clusters, pods, regions | Architecture View (Deployment boundary) |
| 16 | **CI/CD Pipeline** | Build, test, security scan, deploy workflows | Stages, gates, artifacts, environments | Architecture View (Pipeline LR) |
| 17 | **Service Dependency Graph** | Microservice coupling, upstream/downstream impact | Blast radius, circular dependencies | Architecture View + Dependency Highlighter |
| 18 | **Migration Plan** | Dual-write, zero-downtime DB cutover, cloud migration | Phased transition, CDC, shadow reads | Before vs After (Phased delta) |
| 19 | **Refactoring Plan** | Code extraction, decoupling legacy spaghetti | Modularization, interfaces, strangler fig | Before vs After (Delta Diff) |
| 20 | **Feature Implementation Plan** | Grounding architecture in code changes | Tasks, PRs, file paths, test suites | Implementation Plan Tab |
| 21 | **Before vs After Architecture** | Any architectural modification or evolution | Current state vs Proposed vs Delta | Before vs After Tab (Current/Proposed/Diff) |
| 22 | **Decision Tree** | Algorithmic branch logic, rule evaluation | Rules, criteria, fallback strategies | Architecture / Logic View |
| 23 | **Failure & Recovery Flow** | Circuit breakers, DLQs, retries, failovers | Degradation paths, fallback caches | Architecture View (Fault paths + drawer) |
| 24 | **User Journey** | End-to-end user actions across touchpoints | Steps, screen transitions, backend hits | Sequence Tab or Data Flow Tab |
| 25 | **Complex Business Workflow** | Multi-party business logic (e.g. escrow, checkout) | Approval gates, state changes, external APIs | Architecture + Sequence coordinated |

---

## 2. Coordinated Multi-View Pairing Recipes

When addressing complex engineering problems, never settle for a single view. Pair complementary views:

### Recipe A: New Feature Addition
1. **Architecture View (Proposed)**: Shows where the new service/endpoint sits inside existing boundaries.
2. **Before vs After (Delta Diff)**: Highlights `[+ ADDED]` nodes and modified `[~ CHANGED]` interfaces in green/amber.
3. **Sequence Flow**: Demonstrates the new feature's end-to-end request lifecycle with animated step playback.
4. **Implementation Plan**: Connects every component to concrete file paths, schema migrations, and test tasks.

### Recipe B: Zero-Downtime Database Migration
1. **Before vs After**:
   - Current: Monolith writes directly to legacy table.
   - Transition: Dual-write with CDC replication and shadow reads.
   - Proposed: All traffic redirected to partitioned/sharded target; legacy table deprecated.
2. **Database ER View**: Shows schema changes, new indexes, partitions, or shard keys.
3. **Failure & Recovery**: Documents failback procedure if replication lag or shadow read discrepancies spike.
4. **Phased Implementation Plan**: Gate 1 (Schema apply) -> Gate 2 (Dual write) -> Gate 3 (Backfill) -> Gate 4 (Shadow reads) -> Gate 5 (Cutover).

### Recipe C: Asynchronous Event-Driven Workflow
1. **Architecture View**: Highlights producers, topic/exchange, consumer workers, and dead-letter queues (DLQ).
2. **Data Flow (Animated)**: Visualizes the event packet traveling from producer through the broker to consumers.
3. **Sequence Flow (Compensating Saga)**: Demonstrates happy path vs failure and compensating transaction steps.
4. **Failure Modes in Inspector Drawer**: Outbox poller crash, poisonous message handling, idempotent replay.
