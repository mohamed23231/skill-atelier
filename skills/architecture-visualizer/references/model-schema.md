# Model Schema Reference (Architecture Visualizer 2.0)

Architecture Visualizer 2.0 uses a grounded, schema-validated JSON specification format (`schemaVersion: 2`) designed to model boundaries, components, relationships, verification evidence, structural policies, and execution scenarios.

---

## 1. Schema Versioning & v1 Compatibility

The canonical schema version is integer `2`. The compiler and validator maintain normalization compatibility with version 1 specifications:

- **Automatic Normalization**: Any specification lacking `schemaVersion` or specifying `schemaVersion: 1` is normalized to version 2 on ingest.
- **Evidence Lifting**: Legacy node arrays (`details.files`, `details.apis`, `details.tables`) are automatically lifted into top-level `evidence` records with `verification: "compatibility"` and `origin` set to `legacy-files`, `legacy-apis`, or `legacy-tables`.
- **Scenario Normalization**: Legacy `views.sequence.steps` are automatically normalized into a scenario named `scenario_sequence` with `origin: "legacy-sequence"`.
- **Preserved Views**: Legacy ER tables and implementation plans remain supported in `views.database_er` and `views.implementation_plan`.

---

## 2. Core Specification Fields

A version 2 specification contains the following top-level properties:

```jsonc
{
  "schemaVersion": 2,
  "meta": { /* Project metadata, assumptions, unresolved questions, ADRs */ },
  "boundaries": [ /* Architectural tiers and clustering containers */ ],
  "nodes": [ /* Component nodes, technology, status, and details */ ],
  "edges": [ /* Directed communication paths and protocols */ ],
  "evidence": [ /* Verifiable repository locators and assertions */ ],
  "policies": [ /* Architectural rules and dependency constraints */ ],
  "scenarios": [ /* Serial, parallel, and branching execution journeys */ ],
  "views": { /* Optional dedicated views: database_er, implementation_plan */ },
  "layout": { "direction": "LR" } /* "LR" (left-to-right) or "TB" (top-to-bottom) */
}
```

### `meta` Object

| Field | Type | Description |
| --- | --- | --- |
| `title` | `string` | **Required.** Title of the architecture diagram or proposal. |
| `description` | `string` | Summary of the system design, context, and goals. |
| `status` | `string` | Lifecycle state: `PROPOSED`, `ACCEPTED`, `IN_REVIEW`, `CURRENT`, etc. |
| `grounding` | `string` | Set to `"illustrative"` for teaching examples to bypass local filesystem path existence checks. Omit for real repositories. |
| `assumptions` | `string[]` | Architectural assumptions explicitly made during design. |
| `unresolvedQuestions` | `string[]` | Open technical questions or ambiguities flagged for reviewers. |
| `decisions` | `ADR[]` | Architectural Decision Records: `[{ id, title, context, decision, consequences }]`. |

### `boundaries` Array

Boundaries represent hierarchical architectural layers, domains, or trust zones.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | **Required.** Unique boundary identifier (e.g. `service_tier`). |
| `label` | `string` | Human-readable header title displayed on the canvas container. |
| `type` | `string` | Container kind: `tier`, `container`, `boundary_group`, `subsystem`, `external`. |
| `order` | `number` | Ordering index determining rank sequence in the layout engine. |
| `parent` | `string` | Optional parent boundary ID for hierarchical nested containers. |

### `nodes` Array

