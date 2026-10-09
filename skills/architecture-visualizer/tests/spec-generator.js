// Deterministic generator of varied, valid architecture specs. The workbench must produce a clean,
// readable page for any model, not just the three examples, so tests run it over many shapes:
// one to six boundaries, two to twenty-six components of every kind, long and short names,
// sparse and dense connections, backward links, zero to two scenarios with parallel steps and
// outcome branches (one of them empty, one a recovery path), policies, evidence and deltas.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['actor', 'frontend', 'mobile', 'api_gateway', 'service', 'worker', 'database', 'storage', 'cache', 'queue', 'topic', 'external', 'cloud_function', 'boundary_group'];
const WORDS = ['Order', 'Payment', 'Ledger', 'Gateway', 'Catalog', 'Search', 'Identity', 'Billing', 'Inventory', 'Shipping',
  'Notification', 'Audit', 'Pricing', 'Fraud', 'Analytics', 'Session', 'Profile', 'Media', 'Export', 'Reconciliation',
  'Settlement', 'Webhook', 'Scheduler', 'Projection', 'Snapshot', 'Replica', 'Outbox', 'Cache', 'Index', 'Stream'];
const SUFFIX = { actor: 'User', frontend: 'Portal', mobile: 'App', api_gateway: 'Gateway', service: 'Service', worker: 'Worker',
  database: 'DB', storage: 'Bucket', cache: 'Cache', queue: 'Queue', topic: 'Topic', external: 'Provider', cloud_function: 'Function', boundary_group: 'Module' };
const TECH = ['Node.js / Fastify', 'Go', 'PostgreSQL 16', 'Redis 7', 'Kafka 3.6', 'Python / FastAPI', 'React / Vite', 'S3', 'Java / Spring Boot', 'Rust / Axum', ''];
const VERBS = ['Read', 'Write', 'Publish', 'Consume', 'Query', 'Sync', 'Notify', 'Fetch', 'Persist', 'Replicate', 'Stream', 'Validate'];
const TIERS = ['Client Applications', 'Edge & Gateway', 'Core Domain Services', 'Asynchronous Messaging Backbone', 'Data Storage & Persistence Layer', 'External Partners'];

