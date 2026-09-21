# Scenario Authoring Reference

In Architecture Visualizer 2.0, scenarios model dynamic execution paths across components. The interactive scenario player allows reviewers to step through, scrub, or auto-play system interactions, compensating sagas, and failure recoveries.

---

## 1. Scenario Structure

Scenarios are defined in the top-level `scenarios` array. Each scenario contains metadata and an ordered sequence of stages.

```jsonc
{
  "scenarios": [
    {
      "id": "order_fulfillment_saga",
      "name": "Order Fulfillment Saga with Compensation",
      "description": "End-to-end checkout flow highlighting payment failure and inventory release.",
      "origin": "author", // "author" | "legacy-sequence"
      "stages": [
        /* Stage 1, Stage 2, ... */
      ]
    }
  ]
}
```

---

## 2. Stage Kinds

Stages structure the chronological order and concurrency of interactions. There are three supported stage kinds:

### A. `interaction` (Sequential)
Represents a direct, single interaction or a linear hop from one component to another.

```json
{
  "id": "stage_order_submit",
  "kind": "interaction",
  "interactions": [
    {
      "id": "int_submit",
      "from": "web_client",
      "to": "api_gateway",
      "edgeId": "edge_client_to_gateway",
      "label": "POST /orders",
      "sync": true,
      "durationMs": 500,
      "payload": "{ customerId: 'c_123', items: [...] }"
    }
  ]
}
```

### B. `parallel` (Concurrent Execution)
Represents multiple operations that execute simultaneously (e.g. broadcasting events or fanning out checks).

```json
{
  "id": "stage_fanout_checks",
  "kind": "parallel",
  "interactions": [
    {
      "id": "int_check_fraud",
      "from": "order_svc",
      "to": "fraud_detector",
      "edgeId": "edge_order_fraud",
      "label": "Evaluate fraud score",
      "sync": true,
      "durationMs": 400
    },
    {
      "id": "int_reserve_stock",
      "from": "order_svc",
      "to": "inventory_svc",
      "edgeId": "edge_order_inventory",
      "label": "Reserve inventory",
      "sync": true,
      "durationMs": 450
    }
  ]
}
```

### C. `branch` (Conditional Pathways)
Represents decision points where execution diverges based on runtime conditions.

```json
{
  "id": "stage_payment_branch",
  "kind": "branch",
  "branches": [
    {
      "condition": "payment_approved == true",
      "stages": [
        {
          "id": "stage_confirm",
          "kind": "interaction",
          "interactions": [
            {
              "id": "int_notify_confirmed",
              "from": "order_svc",
              "to": "notification_svc",
              "edgeId": "edge_order_notif",
              "label": "Send order receipt",
              "sync": false,
              "status": "completed"
            }
          ]
        }
      ]
    },
    {
      "condition": "payment_approved == false",
      "stages": [
        {
          "id": "stage_rollback",
          "kind": "interaction",
          "interactions": [
            {
              "id": "int_release_inventory",
              "from": "order_svc",
              "to": "inventory_svc",
              "edgeId": "edge_order_inv_comp",
              "label": "Compensating release",
              "sync": true,
              "status": "recovery",
              "failure": "Card declined (insufficient funds)",
              "recovery": "Execute compensating transaction to unlock stock"
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 3. Interaction Fields & Status Metadata

Each interaction within a stage specifies execution details:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Unique identifier for the interaction. |
| `from` | `string` | **Required.** Origin node ID (must exist in `spec.nodes`). |
| `to` | `string` | **Required.** Destination node ID (must exist in `spec.nodes`). |
| `label` | `string` | Interaction description, method, or event name. |
| `edgeId` | `string` | Optional matching edge ID in `spec.edges`. If omitted, looked up by `(from, to)`. |
| `sync` | `boolean` | `true` for synchronous call; `false` for async message/event. |
| `durationMs` | `number` | Playback duration in milliseconds (default: 800ms). |
| `condition` | `string` | Guard condition required for this interaction. |
| `payload` | `string` | Summary of parameters, message headers, or payload. |
| `optional` | `boolean` | `true` if this interaction may be bypassed under certain configurations. |
| `status` | `string` | Interaction outcome state: `completed`, `failed`, `blocked`, `optional`, `recovery`. |
| `failure` | `string` | Description of failure condition, exception, or timeout. |
| `recovery` | `string` | Mitigation, retry policy, or compensating action executed upon failure. |

---

## 4. Complete End-to-End Example

```json
{
  "id": "checkout_with_inventory_fallback",
  "name": "Checkout Flow with Compensation",
  "description": "Demonstrates reservation, payment failure, and automated rollback.",
  "stages": [
    {
      "id": "stg_1_checkout",
      "kind": "interaction",
      "interactions": [
        {
          "id": "step_submit",
          "from": "web_app",
          "to": "api_gateway",
          "edgeId": "edge_client_gw",
          "label": "POST /checkout",
          "sync": true,
          "durationMs": 500,
          "payload": "{ cartId: 'cart_991' }",
          "status": "completed"
        }
      ]
    },
    {
      "id": "stg_2_reserve_and_auth",
      "kind": "parallel",
      "interactions": [
        {
          "id": "step_reserve",
          "from": "api_gateway",
          "to": "inventory_svc",
          "edgeId": "edge_gw_inventory",
          "label": "Reserve SKU-104",
          "sync": true,
          "durationMs": 400,
          "status": "completed"
        },
        {
          "id": "step_charge",
          "from": "api_gateway",
          "to": "payment_gateway",
          "edgeId": "edge_gw_payment",
          "label": "Charge card",
          "sync": true,
          "durationMs": 600,
          "status": "failed",
          "failure": "Payment processor returned HTTP 402: Insufficient Funds",
          "recovery": "Initiate automated inventory rollback compensation"
        }
      ]
    },
    {
      "id": "stg_3_compensation_branch",
      "kind": "branch",
      "branches": [
        {
          "condition": "payment_failed == true",
          "stages": [
            {
              "id": "stg_compensation",
              "kind": "interaction",
              "interactions": [
                {
                  "id": "step_unlock_stock",
                  "from": "api_gateway",
                  "to": "inventory_svc",
                  "edgeId": "edge_gw_inventory",
                  "label": "Compensate: Release SKU-104",
                  "sync": true,
                  "durationMs": 350,
                  "status": "recovery"
                }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

---

## 5. Authoring Invariants & Best Practices

1. **Back Interactions with Real Edges**: Ensure an edge exists between `from` and `to` in `spec.edges`. If no edge exists, the player renders a temporary dashed *ghost link* and the validator emits a Quality Gate 4 warning.
2. **Set Meaningful Durations**: Use `durationMs` purposefully (e.g. 200–300ms for in-memory cache lookups, 800–1200ms for external SaaS calls) to communicate relative latency.
3. **Capture Failure Modes Explicitly**: Every branch or failure step should declare `failure` and `recovery` properties so reviewers understand fault tolerance without inspecting code.
