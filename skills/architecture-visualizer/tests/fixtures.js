const VALID_SPEC = {
  meta: {
    title: 'Valid Spec',
    description: 'Clean system',
    grounding: 'illustrative',
    assumptions: ['Single region deployment'],
  },
  boundaries: [
    { id: 'edge_tier', label: 'Edge', type: 'container', order: 1 },
    { id: 'data_tier', label: 'Data', type: 'container', order: 2 },
  ],
  nodes: [
    {
      id: 'api',
      label: 'API Service',
      boundary: 'edge_tier',
      type: 'service',
      technology: 'Node.js',
      status: 'VERIFIED',
      delta: 'CHANGED',
      description: 'Handles order submission',
      details: { files: ['src/api/Api.ts'], tasks: [{ id: 'T1', title: 'Add discount step' }] },
    },
    {
      id: 'db',
      label: 'Orders DB',
      boundary: 'data_tier',
      type: 'database',
      technology: 'PostgreSQL 16',
      status: 'VERIFIED',
      delta: 'UNCHANGED',
      description: 'Relational store',
      details: { tables: ['orders'] },
    },
  ],
  edges: [{ id: 'e1', source: 'api', target: 'db', label: 'SQL Write', communication: 'sync', pathType: 'write' }],
  views: {
    sequence: {
      steps: [{ step: 1, from: 'api', to: 'db', label: 'Insert order', sync: true }],
    },
    implementation_plan: {
      phases: [{ name: 'Phase 1', tasks: [{ id: 'P1', title: 'Write migration', componentId: 'api', files: ['src/api/Api.ts'] }] }],
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const VERSION_2_SPEC = clone(VALID_SPEC);
VERSION_2_SPEC.schemaVersion = 2;
VERSION_2_SPEC.evidence = [
  {
    id: 'ev_api_file',
    type: 'file',
    locator: { path: 'src/api/Api.ts' },
    verification: 'compatibility',
  },
  {
    id: 'ev_db_table',
    type: 'table',
    locator: { table: 'orders' },
    verification: 'compatibility',
  },
];
VERSION_2_SPEC.nodes[0].evidenceIds = ['ev_api_file'];
VERSION_2_SPEC.nodes[1].evidenceIds = ['ev_db_table'];
VERSION_2_SPEC.policies = [];
VERSION_2_SPEC.scenarios = [
  {
    id: 'place_order',
    name: 'Place order',
    stages: [
      {
        id: 'stage_1',
        kind: 'interaction',
        interactions: [
          {
            id: 'i1',
            from: 'api',
            to: 'db',
            label: 'Insert order',
            edgeId: 'e1',
          },
        ],
      },
    ],
  },
];

const ADVERSARIAL_RECIPROCAL_SPEC = {
  meta: { title: 'Reciprocal Routes', description: 'Bidirectional traffic', grounding: 'illustrative' },
  boundaries: [
    { id: 'b_frontend', label: 'Frontend Tier', order: 1 },
    { id: 'b_backend', label: 'Backend Tier', order: 2 },
  ],
  nodes: [
    { id: 'node_web', label: 'Web Client', boundary: 'b_frontend', type: 'service' },
    { id: 'node_api', label: 'Core API', boundary: 'b_backend', type: 'service' },
  ],
  edges: [
    { id: 'edge_forward', source: 'node_web', target: 'node_api', label: 'GraphQL Mutation', communication: 'sync' },
    { id: 'edge_backward', source: 'node_api', target: 'node_web', label: 'WebSocket Push', communication: 'async' },
  ],
};

const ADVERSARIAL_DENSE_PORTS_SPEC = {
  meta: { title: 'Dense Shared Ports', description: 'Port congestion check', grounding: 'illustrative' },
  boundaries: [
    { id: 'b_ingress', label: 'Ingress', order: 1 },
    { id: 'b_egress', label: 'Egress', order: 2 },
  ],
  nodes: [
    { id: 'hub', label: 'Event Router', boundary: 'b_ingress', type: 'service' },
    { id: 'sink_1', label: 'Billing Sink', boundary: 'b_egress', type: 'service', order: 1 },
    { id: 'sink_2', label: 'Audit Sink', boundary: 'b_egress', type: 'service', order: 2 },
    { id: 'sink_3', label: 'Analytics Sink', boundary: 'b_egress', type: 'service', order: 3 },
    { id: 'sink_4', label: 'Notify Sink', boundary: 'b_egress', type: 'service', order: 4 },
    { id: 'sink_5', label: 'Archive Sink', boundary: 'b_egress', type: 'service', order: 5 },
  ],
  edges: [
    { id: 'e_sink_5', source: 'hub', target: 'sink_5', label: 'Route Archive', communication: 'async' },
    { id: 'e_sink_4', source: 'hub', target: 'sink_4', label: 'Route Notify', communication: 'async' },
    { id: 'e_sink_3', source: 'hub', target: 'sink_3', label: 'Route Analytics', communication: 'async' },
    { id: 'e_sink_2', source: 'hub', target: 'sink_2', label: 'Route Audit', communication: 'async' },
    { id: 'e_sink_1', source: 'hub', target: 'sink_1', label: 'Route Billing', communication: 'async' },
  ],
};

const ADVERSARIAL_CLIPPED_BOUNDS_SPEC = {
  meta: { title: 'Channel Bounding', description: 'Visual extents check', grounding: 'illustrative' },
  boundaries: [
    { id: 'tier_1', label: 'Tier 1', order: 1 },
    { id: 'tier_2', label: 'Tier 2', order: 2 },
    { id: 'tier_3', label: 'Tier 3', order: 3 },
  ],
  nodes: [
    { id: 'node_start', label: 'Origin Service', boundary: 'tier_1', type: 'service' },
    { id: 'node_mid', label: 'Relay Service', boundary: 'tier_2', type: 'service' },
    { id: 'node_dest', label: 'Destination Service', boundary: 'tier_3', type: 'service' },
  ],
  edges: [
    { id: 'edge_mid', source: 'node_start', target: 'node_mid', label: 'Step One Relay', communication: 'sync' },
    { id: 'edge_dest', source: 'node_mid', target: 'node_dest', label: 'Step Two Relay', communication: 'sync' },
    { id: 'edge_channel_skip', source: 'node_start', target: 'node_dest', label: 'High Priority Direct Channel', communication: 'async' },
  ],
};

const ADVERSARIAL_SIBLING_SPEC = {
  meta: { title: 'Sibling Terminal Geometry', description: 'Tight sibling check', grounding: 'illustrative' },
  boundaries: [{ id: 'tier_cluster', label: 'Cluster', order: 1 }],
  nodes: [
    { id: 'sib_leader', label: 'Cluster Leader', boundary: 'tier_cluster', type: 'service', order: 1 },
    { id: 'sib_replica', label: 'Replica Follower', boundary: 'tier_cluster', type: 'service', order: 2 },
  ],
  edges: [{ id: 'edge_heartbeat', source: 'sib_leader', target: 'sib_replica', label: 'Consensus Heartbeat Sync', communication: 'sync' }],
};

const ADVERSARIAL_COLLISION_SPEC = {
  meta: { title: 'Collision Stress', description: 'Label and card spacing', grounding: 'illustrative' },
  boundaries: [
    { id: 'col_b1', label: 'Left Cluster', order: 1 },
    { id: 'col_b2', label: 'Right Cluster', order: 2 },
  ],
  nodes: [
    { id: 'src_top', label: 'Source Primary', boundary: 'col_b1', type: 'service', order: 1 },
    { id: 'src_bot', label: 'Source Secondary', boundary: 'col_b1', type: 'service', order: 2 },
    { id: 'tgt_top', label: 'Target Primary', boundary: 'col_b2', type: 'service', order: 1 },
    { id: 'tgt_bot', label: 'Target Secondary', boundary: 'col_b2', type: 'service', order: 2 },
  ],
  edges: [
    { id: 'e_par1', source: 'src_top', target: 'tgt_top', label: 'Parallel Primary Stream A', communication: 'sync' },
    { id: 'e_par2', source: 'src_top', target: 'tgt_top', label: 'Parallel Primary Stream B', communication: 'sync' },
    { id: 'e_diag', source: 'src_top', target: 'tgt_bot', label: 'Diagonal Cross Traffic Direct', communication: 'async' },
  ],
};

module.exports = {
  VALID_SPEC,
  VERSION_2_SPEC,
  ADVERSARIAL_RECIPROCAL_SPEC,
  ADVERSARIAL_DENSE_PORTS_SPEC,
  ADVERSARIAL_CLIPPED_BOUNDS_SPEC,
  ADVERSARIAL_SIBLING_SPEC,
  ADVERSARIAL_COLLISION_SPEC,
  clone,
};
