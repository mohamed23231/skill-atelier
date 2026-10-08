# Architecture Diagram Selection Matrix

This reference guides the Senior Software Architect when choosing among the **25 diagram modeling patterns** and architectural lenses.

The core rule is: **Do not force everything into one diagram type.** Complex problems require coordinated multi-lens visualizations.

---

## 1. The 25 Diagram Modeling Patterns

| # | Diagram Type | Best Used For | Primary Focus | Recommended View in Arch-Viz |
|---|--------------|---------------|---------------|-------------------------------|
| 1 | **System Architecture** | High-level topology across entire platform | Systems, boundaries, external SaaS | Structure lens (swimlanes) |
| 2 | **C4 Context** | Non-technical stakeholders, enterprise boundaries | People, software systems, external systems | Structure lens (separate context spec) |
| 3 | **C4 Container** | High-level technical architecture | Web apps, mobile apps, DBs, services | Structure lens (separate container spec) |
| 4 | **C4 Component** | Inside a single container/service | Controllers, services, repositories | Structure lens (separate component spec) |
| 5 | **Sequence Diagram** | Multi-step request/response or inter-service calls | Chronological interaction order | Walkthrough chapter and track |
| 6 | **Data Flow Diagram (DFD)** | How data transforms as it moves through nodes | Inputs, processing steps, storage, sinks | Structure → Filters → Data flow |
| 7 | **API Request Lifecycle** | Tracing a single HTTP/gRPC request end-to-end | Gateway, auth middleware, handler, DB | Walkthrough or Structure → Filters → Data flow |
| 8 | **Database ER Diagram** | Relational schemas, foreign keys, table design | Tables, columns, PK/FK, cardinality | Data chapter (table and relationship cards) |
| 9 | **State Machine** | Lifecycle transitions of an entity (Order, Refund) | States, transitions, guards, side-effects | Structure lens (modeled state graph) |
| 10 | **Event-Driven Architecture** | Message brokers, Kafka, RabbitMQ, SQS | Producers, topics, consumer groups, sagas | Structure lens (Async dashed edges) |
| 11 | **Auth & Authorization Flow** | OAuth2, OIDC, JWT, SAML, RBAC/ABAC | User, IdP, Gateway, Token validation | Walkthrough (multi-actor auth steps) |
| 12 | **Frontend Architecture** | SPAs, SSR, Micro-frontends, state management | Components, hooks, store, API client | Structure lens (Client boundary) |
| 13 | **Backend Architecture** | Microservices, monolith internals, modular monolith | Domains, service interfaces, persistence | Structure lens (Services boundary) |
| 14 | **Mobile Architecture** | iOS/Android app internals, native modules | Native bridge, offline sync, SQLite | Structure lens (Mobile container) |
| 15 | **Infrastructure & Deployment** | Cloud resources, VPCs, Kubernetes, CDN, Load Balancers | Subnets, clusters, pods, regions | Structure lens (Deployment boundary) |
| 16 | **CI/CD Pipeline** | Build, test, security scan, deploy workflows | Stages, gates, artifacts, environments | Structure lens (Pipeline LR) |
| 17 | **Service Dependency Graph** | Microservice coupling, upstream/downstream impact | Blast radius, circular dependencies | Structure + sheet/palette relationship highlighting |
| 18 | **Migration Plan** | Dual-write, zero-downtime DB cutover, cloud migration | Phased transition, CDC, shadow reads | Change lens + Plan chapter |
| 19 | **Refactoring Plan** | Code extraction, decoupling legacy spaghetti | Modularization, interfaces, strangler fig | Change lens (Diff) |
| 20 | **Feature Implementation Plan** | Grounding architecture in code changes | Tasks, PRs, file paths, test suites | Plan chapter |
| 21 | **Before vs After Architecture** | Any architectural modification or evolution | Current state vs Proposed vs Delta | Change lens (Current/Proposed/Diff) |
| 22 | **Decision Tree** | Algorithmic branch logic, rule evaluation | Rules, criteria, fallback strategies | Structure lens + Walkthrough decisions |
| 23 | **Failure & Recovery Flow** | Circuit breakers, DLQs, retries, failovers | Degradation paths, fallback caches | Risk lens + component failure modes |
| 24 | **User Journey** | End-to-end user actions across touchpoints | Steps, screen transitions, backend hits | Walkthrough or Structure → Filters → Data flow |
| 25 | **Complex Business Workflow** | Multi-party business logic (e.g. escrow, checkout) | Approval gates, state changes, external APIs | Structure lens + Walkthrough |

---

## 2. Coordinated Multi-View Pairing Recipes

When addressing complex engineering problems, never settle for a single view. Pair complementary views:

### Recipe A: New Feature Addition
1. **Change lens (Proposed)**: Shows where the new service/endpoint sits inside existing boundaries.
2. **Change lens (Diff)**: Highlights Added and Changed cards and connections with text badges and line treatments.
3. **Walkthrough**: Demonstrates the new feature's end-to-end request lifecycle with animated step playback.
4. **Plan chapter**: Connects every component to concrete file paths, schema migrations, and test tasks.

### Recipe B: Zero-Downtime Database Migration
1. **Change lens / Changes chapter**:
   - Current: Monolith writes directly to legacy table.
   - Transition: Dual-write with CDC replication and shadow reads.
   - Proposed: All traffic redirected to partitioned/sharded target; legacy table deprecated.
2. **Data chapter**: Lists table and relationship cards for schema changes, indexes, partitions, or shard keys.
3. **Failure & Recovery**: Documents failback procedure if replication lag or shadow read discrepancies spike.
4. **Plan chapter**: Gate 1 (Schema apply) -> Gate 2 (Dual write) -> Gate 3 (Backfill) -> Gate 4 (Shadow reads) -> Gate 5 (Cutover).

### Recipe C: Asynchronous Event-Driven Workflow
1. **Structure lens**: Highlights producers, topic/exchange, consumer workers, and dead-letter queues (DLQ).
2. **Structure → Filters → Data flow**: Visualizes the event packet traveling from producer through the broker to consumers.
3. **Walkthrough (Compensating Saga)**: Demonstrates happy path vs failure and compensating transaction steps.
4. **Failure Modes in Component Sheet / Review**: Outbox poller crash, poisonous message handling, idempotent replay.
