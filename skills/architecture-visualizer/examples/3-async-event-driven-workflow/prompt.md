# Scenario 3 Prompt: Distributed Order Fulfillment Saga with Outbox & DLQ

## User Request
> "Design an enterprise-grade asynchronous event-driven order fulfillment workflow using the Saga pattern. When a customer places an order, the system must coordinate payment capture, inventory reservation, warehouse dispatch, and customer notifications across distributed microservices. It must guarantee reliable at-least-once message delivery via the Transactional Outbox pattern, handle partial failures through compensating transactions (e.g. if warehouse reservation fails after payment, automatically trigger payment refund and release locks), and isolate poisoned messages in a Dead-Letter Queue (DLQ) with alert hooks for engineering triage."

## Architectural Goals
1. Accurately model distributed asynchronous communication between microservices via an Event Bus (Kafka).
2. Explicitly distinguish synchronous commands from asynchronous events (dashed lines, purple/amber pulses).
3. Demonstrate the Transactional Outbox pattern to prevent dual-write anomalies.
4. Step through both the happy-path fulfillment and the compensating rollback sequence (warehouse failure -> payment refund).
5. Model state machine transitions and DLQ failure triage in the Inspector Drawer.
