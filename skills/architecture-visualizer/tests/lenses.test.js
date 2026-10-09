const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compileArchitecture } = require('../src/engine/compiler.js');

const trustSource = fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/trust.js'), 'utf8');
const lensSource = fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/lenses.js'), 'utf8');
const ctx = { JSON, Object, Array, Set, String, Number, Math };
vm.createContext(ctx);
vm.runInContext(trustSource, ctx);
vm.runInContext(lensSource, ctx);

// Objects built inside the vm realm have that realm's prototypes; rebuilding them in
// the host realm keeps the assertions about values, not realms.
function host(value) {
  return JSON.parse(JSON.stringify(value));
}

const { lensEncoding, suggestedLens } = ctx;
const LENSES = host(vm.runInContext('LENSES', ctx));

const STROKES = ['line', 'ink', 'ok', 'warn', 'risk', 'edge'];
const STROKE_STYLES = ['solid', 'dashed', 'dotted'];
const FILLS = [null, 'ok-tint', 'surface-2'];
const TONES = ['ok', 'warn', 'risk', 'neutral'];
const MARKERS = [null, 'exception-ring', 'evidence-missing'];
const NODE_KEYS = ['badge', 'fill', 'marker', 'mutedText', 'strike', 'stroke', 'strokeStyle'];
const EDGE_KEYS = ['stroke', 'strokeStyle'];

function baseSpec(overrides) {
  return Object.assign(
    {
      meta: {},
      nodes: [],
      edges: [],
      evidence: [],
      policies: [],
      findings: [],
      review: {},
    },
    overrides || {}
  );
}

function record(id, nodeId, overrides) {
  return Object.assign(
    { id, nodeId, type: 'file', locator: `src/${id}.ts`, verification: 'verified' },
    overrides || {}
  );
}

function nodeEnc(overrides) {
  return Object.assign(
    { stroke: 'line', strokeStyle: 'solid', fill: null, badge: null, strike: false, mutedText: false, marker: null },
    overrides || {}
  );
}

function edgeEnc(stroke, strokeStyle) {
  return { stroke, strokeStyle };
}

function encode(lens, spec, options) {
  return host(lensEncoding(lens, spec, options));
}

// The risk lens reads the same findings the validator publishes, so the policy cases below build a
// real spec, compile it, and encode the embedded model rather than hand-writing findings.
function compiled(spec) {
  const result = compileArchitecture(spec);
  const match = result.html.match(/const ARCH_SPEC = (\{[\s\S]*?\});\n/);
  assert.ok(match, 'embedded ARCH_SPEC was not found');
  return JSON.parse(match[1]);
}

function riskBase(overrides) {
  return Object.assign(
    { meta: { title: 'Risk audit', description: 'Risk lens fixture', grounding: 'illustrative' } },
    overrides || {}
  );
}

function service(id, boundary) {
  return Object.assign({ id, label: id.toUpperCase(), type: 'service' }, boundary ? { boundary } : {});
}

function assertNoOpacity(value, where) {
  if (!value || typeof value !== 'object') return;
  assert.ok(!('opacity' in value), `opacity key found in ${where}`);
  Object.keys(value).forEach((key) => assertNoOpacity(value[key], `${where}.${key}`));
}

function assertKeyItemTokens(item, where) {
  assert.ok(STROKES.indexOf(item.stroke) !== -1, `bad key stroke ${item.stroke} at ${where}`);
  assert.ok(STROKE_STYLES.indexOf(item.strokeStyle) !== -1, `bad key strokeStyle at ${where}`);
}

function assertNodeTokens(encoding, where) {
  assert.deepStrictEqual(Object.keys(encoding).sort(), NODE_KEYS, `unexpected node keys at ${where}`);
  assert.ok(STROKES.indexOf(encoding.stroke) !== -1, `bad stroke ${encoding.stroke} at ${where}`);
  assert.ok(STROKE_STYLES.indexOf(encoding.strokeStyle) !== -1, `bad strokeStyle ${encoding.strokeStyle} at ${where}`);
  assert.ok(FILLS.indexOf(encoding.fill) !== -1, `bad fill ${encoding.fill} at ${where}`);
  assert.ok(MARKERS.indexOf(encoding.marker) !== -1, `bad marker ${encoding.marker} at ${where}`);
  assert.strictEqual(typeof encoding.strike, 'boolean', `strike not boolean at ${where}`);
  assert.strictEqual(typeof encoding.mutedText, 'boolean', `mutedText not boolean at ${where}`);
  if (encoding.badge === null) return;
  assert.strictEqual(typeof encoding.badge.text, 'string', `badge text at ${where}`);
  assert.ok(TONES.indexOf(encoding.badge.tone) !== -1, `bad tone ${encoding.badge.tone} at ${where}`);
}

