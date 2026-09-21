/**
 * Starter architecture specification emitted by `arch-viz init`.
 */

const STARTER_SPEC = {
  schemaVersion: 2,
  meta: {
    title: 'Sample System Architecture',
    description: 'Baseline interactive architecture model',
    status: 'PROPOSED',
    grounding: 'illustrative',
    author: 'Senior Architect',
    date: new Date().toISOString().split('T')[0],
    assumptions: ['Network latency between services is under 20ms', 'PostgreSQL 16 handles relational transactions'],
    decisions: [
      {
        id: 'ADR-001',
        title: 'Use transactional outbox for reliable event publishing',
        status: 'ACCEPTED',
        context: 'Need to prevent dual-write inconsistencies between database and message queue.',
        decision: 'Persist domain events into an outbox table within the same ACID transaction.',
        consequences: 'Eliminates phantom messages; requires an outbox poller or CDC worker.',
      },
    ],
  },
  boundaries: [
    { id: 'frontend_layer', label: 'Client Applications', type: 'system', order: 1 },
    { id: 'api_layer', label: 'API & Edge', type: 'container', order: 2 },
    { id: 'service_layer', label: 'Core Services', type: 'container', order: 3 },
    { id: 'data_layer', label: 'Storage & Persistence', type: 'container', order: 4 },
  ],
  nodes: [
    {
      id: 'web_client',
      label: 'Web Application',
      type: 'frontend',
      boundary: 'frontend_layer',
      technology: 'Next.js / React',
      status: 'VERIFIED',
      delta: 'UNCHANGED',
      description: 'Customer facing web portal',
      details: {
        responsibilities: ['Render user interface', 'Handle client state'],
        files: ['src/client/App.tsx'],
      },
      evidenceIds: ['ev_web_client_file'],
    },
    {
      id: 'api_gateway',
      label: 'API Gateway',
      type: 'api_gateway',
      boundary: 'api_layer',
      technology: 'Express / NGINX',
      status: 'VERIFIED',
      delta: 'UNCHANGED',
      description: 'Routes requests, validates JWT authentication, rate limits',
      details: {
        responsibilities: ['Authentication', 'Rate limiting', 'Request routing'],
        apis: [{ method: 'POST', path: '/api/v1/orders', desc: 'Submit order' }],
      },
      evidenceIds: ['ev_api_gateway_api'],
    },
    {
      id: 'orders_service',
      label: 'Orders Service',
      type: 'service',
      boundary: 'service_layer',
      technology: 'Node.js / TypeScript',
      status: 'VERIFIED',
      delta: 'CHANGED',
      description: 'Manages order lifecycle, calculations, and state transitions',
      details: {
        responsibilities: ['Order validation', 'State machine transition'],
        tables: ['orders', 'order_items'],
        tasks: [{ id: 'T1', title: 'Add discount calculation step', status: 'pending' }],
      },
      evidenceIds: ['ev_orders_service_table'],
    },
    {
      id: 'primary_db',
      label: 'PostgreSQL Database',
      type: 'database',
      boundary: 'data_layer',
      technology: 'PostgreSQL 16',
      status: 'VERIFIED',
      delta: 'UNCHANGED',
      description: 'ACID persistence store for orders, items, and customers',
      details: {
        tables: ['orders', 'order_items', 'customers'],
      },
      evidenceIds: ['ev_primary_db_table'],
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'web_client',
      target: 'api_gateway',
      label: 'HTTPS / REST',
      communication: 'sync',
      pathType: 'request',
      animated: true,
      packetLabel: 'POST /orders',
    },
    {
      id: 'e2',
      source: 'api_gateway',
      target: 'orders_service',
      label: 'gRPC',
      communication: 'sync',
      pathType: 'request',
      animated: true,
    },
    {
      id: 'e3',
      source: 'orders_service',
      target: 'primary_db',
      label: 'SQL',
      communication: 'sync',
      pathType: 'write',
      animated: true,
    },
  ],
  views: {
    sequence: {
      title: 'Order Placement Flow',
      steps: [
        { step: 1, from: 'web_client', to: 'api_gateway', label: 'Submit Order Request', sync: true },
        { step: 2, from: 'api_gateway', to: 'orders_service', label: 'Forward CreateOrder', sync: true },
        { step: 3, from: 'orders_service', to: 'primary_db', label: 'Insert Order Row', sync: true },
      ],
    },
    database_er: {
      tables: [
        {
          name: 'orders',
          columns: [
            { name: 'id', type: 'uuid', pk: true },
            { name: 'customer_id', type: 'uuid', fk: 'customers.id' },
            { name: 'total_amount', type: 'numeric' },
            { name: 'status', type: 'varchar' },
          ],
        },
      ],
    },
    implementation_plan: {
      phases: [
        {
          name: 'Core Service Update',
          tasks: [
            {
              id: 'P1-T1',
              title: 'Implement discount calculation module',
              componentId: 'orders_service',
              complexity: 'medium',
              files: ['src/services/OrderService.ts'],
            },
          ],
        },
      ],
    },
  },
  evidence: [
    {
      id: 'ev_web_client_file',
      type: 'file',
      locator: { path: 'src/client/App.tsx' },
      verification: 'compatibility',
    },
    {
      id: 'ev_api_gateway_api',
      type: 'api',
      locator: { method: 'POST', path: '/api/v1/orders' },
      verification: 'compatibility',
    },
    {
      id: 'ev_orders_service_table',
      type: 'table',
      locator: { table: 'orders' },
      verification: 'compatibility',
    },
    {
      id: 'ev_primary_db_table',
      type: 'table',
      locator: { table: 'orders' },
      verification: 'compatibility',
    },
  ],
  policies: [
    {
      id: 'policy_required_orders_db',
      kind: 'required_dependency',
      from: 'orders_service',
      to: 'primary_db',
    },
    {
      id: 'policy_forbid_client_db',
      kind: 'forbidden_dependency',
      from: 'web_client',
      to: 'primary_db',
    },
    {
      id: 'policy_layer_direction',
      kind: 'layer_direction',
      layers: ['frontend_layer', 'api_layer', 'service_layer', 'data_layer'],
    },
    {
      id: 'policy_no_cycles',
      kind: 'cycle',
    },
    {
      id: 'policy_verified_evidence',
      kind: 'required_evidence',
      status: 'VERIFIED',
    },
    {
      id: 'policy_fan_out',
      kind: 'fan_out',
      max: 8,
    },
    {
      id: 'policy_fan_in',
      kind: 'fan_in',
      max: 8,
    },
  ],
  scenarios: [
    {
      id: 'order_placement',
      name: 'Order Placement Flow',
      stages: [
        {
          id: 'stage_1',
          kind: 'interaction',
          interactions: [{ id: 'i1', from: 'web_client', to: 'api_gateway', label: 'Submit Order Request', edgeId: 'e1' }],
        },
        {
          id: 'stage_2',
          kind: 'interaction',
          interactions: [{ id: 'i2', from: 'api_gateway', to: 'orders_service', label: 'Forward CreateOrder', edgeId: 'e2' }],
        },
        {
          id: 'stage_3',
          kind: 'interaction',
          interactions: [{ id: 'i3', from: 'orders_service', to: 'primary_db', label: 'Insert Order Row', edgeId: 'e3' }],
        },
      ],
    },
  ],
};