Nodes represent discrete actors, services, databases, queues, or client applications.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | **Required.** Unique identifier for the component. |
| `label` | `string` | **Required.** Concise component name (**≤ 22 characters**). |
| `type` | `string` | Component type: `actor`, `frontend`, `mobile`, `api_gateway`, `service`, `worker`, `database`, `cache`, `queue`, `topic`, `storage`, `external`, `cloud_function`, `boundary_group`. |
| `boundary` | `string` | ID of the enclosing boundary container. |
| `technology` | `string` | Technology stack or runtime (**≤ 28 characters**), e.g. `Node.js / Express`. |
| `status` | `string` | Verification status: `VERIFIED`, `INFERRED`, `ASSUMED`, `UNKNOWN`. |
| `delta` | `string` | Proposed diff state: `UNCHANGED`, `ADDED`, `CHANGED`, `REMOVED`, `MOVED`. |
| `order` | `number` | Optional explicit ordering integer within its boundary rank. |
| `description` | `string` | Expanded summary of component purpose and architecture. |
| `evidenceIds` | `string[]` | References to entries in the top-level `evidence` array. |
| `details` | `object` | Deep-dive inspector attributes: |
| `details.responsibilities` | `string[]` | Bullet points of component responsibilities. |
| `details.files` | `string[]` | File paths or file objects associated with the component. |
| `details.apis` | `object[]` | Exposed endpoints: `[{ method: "POST", path: "/orders" }]`. |
| `details.tables` | `string[]` | Backing tables or collections. |
| `details.tasks` | `string[]` | Concrete implementation tasks for this component. |
| `details.failureModes` | `string[]` \| `object[]` | Failure risks and mitigations (`string` or `{ failure, impact, mitigation }`). |

### `edges` Array

Edges represent communication pathways, RPCs, event streams, or data transport.

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique edge identifier (e.g. `edge_order_to_db`). |
| `source` | `string` | **Required.** Node ID where the edge originates. |
| `target` | `string` | **Required.** Node ID where the edge terminates. |
| `label` | `string` | Protocol, verb, or payload label (**≤ 32 characters**). |
| `communication` | `string` | **Required.** Synchronous vs asynchronous mode: `"sync"` \| `"async"`. |
| `pathType` | `string` | Traffic classification: `request`, `response`, `read`, `write`, `event`, `replication`, `control`. |
| `animated` | `boolean` | Whether particle flow is rendered along the edge (default: true). |
| `packetLabel` | `string` | Optional payload description displayed along flow particles. |
| `delta` | `string` | Change classification: `UNCHANGED`, `ADDED`, `CHANGED`, `REMOVED`. |

---

## 3. Compact Annotated Example (v2)