function assertEdgeTokens(encoding, where) {
  assert.deepStrictEqual(Object.keys(encoding).sort(), EDGE_KEYS, `unexpected edge keys at ${where}`);
  assert.ok(STROKES.indexOf(encoding.stroke) !== -1, `bad edge stroke at ${where}`);
  assert.ok(STROKE_STYLES.indexOf(encoding.strokeStyle) !== -1, `bad edge strokeStyle at ${where}`);
}

const cases = [
  // --- the lens list ---

  [
    'the four lenses are declared in order',
    () => {
      assert.deepStrictEqual(LENSES, ['structure', 'evidence', 'change', 'risk']);
    },
  ],

  // --- structure ---

  [
    'structure: nodes are line solid and only non-VERIFIED nodes get a ring',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'good', status: 'VERIFIED', delta: 'UNCHANGED' },
          { id: 'inferred', status: 'INFERRED', delta: 'UNCHANGED' },
        ],
      });
      const encoding = encode('structure', spec);
      assert.deepStrictEqual(encoding.nodes.good, nodeEnc());
      assert.deepStrictEqual(encoding.nodes.inferred, nodeEnc({ marker: 'exception-ring' }));
    },
  ],

  [
    'structure: sync edges are solid and async edges are dashed',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        edges: [
          { id: 'e1', source: 'a', target: 'a', communication: 'sync' },
          { id: 'e2', source: 'a', target: 'a', communication: 'async' },
        ],
      });
      const encoding = encode('structure', spec);
      assert.deepStrictEqual(encoding.edges.e1, edgeEnc('edge', 'solid'));
      assert.deepStrictEqual(encoding.edges.e2, edgeEnc('edge', 'dashed'));
    },
  ],

  [
    'structure: key offers Call and Event only for edge kinds present',
    () => {
      const syncOnly = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        edges: [{ id: 'e1', source: 'a', target: 'a', communication: 'sync' }],
      });
      assert.deepStrictEqual(encode('structure', syncOnly).keyItems, [
        { id: 'call', label: 'Call', stroke: 'edge', strokeStyle: 'solid' },
      ]);
      const asyncOnly = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        edges: [{ id: 'e2', source: 'a', target: 'a', communication: 'async' }],
      });
      assert.deepStrictEqual(encode('structure', asyncOnly).keyItems, [
        { id: 'event', label: 'Event', stroke: 'edge', strokeStyle: 'dashed' },
      ]);
    },
  ],

  [
    'structure: the evidence key appears only when a node lacks verification',
    () => {
      const verified = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        edges: [{ id: 'e1', source: 'a', target: 'a', communication: 'sync' }],
      });
      assert.deepStrictEqual(encode('structure', verified).keyItems.map((item) => item.id), ['call']);
      const mixed = baseSpec({ nodes: [{ id: 'a', status: 'ASSUMED', delta: 'UNCHANGED' }] });
      assert.deepStrictEqual(encode('structure', mixed).keyItems, [
        { id: 'not-backed', label: 'Not backed by evidence', stroke: 'line', strokeStyle: 'solid' },
      ]);
    },
  ],

  // --- evidence ---

  [
    'evidence: verified reads ink with a locator count',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [record('e1', 'a'), record('e2', 'a', { locator: 'src/other.ts' })],
      });
      assert.deepStrictEqual(encode('evidence', spec).nodes.a, nodeEnc({
        stroke: 'ink',
        badge: { text: 'Verified · 2', tone: 'ok' },
      }));
    },
  ],

  [
    'evidence: declared is neutral and counts locators',
    () => {
      const spec = baseSpec({
        meta: { grounding: 'illustrative' },
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [record('e1', 'a', { verification: 'compatibility' })],
      });
      assert.deepStrictEqual(encode('evidence', spec).nodes.a, nodeEnc({
        badge: { text: 'Declared · 1', tone: 'neutral' },
      }));
    },
  ],

  [
    'evidence: declared but unchecked keeps the exception ring',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [record('e1', 'a', { verification: 'compatibility' })],
      });
      assert.deepStrictEqual(encode('evidence', spec).nodes.a, nodeEnc({
        marker: 'exception-ring',
        badge: { text: 'Declared, not checked · 1', tone: 'neutral' },
      }));
    },
  ],

  [
    'evidence: an asserted node badges its assertion label',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [record('e1', 'a', { verification: 'asserted', author: 'Dana' })],
      });
      assert.deepStrictEqual(encode('evidence', spec).nodes.a, nodeEnc({
        badge: { text: 'Asserted by Dana', tone: 'neutral' },
      }));
    },
  ],

  [
    'evidence: stale is a warning, missing is a risk',
    () => {
      const stale = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [record('e1', 'a', { verification: 'stale' })],
      });
      assert.deepStrictEqual(encode('evidence', stale).nodes.a, nodeEnc({
        stroke: 'warn',
        badge: { text: 'Stale', tone: 'warn' },
      }));
      const missing = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [record('e1', 'a', { verification: 'unresolved' })],
      });
      assert.deepStrictEqual(encode('evidence', missing).nodes.a, nodeEnc({
        stroke: 'risk',
        strokeStyle: 'dashed',
        badge: { text: 'Missing', tone: 'risk' },
      }));
    },
  ],

  [
    'evidence: an added node with no records is planned, dotted',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'a', status: 'INFERRED', delta: 'ADDED' }] });
      assert.deepStrictEqual(encode('evidence', spec).nodes.a, nodeEnc({
        strokeStyle: 'dotted',
        badge: { text: 'Planned', tone: 'neutral' },
      }));
    },
  ],

  [
    'evidence: a recordless node carries its inferred, assumed or unknown label',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'inferred', status: 'INFERRED', delta: 'UNCHANGED' },
          { id: 'assumed', status: 'ASSUMED', delta: 'UNCHANGED' },
          { id: 'other', status: 'VERIFIED', delta: 'UNCHANGED' },
        ],
      });
      const encoding = encode('evidence', spec);
      assert.deepStrictEqual(encoding.nodes.inferred, nodeEnc({
        stroke: 'warn',
        strokeStyle: 'dashed',
        badge: { text: 'Inferred', tone: 'warn' },
      }));
      assert.strictEqual(encoding.nodes.assumed.badge.text, 'Assumed');
      assert.strictEqual(encoding.nodes.other.badge.text, 'Unknown');
    },
  ],

  [
    'evidence: edges keep the structure encoding',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        edges: [
          { id: 'e1', source: 'a', target: 'a', communication: 'sync' },
          { id: 'e2', source: 'a', target: 'a', communication: 'async' },
        ],
      });
      const encoding = encode('evidence', spec);
      assert.deepStrictEqual(encoding.edges, encode('structure', spec).edges);
    },
  ],

  [
    'evidence: the key lists one entry per state present, in canonical order',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'planned', status: 'INFERRED', delta: 'ADDED' },
          { id: 'missing', status: 'VERIFIED', delta: 'UNCHANGED' },
          { id: 'verified', status: 'VERIFIED', delta: 'UNCHANGED' },
        ],
        evidence: [record('e1', 'verified'), record('e2', 'missing', { verification: 'unresolved' })],
      });
      assert.deepStrictEqual(encode('evidence', spec).keyItems, [
        { id: 'verified', label: 'Verified', stroke: 'ink', strokeStyle: 'solid' },
        { id: 'missing', label: 'Missing', stroke: 'risk', strokeStyle: 'dashed' },
        { id: 'planned', label: 'Planned', stroke: 'line', strokeStyle: 'dotted' },
      ]);
    },
  ],

  // --- change ---

  [
    'change: every node delta reads the documented way',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'added', delta: 'ADDED' },
          { id: 'changed', delta: 'CHANGED' },
          { id: 'removed', delta: 'REMOVED' },
          { id: 'moved', delta: 'MOVED', previousBoundary: 'b_old' },
          { id: 'same', delta: 'UNCHANGED' },
        ],
      });
      const encoding = encode('change', spec);
      assert.deepStrictEqual(encoding.nodes.added, nodeEnc({
        stroke: 'ok',
        fill: 'ok-tint',
        badge: { text: 'Added', tone: 'ok' },
      }));
      assert.deepStrictEqual(encoding.nodes.changed, nodeEnc({
        stroke: 'warn',
        badge: { text: 'Changed', tone: 'warn' },
      }));
      assert.deepStrictEqual(encoding.nodes.removed, nodeEnc({
        stroke: 'risk',
        strokeStyle: 'dashed',
        strike: true,
        badge: { text: 'Removed', tone: 'risk' },
      }));
      assert.deepStrictEqual(encoding.nodes.moved, nodeEnc({
        badge: { text: 'Moved from b_old', tone: 'neutral' },
      }));
      assert.deepStrictEqual(encoding.nodes.same, nodeEnc({
        fill: 'surface-2',
        mutedText: true,
      }));
    },
  ],

  [
    'change: a MOVED node without a previous boundary just reads Moved',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'moved', delta: 'MOVED' }] });
      assert.deepStrictEqual(encode('change', spec).nodes.moved.badge, { text: 'Moved', tone: 'neutral' });
    },
  ],

  [
    'change: a node without a delta reads as unchanged, muted',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'a' }] });
      assert.deepStrictEqual(encode('change', spec).nodes.a, nodeEnc({ fill: 'surface-2', mutedText: true }));
    },
  ],

  [
    'change: edges are ok when added, risk when removed, structure otherwise',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        edges: [
          { id: 'e1', source: 'a', target: 'a', delta: 'ADDED', communication: 'async' },
          { id: 'e2', source: 'a', target: 'a', delta: 'REMOVED', communication: 'async' },
          { id: 'e3', source: 'a', target: 'a', communication: 'sync' },
          { id: 'e4', source: 'a', target: 'a', communication: 'async' },
        ],
      });
      const encoding = encode('change', spec);
      assert.deepStrictEqual(encoding.edges.e1, edgeEnc('ok', 'solid'));
      assert.deepStrictEqual(encoding.edges.e2, edgeEnc('risk', 'dashed'));
      assert.deepStrictEqual(encoding.edges.e3, edgeEnc('edge', 'solid'));
      assert.deepStrictEqual(encoding.edges.e4, edgeEnc('edge', 'dashed'));
    },
  ],

  [
    'change: the key lists the deltas present in canonical order',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'same', delta: 'UNCHANGED' },
          { id: 'removed', delta: 'REMOVED' },
          { id: 'added', delta: 'ADDED' },
        ],
      });
      assert.deepStrictEqual(encode('change', spec).keyItems, [
        { id: 'added', label: 'Added', stroke: 'ok', strokeStyle: 'solid' },
        { id: 'removed', label: 'Removed', stroke: 'risk', strokeStyle: 'dashed' },
        { id: 'unchanged', label: 'Unchanged', stroke: 'line', strokeStyle: 'solid' },
      ]);
    },
  ],

  // --- risk ---

  [
    'risk: failure modes warn, with the singular when there is one',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'one', delta: 'UNCHANGED', details: { failureModes: ['breaks'] } },
          { id: 'two', delta: 'UNCHANGED', details: { failureModes: ['a', 'b'] } },
          { id: 'none', delta: 'UNCHANGED' },
        ],
      });
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.nodes.one, nodeEnc({
        stroke: 'warn',
        badge: { text: '1 failure mode', tone: 'warn' },
      }));
      assert.deepStrictEqual(encoding.nodes.two.badge, { text: '2 failure modes', tone: 'warn' });
      assert.deepStrictEqual(encoding.nodes.none, nodeEnc());
    },
  ],

  [
    'risk: a finding beats failure modes and badges its policy id',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', delta: 'UNCHANGED', details: { failureModes: ['breaks'] } }],
        findings: [{ id: 'f1', policyId: 'pol_no_direct', nodeIds: ['a'], edgeIds: [] }],
      });
      assert.deepStrictEqual(encode('risk', spec).nodes.a, nodeEnc({
        stroke: 'risk',
        badge: { text: 'pol_no_direct', tone: 'risk' },
      }));
    },
  ],

  [
    'risk: the first finding for a node supplies the badge',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', delta: 'UNCHANGED' }],
        findings: [
          { id: 'f1', policyId: 'pol_first', nodeIds: ['a'] },
          { id: 'f2', policyId: 'pol_second', nodeIds: ['a'] },
        ],
      });
      assert.strictEqual(encode('risk', spec).nodes.a.badge.text, 'pol_first');
    },
  ],

  [
    'risk: policy findings from the review are included too',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', delta: 'UNCHANGED' }],
        review: { policyFindings: [{ id: 'f1', policyId: 'pol_review', nodeIds: ['a'] }] },
      });
      assert.strictEqual(encode('risk', spec).nodes.a.badge.text, 'pol_review');
    },
  ],

  [
    'risk: edges in findings are risks, required edges are ok, others structure',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'a', delta: 'UNCHANGED' },
          { id: 'b', delta: 'UNCHANGED' },
        ],
        edges: [
          { id: 'bad', source: 'a', target: 'b', communication: 'sync' },
          { id: 'req', source: 'a', target: 'b', communication: 'async' },
          { id: 'plain', source: 'b', target: 'a', communication: 'async' },
        ],
        policies: [{ id: 'pol_req', kind: 'required_dependency', from: 'a', to: 'b' }],
        findings: [{ id: 'f1', policyId: 'pol_v', edgeIds: ['bad'] }],
      });
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.edges.bad, edgeEnc('risk', 'solid'));
      assert.deepStrictEqual(encoding.edges.req, edgeEnc('ok', 'solid'));
      assert.deepStrictEqual(encoding.edges.plain, edgeEnc('edge', 'dashed'));
    },
  ],

  [
    'risk: a forbidden policy with no finding becomes an absent ghost',
    () => {
      const spec = baseSpec({
        policies: [{ id: 'pol_forbidden', kind: 'forbidden_dependency', from: 'a', to: 'b' }],
      });
      assert.deepStrictEqual(encode('risk', spec).ghosts, [
        { from: 'a', to: 'b', label: 'Forbidden · absent', policyId: 'pol_forbidden' },
      ]);
    },
  ],

  [
    'risk: up to three forbidden ghosts are drawn, and no more without a selection',
    () => {
      const policies = [1, 2, 3, 4].map((n) => ({
        id: `pol_${n}`,
        kind: 'forbidden_dependency',
        from: `a${n}`,
        to: `b${n}`,
      }));
      const spec = baseSpec({ policies });
      assert.deepStrictEqual(encode('risk', spec).ghosts, []);
      assert.strictEqual(encode('risk', baseSpec({ policies: policies.slice(0, 3) })).ghosts.length, 3);
    },
  ],

  [
    'risk: a selected policy is drawn even past the limit',
    () => {
      const policies = [1, 2, 3, 4].map((n) => ({
        id: `pol_${n}`,
        kind: 'forbidden_dependency',
        from: `a${n}`,
        to: `b${n}`,
      }));
      const encoding = encode('risk', baseSpec({ policies }), { selectedPolicyId: 'pol_3' });
      assert.deepStrictEqual(encoding.ghosts, [
        { from: 'a3', to: 'b3', label: 'Forbidden · absent', policyId: 'pol_3' },
      ]);
    },
  ],

  [
    'risk: a required policy with a finding becomes a missing ghost',
    () => {
      const spec = baseSpec({
        policies: [{ id: 'pol_req', kind: 'required_dependency', from: 'a', to: 'b' }],
        findings: [{ id: 'f1', policyId: 'pol_req', edgeIds: [] }],
      });
      assert.deepStrictEqual(encode('risk', spec).ghosts, [
        { from: 'a', to: 'b', label: 'Required · missing', policyId: 'pol_req' },
      ]);
    },
  ],

  [
    'risk: a forbidden policy that already has a finding is not ghosted',
    () => {
      const spec = baseSpec({
        policies: [{ id: 'pol_forbidden', kind: 'forbidden_dependency', from: 'a', to: 'b' }],
        findings: [{ id: 'f1', policyId: 'pol_forbidden', edgeIds: ['e1'] }],
      });
      assert.deepStrictEqual(encode('risk', spec).ghosts, []);
    },
  ],

  [
    'risk: the key lists Required, Forbidden, Violation and Failure modes when present',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'a', delta: 'UNCHANGED', details: { failureModes: ['breaks'] } },
          { id: 'b', delta: 'UNCHANGED' },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b', communication: 'sync' }],
        policies: [
          { id: 'pol_req', kind: 'required_dependency', from: 'a', to: 'b' },
          { id: 'pol_forbidden', kind: 'forbidden_dependency', from: 'a', to: 'b' },
        ],
        findings: [{ id: 'f1', policyId: 'pol_v', nodeIds: ['b'] }],
      });
      assert.deepStrictEqual(encode('risk', spec).keyItems.map((item) => item.id), [
        'required',
        'forbidden',
        'violation',
        'failure-modes',
      ]);
    },
  ],

  [
    'risk: an empty model has no key items and no ghosts',
    () => {
      assert.deepStrictEqual(encode('risk', baseSpec()), { nodes: {}, edges: {}, ghosts: [], keyItems: [] });
    },
  ],

  // --- risk: every policy kind the validator evaluates ---

  [
    'risk: a layer-direction violation marks its edge against the flow',
    () => {
      const spec = compiled(riskBase({
        boundaries: [{ id: 'top', label: 'Top' }, { id: 'bottom', label: 'Bottom' }],
        nodes: [service('upper', 'top'), service('lower', 'bottom')],
        edges: [{ id: 'back', source: 'lower', target: 'upper', label: 'Back Up', communication: 'sync' }],
        policies: [{ id: 'pol_dir', kind: 'layer_direction', layers: ['top', 'bottom'] }],
      }));
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.edges.back, { stroke: 'risk', strokeStyle: 'solid', marker: 'against-flow' });
      assert.deepStrictEqual(encoding.keyItems.filter((item) => item.id === 'against-layer-order'), [
        { id: 'against-layer-order', label: 'Against the layer order', stroke: 'risk', strokeStyle: 'solid' },
      ]);
    },
  ],

  [
    'risk: a cycle numbers its edges in cycle order',
    () => {
      const spec = compiled(riskBase({
        nodes: [service('a'), service('b'), service('c')],
        edges: [
          { id: 'ab', source: 'a', target: 'b', label: 'ab' },
          { id: 'bc', source: 'b', target: 'c', label: 'bc' },
          { id: 'ca', source: 'c', target: 'a', label: 'ca' },
        ],
        policies: [{ id: 'pol_cycle', kind: 'cycle' }],
      }));
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.edges.ab, { stroke: 'risk', strokeStyle: 'solid', cycleIndex: 1 });
      assert.deepStrictEqual(encoding.edges.bc, { stroke: 'risk', strokeStyle: 'solid', cycleIndex: 2 });
      assert.deepStrictEqual(encoding.edges.ca, { stroke: 'risk', strokeStyle: 'solid', cycleIndex: 3 });
      assert.deepStrictEqual(encoding.keyItems.filter((item) => item.id === 'cycle'), [
        { id: 'cycle', label: 'Cycle', stroke: 'risk', strokeStyle: 'solid' },
      ]);
    },
  ],

  [
    'risk: a fan-in overload badges the count against the limit',
    () => {
      const spec = compiled(riskBase({
        nodes: [service('hub'), service('s1'), service('s2'), service('s3')],
        edges: [
          { id: 'e1', source: 's1', target: 'hub', label: 'e1' },
          { id: 'e2', source: 's2', target: 'hub', label: 'e2' },
          { id: 'e3', source: 's3', target: 'hub', label: 'e3' },
        ],
        policies: [{ id: 'pol_fan_in', kind: 'fan_in', max: 2 }],
      }));
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.nodes.hub, nodeEnc({
        stroke: 'risk',
        badge: { text: 'fan-in 3 / max 2', tone: 'risk' },
      }));
      assert.deepStrictEqual(encoding.keyItems.filter((item) => item.id === 'fan-limit'), [
        { id: 'fan-limit', label: 'Over its fan-in or fan-out limit', stroke: 'risk', strokeStyle: 'solid' },
      ]);
    },
  ],

  [
    'risk: a fan-out overload badges the count against the limit',
    () => {
      const spec = compiled(riskBase({
        nodes: [service('hub'), service('s1'), service('s2'), service('s3')],
        edges: [
          { id: 'e1', source: 'hub', target: 's1', label: 'e1' },
          { id: 'e2', source: 'hub', target: 's2', label: 'e2' },
          { id: 'e3', source: 'hub', target: 's3', label: 'e3' },
        ],
        policies: [{ id: 'pol_fan_out', kind: 'fan_out', max: 1 }],
      }));
      assert.deepStrictEqual(encode('risk', spec).nodes.hub.badge, { text: 'fan-out 3 / max 1', tone: 'risk' });
    },
  ],

  [
    'risk: a fan badge beats a failure mode',
    () => {
      const spec = compiled(riskBase({
        nodes: [
          Object.assign(service('hub'), { details: { failureModes: ['saturates'] } }),
          service('s1'), service('s2'), service('s3'),
        ],
        edges: [
          { id: 'e1', source: 's1', target: 'hub', label: 'e1' },
          { id: 'e2', source: 's2', target: 'hub', label: 'e2' },
          { id: 'e3', source: 's3', target: 'hub', label: 'e3' },
        ],
        policies: [{ id: 'pol_fan_in', kind: 'fan_in', max: 2 }],
      }));
      assert.deepStrictEqual(encode('risk', spec).nodes.hub, nodeEnc({
        stroke: 'risk',
        badge: { text: 'fan-in 3 / max 2', tone: 'risk' },
      }));
    },
  ],

  [
    'risk: a policy-id badge from another finding beats the fan badge',
    () => {
      const spec = compiled(riskBase({
        nodes: [service('hub'), service('s1'), service('s2'), service('s3'), service('source')],
        edges: [
          { id: 'e1', source: 's1', target: 'hub', label: 'e1' },
          { id: 'e2', source: 's2', target: 'hub', label: 'e2' },
          { id: 'e3', source: 's3', target: 'hub', label: 'e3' },
          { id: 'e4', source: 'source', target: 'hub', label: 'e4' },
        ],
        policies: [
          { id: 'pol_fan_in', kind: 'fan_in', max: 2 },
          { id: 'pol_forbidden', kind: 'forbidden_dependency', from: 'source', to: 'hub' },
        ],
      }));
      assert.deepStrictEqual(encode('risk', spec).nodes.hub, nodeEnc({
        stroke: 'risk',
        badge: { text: 'pol_forbidden', tone: 'risk' },
      }));
    },
  ],

  [
    'risk: a required-evidence failure marks the node and keeps any badge',
    () => {
      const spec = compiled(riskBase({
        nodes: [
          Object.assign(service('hub'), { status: 'VERIFIED' }),
          service('s1'), service('s2'), service('s3'),
        ],
        edges: [
          { id: 'e1', source: 's1', target: 'hub', label: 'e1' },
          { id: 'e2', source: 's2', target: 'hub', label: 'e2' },
          { id: 'e3', source: 's3', target: 'hub', label: 'e3' },
        ],
        policies: [
          { id: 'pol_fan_in', kind: 'fan_in', max: 2 },
          { id: 'pol_evidence', kind: 'required_evidence', status: 'VERIFIED' },
        ],
      }));
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.nodes.hub, nodeEnc({
        stroke: 'risk',
        badge: { text: 'fan-in 3 / max 2', tone: 'risk' },
        marker: 'evidence-missing',
      }));
      assert.deepStrictEqual(encoding.keyItems.filter((item) => item.id === 'required-evidence'), [
        { id: 'required-evidence', label: 'Missing required evidence', stroke: 'risk', strokeStyle: 'solid' },
      ]);
    },
  ],

  [
    'risk: a required-evidence failure alone still marks the node',
    () => {
      const spec = compiled(riskBase({
        nodes: [Object.assign(service('lonely'), { status: 'VERIFIED' })],
        policies: [{ id: 'pol_evidence', kind: 'required_evidence', status: 'VERIFIED' }],
      }));
      const encoding = encode('risk', spec);
      assert.deepStrictEqual(encoding.nodes.lonely, nodeEnc({ marker: 'evidence-missing' }));
    },
  ],

  // --- suggestedLens ---

  [
    'suggestedLens maps each chapter to its lens, defaulting to structure',
    () => {
      assert.strictEqual(suggestedLens('overview'), 'structure');
      assert.strictEqual(suggestedLens('walkthrough'), 'structure');
      assert.strictEqual(suggestedLens('data'), 'structure');
      assert.strictEqual(suggestedLens('evidence'), 'evidence');
      assert.strictEqual(suggestedLens('changes'), 'change');
      assert.strictEqual(suggestedLens('plan'), 'change');
      assert.strictEqual(suggestedLens('review'), 'risk');
      assert.strictEqual(suggestedLens('unknown'), 'structure');
      assert.strictEqual(suggestedLens(undefined), 'structure');
    },
  ],

  // --- robustness ---

  [
    'every lens returns empty collections for an empty spec',
    () => {
      LENSES.forEach((lens) => {
        assert.deepStrictEqual(encode(lens, {}), { nodes: {}, edges: {}, ghosts: [], keyItems: [] }, lens);
      });
    },
  ],

  [
    'missing arrays never throw and every node still gets an entry',
    () => {
      assert.deepStrictEqual(encode('risk', undefined), { nodes: {}, edges: {}, ghosts: [], keyItems: [] });
      const spec = { nodes: [{ id: 'a' }] };
      LENSES.forEach((lens) => {
        const encoding = encode(lens, spec);
        assert.deepStrictEqual(Object.keys(encoding.nodes), ['a'], lens);
        assert.deepStrictEqual(encoding.edges, {}, lens);
      });
    },
  ],
];

