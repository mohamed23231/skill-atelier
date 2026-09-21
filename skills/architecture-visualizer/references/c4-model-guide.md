# C4 Model Practical Guide in Arch-Viz

The C4 model provides a hierarchical way to describe software architecture at different levels of abstraction. Arch-Viz natively supports all four levels through boundaries, node types, and progressive disclosure.

---

## 1. The 4 Levels of Abstraction

### Level 1: System Context (Audience: Everyone)
- **What it shows:** The system in its environment, external users (actors), and external systems.
- **Boundaries:** High-level Enterprise / System boundaries.
- **Node Types:** `actor`, `external`, `system`.
- **Level of Detail:** Zero internal details, zero database tables, zero protocols.

### Level 2: Container Diagram (Audience: Tech Leads, Architects, Engineers)
- **What it shows:** Separately deployable units that make up the system (Web SPA, Mobile App, API Gateway, Microservices, Databases, Message Queues).
- **Boundaries:** `frontend_layer`, `api_layer`, `backend_services`, `data_tier`.
- **Node Types:** `frontend`, `mobile`, `api_gateway`, `service`, `worker`, `database`, `queue`.
- **Level of Detail:** Technology choices (e.g. "React Native", "PostgreSQL 16", "Apache Kafka"), inter-container protocols (HTTPS, gRPC, AMQP).

### Level 3: Component Diagram (Audience: Software Engineers)
- **What it shows:** Internal structural decomposition of a single container into modules/components.
- **Boundaries:** A single container boundary (e.g. `orders_service`).
- **Node Types:** Controllers, Services, Repositories, Middlewares, Event Listeners.
- **Level of Detail:** Class/interface responsibilities, repository file paths, internal event hooks.

### Level 4: Code (Audience: Implementing Engineers)
- **What it shows:** Direct connection to source code, functions, database columns, and PR tasks.
- **In Arch-Viz:** Accessible directly via the **Inspector Drawer** when clicking on any component:
  - Linked source file paths with line numbers.
  - API endpoint signatures (`POST /api/v1/orders`).
  - Database schema columns with types, PK, and FK constraints.
  - Unit/Integration test file paths.
  - Checkable implementation tasks.