```json
{
  "schemaVersion": 2,
  "meta": {
    "title": "Order Processing System",
    "description": "Checkout ingestion and event-driven fulfillment.",
    "status": "PROPOSED",
    "assumptions": [
      "Payment gateway webhook guarantees at-least-once delivery."
    ],
    "unresolvedQuestions": [
      "Will order reconciliation run hourly or daily?"
    ],
    "decisions": [
      {
        "id": "ADR-001",
        "title": "Asynchronous Saga for Order Fulfillment",
        "context": "Direct synchronous RPCs across inventory and billing cause cascading timeouts.",
        "decision": "Use Kafka outbox events and saga orchestrator.",
        "consequences": "Requires idempotency keys on payment workers and compensation rollback logic."
      }
    ]
  },
  "boundaries": [
    { "id": "client_tier", "label": "Clients", "type": "tier", "order": 1 },
    { "id": "service_tier", "label": "Core Services", "type": "tier", "order": 2 },
    { "id": "data_tier", "label": "Data & Events", "type": "tier", "order": 3 }
  ],
  "nodes": [
    {
      "id": "web_app",
      "label": "Web Client",
      "type": "frontend",
      "boundary": "client_tier",
      "technology": "React / TypeScript",
      "status": "VERIFIED",
      "delta": "CHANGED",
      "evidenceIds": ["ev_client_routes"],
      "details": {
        "responsibilities": ["Order submission form", "Real-time order tracking"],
        "files": ["src/client/OrderForm.tsx"]
      }
    },
    {
      "id": "order_svc",
      "label": "Order Service",
      "type": "service",
      "boundary": "service_tier",
      "technology": "Node.js / Express",
      "status": "VERIFIED",
      "delta": "CHANGED",
      "evidenceIds": ["ev_order_svc_file", "ev_order_api"],
      "details": {
        "responsibilities": ["Order validation", "State machine progression"],
        "files": ["src/services/order.ts"],
        "apis": [{ "method": "POST", "path": "/api/orders" }],
        "failureModes": [
          {
            "failure": "Database connection exhaustion during traffic spike",
            "impact": "HTTP 500 returned to client",
            "mitigation": "Connection pooling with pgBouncer and circuit breaker"
          }
        ],
        "tasks": ["Implement idempotent request deduplication middleware"]
      }
    },
    {
      "id": "order_db",
      "label": "Orders Database",
      "type": "database",
      "boundary": "data_tier",
      "technology": "PostgreSQL 16",
      "status": "VERIFIED",
      "delta": "UNCHANGED",
      "evidenceIds": ["ev_orders_schema"],
      "details": {
        "tables": ["orders", "order_items"]
      }
    }
  ],
  "edges": [
    {
      "id": "edge_web_to_order",
      "source": "web_app",
      "target": "order_svc",
      "label": "POST /api/orders",
      "communication": "sync",
      "pathType": "request",
      "animated": true,
      "delta": "CHANGED"
    },
    {
      "id": "edge_order_to_db",
      "source": "order_svc",
      "target": "order_db",
      "label": "SQL insert",
      "communication": "sync",
      "pathType": "write",
      "animated": true,
      "delta": "UNCHANGED"
    }
  ],
  "evidence": [
    {
      "id": "ev_client_routes",
      "type": "file",
      "locator": { "path": "src/client/OrderForm.tsx" },
      "origin": "author"
    },
    {
      "id": "ev_order_svc_file",
      "type": "symbol",
      "locator": { "path": "src/services/order.ts", "symbol": "createOrder", "startLine": 12, "endLine": 48 },
      "origin": "author"
    },
    {
      "id": "ev_order_api",
      "type": "api",
      "locator": { "method": "POST", "path": "/api/orders" },
      "origin": "author"
    },
    {
      "id": "ev_orders_schema",
      "type": "table",
      "locator": { "table": "orders" },
      "origin": "author"
    }
  ],
  "policies": [
    {
      "id": "pol_client_never_direct_db",
      "kind": "forbidden_dependency",
      "fromType": "frontend",
      "toType": "database",
      "severity": "error"
    },
    {
      "id": "pol_service_layer_direction",
      "kind": "layer_direction",
      "layers": ["client_tier", "service_tier", "data_tier"],
      "severity": "warn"
    }
  ],
  "scenarios": [
    {
      "id": "checkout_flow",
      "name": "Successful Checkout Journey",
      "stages": [
        {
          "id": "stage_1",
          "kind": "interaction",
          "interactions": [
            {
              "id": "int_post_order",
              "from": "web_app",
              "to": "order_svc",
              "edgeId": "edge_web_to_order",
              "label": "Submit order payload",
              "sync": true,
              "durationMs": 600,
              "payload": "{ items: [...], paymentMethod: 'card' }"
            }
          ]
        },
        {
          "id": "stage_2",
          "kind": "interaction",
          "interactions": [
            {
              "id": "int_db_write",
              "from": "order_svc",
              "to": "order_db",
              "edgeId": "edge_order_to_db",
              "label": "Persist pending order",
              "sync": true,
              "durationMs": 300
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 4. Hard Structural Limits & Quality Constraints

The validator enforces specific structural budgets to guarantee visual clarity and prevent cluttered diagrams:

| Constraint | Limit | Quality Gate Check |
| --- | --- | --- |
| Node Label Length | **≤ 22 characters** | Gate 6 (`Readable labels`) |
| Node Technology Length | **≤ 28 characters** | Gate 6 (`Readable labels`) |
| Edge Label Length | **≤ 32 characters** | Gate 6 (`Readable labels`) |
| Glanceability Budget | **≤ 25 nodes** per view | Gate 1 (`Glanceable`) |
| Maximum Boundaries | **≤ 8 boundaries** | Gate 2 (`Clear boundaries`) |
| Nodes per Boundary | **≤ 6 nodes** per container | Gate 8 (`Balanced density`) |
| Edge-to-Node Ratio | **≤ 3.0** | Gate 8 (`Balanced density`) |
| Edge / Card Crossing Ratio | **≤ 15%** of drawn edges | Gate 5 (`Clean routing`) |