// The three real examples must encode cleanly under every lens.
const EXAMPLE_DIR = path.join(__dirname, '../examples');
fs.readdirSync(EXAMPLE_DIR)
  .filter((name) => fs.existsSync(path.join(EXAMPLE_DIR, name, 'architecture.json')))
  .forEach((name) => {
    cases.push([
      `example ${name} encodes every node and edge in every lens with tokens only`,
      () => {
        const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, name, 'architecture.json'), 'utf8'));
        const result = compileArchitecture(spec);
        const archMatch = result.html.match(/const ARCH_SPEC = (\{[\s\S]*?\});\n/);
        assert.ok(archMatch, 'embedded ARCH_SPEC was not found');
        const arch = JSON.parse(archMatch[1]);
        const nodeIds = arch.nodes.map((node) => node.id).sort();
        const edgeIds = arch.edges.map((edge) => edge.id).sort();
        LENSES.forEach((lens) => {
          const encoding = encode(lens, arch);
          assert.deepStrictEqual(Object.keys(encoding.nodes).sort(), nodeIds, `${lens} node coverage`);
          assert.deepStrictEqual(Object.keys(encoding.edges).sort(), edgeIds, `${lens} edge coverage`);
          Object.keys(encoding.nodes).forEach((id) => assertNodeTokens(encoding.nodes[id], `${name}:${lens}:node:${id}`));
          Object.keys(encoding.edges).forEach((id) => assertEdgeTokens(encoding.edges[id], `${name}:${lens}:edge:${id}`));
          encoding.keyItems.forEach((item) => assertKeyItemTokens(item, `${name}:${lens}:key:${item.id}`));
          assertNoOpacity(encoding, `${name}:${lens}`);
        });
      },
    ]);
  });