function generateSpec(seed) {
  const random = mulberry32(seed);
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const pick = list => list[Math.floor(random() * list.length)];
  const words = (min, max) => Array.from({ length: int(min, max) }, () => pick(WORDS)).join(' ');

  const boundaryCount = int(1, 6);
  const boundaries = Array.from({ length: boundaryCount }, (_, i) => ({
    id: `b${i}`,
    label: random() < 0.3 ? `${TIERS[i % TIERS.length]} and ${words(2, 3)} Tier` : TIERS[i % TIERS.length],
    type: 'container',
    order: i + 1,
  }));

  const nodeCount = int(2, 26);
  const nodes = Array.from({ length: nodeCount }, (_, i) => {
    const type = pick(KINDS);
    const longName = random() < 0.15;
    return {
      id: `n${i}`,
      label: `${words(longName ? 4 : 1, longName ? 6 : 2)} ${SUFFIX[type]}`,
      boundary: boundaries[Math.min(boundaryCount - 1, Math.floor((i / nodeCount) * boundaryCount + random() * 0.6))].id,
      type,
      technology: pick(TECH),
      status: pick(['VERIFIED', 'VERIFIED', 'INFERRED', 'ASSUMED']),
      delta: pick(['UNCHANGED', 'UNCHANGED', 'UNCHANGED', 'ADDED', 'CHANGED']),
      description: random() < 0.85 ? `${words(3, 10)} for the ${words(1, 2).toLowerCase()} flow.` : undefined,
      details: random() < 0.6 ? {
        responsibilities: Array.from({ length: int(1, 3) }, () => words(2, 5)),
        files: random() < 0.5 ? [`src/${words(1, 1).toLowerCase()}/${words(1, 1)}.ts`] : undefined,
        failureModes: random() < 0.25 ? [{ failure: `${words(2, 3)} timeout`, impact: words(3, 6), mitigation: words(3, 6) }] : undefined,
      } : undefined,
    };
  });

  const edges = [];
  const seen = new Set();
  const addEdge = (source, target) => {
    const key = `${source}->${target}`;
    if (source === target || seen.has(key) || seen.has(`${target}->${source}`)) return null;
    seen.add(key);
    const long = random() < 0.2;
    const edge = {
      id: `e${edges.length}`,
      source,
      target,
      label: long ? `${pick(VERBS)} ${words(2, 3)}` : `${pick(VERBS)} ${pick(WORDS)}`,
      communication: random() < 0.4 ? 'async' : 'sync',
      pathType: pick(['read', 'write', 'event', 'request']),
    };
    edges.push(edge);
    return edge;
  };
  for (let i = 1; i < nodeCount; i++) addEdge(`n${int(0, i - 1)}`, `n${i}`);
  const extra = int(0, Math.ceil(nodeCount * 0.8));
  for (let i = 0; i < extra; i++) addEdge(`n${int(0, nodeCount - 1)}`, `n${int(0, nodeCount - 1)}`);

  const evidence = [];
  nodes.forEach(node => {
    if (node.status !== 'VERIFIED') return;
    random(); // Preserve the seeded sequence used by the remaining fixture fields.
    const record = { id: `ev_${node.id}`, type: 'file', locator: { path: `src/${node.id}/index.ts` }, verification: 'compatibility' };
    evidence.push(record);
    node.evidenceIds = [record.id];
  });

  const interaction = (scenario, k, edge, extraFields) => ({
    id: `${scenario}_s${k}`,
    name: `${pick(VERBS)} ${words(1, 3)}`,
    type: 'interaction',
    from: edge.source,
    to: edge.target,
    source: edge.source,
    target: edge.target,
    edgeId: edge.id,
    label: edge.label,
    payload: random() < 0.5 ? { id: String(int(100, 9999)), [pick(WORDS).toLowerCase()]: pick(WORDS) } : undefined,
    status: 'success',
    ...extraFields,
  });
  const scenarios = Array.from({ length: int(0, 2) }, (_, si) => {
    const id = `sc${si}`;
    let k = 0;
    const stages = [];
    const length = int(1, 7);
    for (let i = 0; i < length; i++) stages.push(interaction(id, k++, pick(edges)));
    if (random() < 0.5 && edges.length > 2) {
      stages.splice(int(0, stages.length), 0, { id: `${id}_p${k++}`, name: `${words(1, 2)} in parallel`, type: 'parallel',
        stages: Array.from({ length: int(2, 3) }, () => interaction(id, k++, pick(edges))) });
    }
    if (random() < 0.6) {
      const branchCount = int(2, 3);
      stages.push({ id: `${id}_d${k++}`, name: `${words(1, 2)} decision`, type: 'branch', condition: `${words(2, 4)} succeeds`,
        branches: Array.from({ length: branchCount }, (_, bi) => ({
          name: bi === 0 ? 'Happy path' : `${words(1, 3)} recovery`,
          condition: words(2, 4),
          status: bi === 0 ? 'success' : 'recovery',
          stages: bi === 0 && random() < 0.5 ? [] : Array.from({ length: int(1, 4) }, () => interaction(id, k++, pick(edges))),
        })) });
    }
    return { id, name: `${words(2, 4)} scenario`, description: words(4, 8), stages };
  });

  const policies = [];
  if (random() < 0.6 && edges.length) {
    const edge = pick(edges);
    policies.push({ id: 'p_required', kind: 'required_dependency', from: edge.source, to: edge.target, description: `${edge.source} must reach ${edge.target}` });
  }
  if (random() < 0.6 && nodeCount > 3) {
    const from = `n${int(0, nodeCount - 1)}`;
    const to = `n${int(0, nodeCount - 1)}`;
    if (from !== to && !seen.has(`${from}->${to}`)) policies.push({ id: 'p_forbidden', kind: 'forbidden_dependency', from, to, description: `${from} must not call ${to} directly` });
  }

  return JSON.parse(JSON.stringify({
    schemaVersion: 2,
    meta: { title: `${words(2, 5)} Platform`, description: `${words(6, 16)}.`, status: pick(['PROPOSED', 'ACCEPTED']),
      grounding: 'illustrative', author: 'Generated fixture', date: '2026-09-17', assumptions: random() < 0.5 ? [words(4, 8)] : [] },
    boundaries,
    nodes,
    edges,
    evidence,
    policies,
    scenarios,
  }));
}

module.exports = { generateSpec, mulberry32 };
