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

// A deterministic stress model: 6 tiers x 10 components, ~90 labelled edges (mostly between
// neighbouring tiers, with a few backward and long spans), two policies and one 20-stage scenario.
// Built in code so the shape stays identical from run to run and can be resized if the budgets move.
function buildLargeSpec() {
  const BOUNDARY_COUNT = 6;
  const PER_BOUNDARY = 10;
  const TYPES = ['service', 'service', 'api_gateway', 'worker', 'database', 'cache', 'queue', 'topic', 'storage', 'frontend'];
  const STATUSES = ['VERIFIED', 'INFERRED', 'VERIFIED', 'ASSUMED', 'UNKNOWN'];
  const DELTAS = ['UNCHANGED', 'CHANGED', 'ADDED', 'UNCHANGED', 'UNCHANGED', 'CHANGED', 'ADDED'];

  const boundaries = [];
  const nodes = [];
  for (let b = 0; b < BOUNDARY_COUNT; b += 1) {
    boundaries.push({ id: `tier_${b}`, label: `Tier ${b + 1}`, type: 'container', order: b + 1 });
    for (let n = 0; n < PER_BOUNDARY; n += 1) {
      const index = b * PER_BOUNDARY + n;
      nodes.push({
        id: `comp_${b}_${n}`,
        label: `Component ${b + 1}.${n + 1}`,
        boundary: `tier_${b}`,
        type: TYPES[(b + n) % TYPES.length],
        technology: `Runtime ${((b + n) % 5) + 1}`,
        status: STATUSES[(b * 2 + n) % STATUSES.length],
        delta: DELTAS[(b + n * 2) % DELTAS.length],
        description: `Component ${b + 1}.${n + 1} in tier ${b + 1}.`,
      });
    }
  }

  const nodeId = (b, n) => `comp_${b}_${n}`;
  const edges = [];
  const addEdge = (id, source, target, index) => {
    edges.push({
      id,
      source,
      target,
      label: `Edge ${index}`,
      communication: index % 2 === 0 ? 'sync' : 'async',
      pathType: index % 3 === 0 ? 'request' : index % 3 === 1 ? 'event' : 'read',
    });
  };

  let edgeIndex = 0;
  // 5 adjacent boundaries x 14 edges = 70 forward edges between neighbouring tiers.
  for (let b = 0; b < BOUNDARY_COUNT - 1; b += 1) {
    for (let k = 0; k < 14; k += 1) {
      addEdge(`edge_fwd_${b}_${k}`, nodeId(b, k % PER_BOUNDARY), nodeId(b + 1, (k * 3 + 1) % PER_BOUNDARY), edgeIndex);
      edgeIndex += 1;
    }
  }
  // 5 backward edges that point against the tier order.
  for (let b = 0; b < BOUNDARY_COUNT - 1; b += 1) {
    addEdge(`edge_back_${b}`, nodeId(b + 1, (b * 3 + 4) % PER_BOUNDARY), nodeId(b, (b * 5 + 2) % PER_BOUNDARY), edgeIndex);
    edgeIndex += 1;
  }
  // 15 long edges that skip a tier entirely.
  for (let k = 0; k < 15; k += 1) {
    addEdge(`edge_long_${k}`, nodeId(k % 4, (k * 5) % PER_BOUNDARY), nodeId((k % 4) + 2, (k * 7 + 3) % PER_BOUNDARY), edgeIndex);
    edgeIndex += 1;
  }

  const scenarioHit = (index) => {
    const edge = edges[index % edges.length];
    return { from: edge.source, to: edge.target, edgeId: edge.id, label: edge.label };
  };
  const scenarioStage = (id, name, index) => ({
    id,
    name,
    kind: 'interaction',
    interactions: [Object.assign({ id: `${id}_hop` }, scenarioHit(index))],
  });

  const stages = [];
  for (let i = 0; i < 18; i += 1) {
    stages.push(scenarioStage(`stage_${i + 1}`, `Stage ${i + 1}`, i * 5 + 1));
  }
  stages.push({
    id: 'stage_parallel',
    name: 'Parallel Stage',
    kind: 'parallel',
    description: 'Two hops run at the same time.',
    interactions: [
      Object.assign({ id: 'stage_parallel_hop_1' }, scenarioHit(3)),
      Object.assign({ id: 'stage_parallel_hop_2' }, scenarioHit(31)),
    ],
  });
  stages.push({
    id: 'stage_branch',
    name: 'Branch Stage',
    kind: 'branch',
    condition: 'Condition holds',
    branches: [
      {
        name: 'Happy Path',
        condition: 'Everything is intact',
        status: 'success',
        stages: [scenarioStage('stage_branch_happy', 'Happy Branch', 47)],
      },
      {
        name: 'Fallback Path',
        condition: 'Something failed',
        status: 'recovery',
        stages: [scenarioStage('stage_branch_fallback', 'Fallback Branch', 74)],
      },
    ],
  });

  return {
    schemaVersion: 2,
    meta: {
      title: 'Large Fixture',
      description: 'A 60-component, 90-edge stress model for rendered performance budgets.',
      grounding: 'illustrative',
      assumptions: ['Synthetic model; no repository backing.'],
    },
    boundaries,
    nodes,
    edges,
    views: {
      sequence: {
        steps: [
          Object.assign({ step: 1 }, scenarioHit(1)),
          Object.assign({ step: 2 }, scenarioHit(12)),
        ],
      },
    },
    evidence: [],
    policies: [
      {
        id: 'pol_large_layer_direction',
        kind: 'layer_direction',
        layers: boundaries.map((boundary) => boundary.id),
        description: 'Traffic should flow down the tier order.',
      },
      {
        id: 'pol_large_fan_in',
        kind: 'fan_in',
        max: 40,
        description: 'No component should absorb an unreasonable fan-in.',
      },
    ],
    scenarios: [
      {
        id: 'scenario_large',
        name: 'Large Scenario',
        description: 'Twenty stages across the large model, including a parallel step and a branch.',
        stages,
      },
    ],
  };
}

const LARGE_SPEC = buildLargeSpec();

module.exports = {
  VALID_SPEC,
  VERSION_2_SPEC,
  ADVERSARIAL_RECIPROCAL_SPEC,
  ADVERSARIAL_DENSE_PORTS_SPEC,
  ADVERSARIAL_CLIPPED_BOUNDS_SPEC,
  ADVERSARIAL_SIBLING_SPEC,
  ADVERSARIAL_COLLISION_SPEC,
  LARGE_SPEC,
  buildLargeSpec,
  clone,
};