cases.push(['p8: lens badge text and tokens survive repeated lens switches', () => {
  const spec = { nodes: [
    { ...service('added'), delta: 'ADDED', details: { failureModes: [{ failure: 'Unavailable' }] } },
    { ...service('changed'), delta: 'CHANGED' },
    { ...service('removed'), delta: 'REMOVED' },
    service('unchanged'),
  ], edges: [{ id: 'new', source: 'added', target: 'changed', delta: 'ADDED' }] };
  const risk = encode('risk', spec);
  assert.strictEqual(risk.nodes.added.badge.text, '1 failure mode');
  assert.strictEqual(risk.nodes.added.stroke, 'warn');
  const before = encode('change', spec);
  assert.strictEqual(before.nodes.added.badge.text, 'Added');
  assert.strictEqual(before.nodes.changed.badge.text, 'Changed');
  assert.strictEqual(before.nodes.removed.badge.text, 'Removed');
  assert.strictEqual(before.nodes.unchanged.badge, null);
  assert.strictEqual(before.edges.new.stroke, 'ok');
  ['risk', 'evidence', 'structure', 'change'].forEach(lens => assertNoOpacity(encode(lens, spec), lens));
  assert.deepStrictEqual(encode('change', spec), before);
  assert.deepStrictEqual(encode('risk', spec), risk);
}]);