const LEGACY_COMPAT_SPEC = {
  meta: {
    title: 'Legacy Compatibility Example',
    description: 'Version 1 spec without schemaVersion, evidence, policies, or scenarios',
    grounding: 'illustrative',
    author: 'Senior Architect',
    date: '2026-09-20',
    assumptions: ['Legacy specs remain valid after normalization'],
  },
  boundaries: [
    { id: 'service_layer', label: 'Core Services', type: 'container', order: 1 },
    { id: 'data_layer', label: 'Storage', type: 'container', order: 2 },
  ],
  nodes: [
    {
      id: 'orders_service',
      label: 'Orders Service',
      type: 'service',
      boundary: 'service_layer',
      technology: 'Node.js',
      status: 'VERIFIED',
      delta: 'UNCHANGED',
      description: 'Manages order lifecycle',
      details: { files: ['src/services/OrderService.ts'] },
    },
    {
      id: 'primary_db',
      label: 'Orders DB',
      type: 'database',
      boundary: 'data_layer',
      technology: 'PostgreSQL',
      status: 'VERIFIED',
      delta: 'UNCHANGED',
      description: 'Relational store',
      details: { tables: ['orders'] },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'orders_service',
      target: 'primary_db',
      label: 'SQL',
      communication: 'sync',
      pathType: 'write',
    },
  ],
  views: {
    sequence: {
      title: 'Write order',
      steps: [{ step: 1, from: 'orders_service', to: 'primary_db', label: 'Insert order', sync: true }],
    },
  },
};

module.exports = { STARTER_SPEC, LEGACY_COMPAT_SPEC };