cases.push(['risk required edges resolve combined id type and boundary selectors', () => {
  const spec = { nodes: [{ ...service('a'), boundary: 'api' }, { ...service('b'), type: 'database', boundary: 'data' }, { ...service('c'), boundary: 'other' }],
    edges: [{ id: 'required', source: 'a', target: 'b' }, { id: 'other', source: 'c', target: 'b' }],
    policies: [{ id: 'p', kind: 'required_dependency', fromType: 'service', fromBoundary: 'api', toType: 'database', toBoundary: 'data' }] };
  assert.strictEqual(encode('risk', spec).edges.required.stroke, 'ok');
  assert.strictEqual(encode('risk', spec).edges.other.stroke, 'edge');
  spec.policies[0].from = 'c';
  assert.strictEqual(encode('risk', spec).edges.required.stroke, 'edge');
  assert.strictEqual(encode('risk', spec).edges.other.stroke, 'edge');
}]);

cases.push(['orthogonal lens marks sample distance along the routed polyline', () => {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/lens-canvas.js'), 'utf8'), ctx);
  const edge = { labelX: 99, labelY: 99, controls: null, polyline: [{ x: 0, y: 0 }, { x: 0, y: 80 }, { x: 20, y: 80 }] };
  assert.deepStrictEqual(host(ctx.lensEdgePoint(edge, 0.4)), { x: 0, y: 40 });
  assert.deepStrictEqual(host(ctx.lensEdgePoint(edge, 0.5)), { x: 0, y: 50 });
  assert.deepStrictEqual(host(ctx.lensEdgePoint(edge, 0.9)), { x: 10, y: 80 });
}]);

module.exports = { name: 'Lens engine', cases };
