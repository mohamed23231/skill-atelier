const assert = require('node:assert');
const { validateArchitecture } = require('../src/engine/validator.js');
const { VALID_SPEC, VERSION_2_SPEC, clone } = require('./fixtures.js');

const cases = [
  [
    'rejects a non-object spec',
    () => {
      const res = validateArchitecture(null);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.length > 0);
    },
  ],

  [
    'flags missing meta and nodes',
    () => {
      const res = validateArchitecture({});
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('meta')));
      assert.ok(res.errors.some((e) => e.includes('nodes')));
    },
  ],

  [
    'flags an edge pointing at a missing node',
    () => {
      const res = validateArchitecture({
        meta: { title: 'T', description: 'D' },
        nodes: [{ id: 'a', label: 'A', type: 'service' }],
        edges: [{ id: 'e1', source: 'a', target: 'ghost', label: 'HTTP' }],
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('ghost')));
    },
  ],

  [
    'detects a boundary parent cycle',
    () => {
      const res = validateArchitecture({
        meta: { title: 'T', description: 'D' },
        boundaries: [
          { id: 'b1', label: 'B1', parent: 'b2' },
          { id: 'b2', label: 'B2', parent: 'b1' },
        ],
        nodes: [{ id: 'n1', label: 'N1', boundary: 'b1', type: 'service' }],
      });
      assert.ok(res.errors.some((e) => e.includes('Cycle detected')));
    },
  ],

  [
    'accepts a clean spec with zero warnings',
    () => {
      const res = validateArchitecture(clone(VALID_SPEC));
      assert.strictEqual(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
      assert.deepStrictEqual(res.warnings, [], `unexpected warnings: ${res.warnings.join(' | ')}`);
      assert.strictEqual(res.stats.totalNodes, 2);
      assert.strictEqual(res.stats.totalEdges, 1);
    },
  ],

  [
    'returns all 14 gate checks',
    () => {
      const res = validateArchitecture(clone(VALID_SPEC));
      assert.strictEqual(res.gate.length, 14);
      assert.deepStrictEqual(
        res.gate.map((g) => g.id),
        Array.from({ length: 14 }, (_, i) => i + 1)
      );
      assert.ok(res.gate.every((g) => ['PASS', 'WARN', 'SKIP'].includes(g.status)));
    },
  ],

  [
    'gate 13 skips disk checks for illustrative specs',
    () => {
      const res = validateArchitecture(clone(VALID_SPEC));
      const grounding = res.gate.find((g) => g.id === 13);
      assert.strictEqual(grounding.status, 'SKIP');
      assert.strictEqual(res.stats.grounding, 'illustrative');
    },
  ],

  [
    'gate 13 warns when a VERIFIED file is absent from disk',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.nodes[0].details.files = ['src/does/not/exist.ts'];
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      assert.strictEqual(res.gate.find((g) => g.id === 13).status, 'WARN');
      assert.strictEqual(res.stats.missingFileCount, 1);
    },
  ],

  [
    'gate 14 warns when a changed component has no task',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.views.implementation_plan;
      delete spec.nodes[0].details.tasks;
      const res = validateArchitecture(spec);
      const traceability = res.gate.find((g) => g.id === 14);
      assert.strictEqual(traceability.status, 'WARN');
      assert.ok(traceability.detail.includes('api'));
    },
  ],

  [
    'gate 6 warns on labels that would be truncated',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes[0].label = 'An Extremely Long Component Label That Cannot Fit';
      const res = validateArchitecture(spec);
      assert.strictEqual(res.gate.find((g) => g.id === 6).status, 'WARN');
    },
  ],

  [
    'warns when a sequence step has no backing edge',
    () => {
      const spec = clone(VALID_SPEC);
      spec.views.sequence.steps.push({ step: 2, from: 'db', to: 'api', label: 'Return id' });
      spec.views.sequence.steps.push({ step: 3, from: 'api', to: 'api', label: 'Self call' });
      const res = validateArchitecture(spec);
      assert.ok(res.warnings.some((w) => w.includes('no matching edge')));
    },
  ],

  [
    'warns on an isolated non-actor node',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes.push({ id: 'orphan', label: 'Orphan', boundary: 'data_tier', type: 'cache', description: 'x' });
      const res = validateArchitecture(spec);
      assert.strictEqual(res.gate.find((g) => g.id === 3).status, 'WARN');
    },
  ],

  [
    'rejects an unknown pathType',
    () => {
      const spec = clone(VALID_SPEC);
      spec.edges[0].pathType = 'teleport';
      const res = validateArchitecture(spec);
      assert.ok(res.warnings.some((w) => w.includes('teleport')));
    },
  ],

  [
    'treats a missing schema version as legacy and emits a version 2 model',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const spec = clone(VALID_SPEC);
      const model = normalizeArchitecture(spec);
      assert.strictEqual(model.schemaVersion, 2);
      assert.strictEqual(model.compatibility.sourceSchemaVersion, 1);
      assert.deepStrictEqual(model.meta, spec.meta);
      assert.deepStrictEqual(model.boundaries, spec.boundaries);
      assert.deepStrictEqual(model.edges, spec.edges);
      assert.deepStrictEqual(model.views.sequence, spec.views.sequence);
      assert.strictEqual(validateArchitecture(spec).model.schemaVersion, 2);
    },
  ],

  [
    'does not mutate caller-owned input while normalizing or validating',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const spec = clone(VALID_SPEC);
      const before = JSON.stringify(spec);
      normalizeArchitecture(spec);
      validateArchitecture(spec);
      assert.strictEqual(JSON.stringify(spec), before);
    },
  ],

  [
    'accepts authored version 2 evidence, policies, and scenarios',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const spec = clone(VERSION_2_SPEC);
      const model = normalizeArchitecture(spec);
      assert.strictEqual(model.schemaVersion, 2);
      assert.strictEqual(model.compatibility.sourceSchemaVersion, 2);
      assert.deepStrictEqual(
        model.evidence.map((e) => e.id),
        ['ev_api_file', 'ev_db_table']
      );
      assert.deepStrictEqual(
        model.scenarios.map((s) => s.id),
        ['place_order']
      );
      const res = validateArchitecture(spec);
      assert.strictEqual(res.valid, true);
      assert.deepStrictEqual(res.errors, []);
    },
  ],

  [
    'normalization is deterministic for identical input',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const spec = clone(VALID_SPEC);
      assert.deepStrictEqual(normalizeArchitecture(spec), normalizeArchitecture(spec));
    },
  ],

  [
    'starter spec is version 2 and still ships a legacy compatibility example',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const { STARTER_SPEC, LEGACY_COMPAT_SPEC } = require('../src/utils/starter-spec.js');
      assert.strictEqual(STARTER_SPEC.schemaVersion, 2);
      assert.ok(Array.isArray(STARTER_SPEC.evidence));
      assert.ok(Array.isArray(STARTER_SPEC.policies));
      assert.ok(Array.isArray(STARTER_SPEC.scenarios));
      assert.ok(!Object.prototype.hasOwnProperty.call(LEGACY_COMPAT_SPEC, 'schemaVersion'));
      const model = normalizeArchitecture(LEGACY_COMPAT_SPEC);
      assert.strictEqual(model.schemaVersion, 2);
      assert.strictEqual(model.compatibility.sourceSchemaVersion, 1);
      const res = validateArchitecture(clone(STARTER_SPEC));
      assert.strictEqual(res.valid, true);
      assert.deepStrictEqual(res.warnings, [], `unexpected warnings: ${res.warnings.join(' | ')}`);
    },
  ],

  [
    'normalizes legacy files, apis, and tables into compatibility evidence',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const spec = clone(VALID_SPEC);
      spec.nodes[0].details.apis = [{ method: 'POST', path: '/orders', desc: 'Create order' }];
      const before = JSON.stringify(spec);
      const model = normalizeArchitecture(spec);
      assert.strictEqual(JSON.stringify(spec), before);
      const fileEvidence = model.evidence.find((e) => e.type === 'file' && e.locator.path === 'src/api/Api.ts');
      const apiEvidence = model.evidence.find((e) => e.type === 'api' && e.locator.path === '/orders');
      const tableEvidence = model.evidence.find((e) => e.type === 'table' && e.locator.table === 'orders');
      assert.ok(fileEvidence, 'file locators must become evidence');
      assert.ok(apiEvidence, 'api locators must become evidence');
      assert.ok(tableEvidence, 'table locators must become evidence');
      assert.strictEqual(fileEvidence.verification, 'compatibility');
      assert.strictEqual(apiEvidence.verification, 'compatibility');
      assert.strictEqual(tableEvidence.verification, 'compatibility');
      assert.ok(model.nodes[0].evidenceIds.includes(fileEvidence.id));
      assert.ok(model.nodes[0].evidenceIds.includes(apiEvidence.id));
      assert.ok(model.nodes[1].evidenceIds.includes(tableEvidence.id));
      assert.deepStrictEqual(spec.nodes[0].details.files, ['src/api/Api.ts']);
    },
  ],

  [
    'does not duplicate authored evidence when lifting legacy locators',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const model = normalizeArchitecture(clone(VERSION_2_SPEC));
      const fileRecords = model.evidence.filter((e) => e.type === 'file' && e.locator.path === 'src/api/Api.ts');
      const tableRecords = model.evidence.filter((e) => e.type === 'table' && e.locator.table === 'orders');
      assert.strictEqual(fileRecords.length, 1);
      assert.strictEqual(tableRecords.length, 1);
      assert.deepStrictEqual(
        model.evidence.map((e) => e.id),
        ['ev_api_file', 'ev_db_table']
      );
    },
  ],

  [
    'records a finding when a VERIFIED claim has no resolvable evidence under repository grounding',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      delete spec.nodes[0].details.files;
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      assert.ok(Array.isArray(res.findings));
      assert.ok(
        res.findings.some((f) => f.nodeIds.includes('api') && /VERIFIED/i.test(f.message)),
        `expected a VERIFIED evidence finding, got: ${JSON.stringify(res.findings)}`
      );
      assert.strictEqual(res.gate.find((g) => g.id === 12).status, 'WARN');
    },
  ],

  [
    'keeps missing file locators visible as unresolved evidence',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.nodes[0].details.files = ['src/does/not/exist.ts'];
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      const record = res.model.evidence.find((e) => e.locator && e.locator.path === 'src/does/not/exist.ts');
      assert.ok(record);
      assert.strictEqual(record.verification, 'unresolved');
      assert.ok(res.findings.some((f) => (f.evidenceIds || []).includes(record.id)));
      assert.strictEqual(res.stats.missingFileCount, 1);
      assert.strictEqual(res.gate.find((g) => g.id === 13).status, 'WARN');
    },
  ],

  [
    'marks line ranges that fall outside the inspected file as stale',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.schemaVersion = 2;
      spec.evidence = [
        {
          id: 'ev_stale_lines',
          type: 'file',
          locator: { path: 'fixtures.js', startLine: 99999, endLine: 100000 },
          verification: 'verified',
        },
      ];
      spec.nodes[0].details.files = ['fixtures.js'];
      spec.nodes[0].evidenceIds = ['ev_stale_lines'];
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      const record = res.model.evidence.find((e) => e.id === 'ev_stale_lines');
      assert.strictEqual(record.verification, 'stale');
      assert.ok(res.findings.some((f) => (f.evidenceIds || []).includes('ev_stale_lines') && /stale/i.test(f.message)));
    },
  ],

  [
    'does not mark a symbol verified unless the file was inspected',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.schemaVersion = 2;
      spec.evidence = [
        {
          id: 'ev_symbol_uninspected',
          type: 'symbol',
          locator: { path: 'fixtures.js', symbol: 'VALID_SPEC' },
          verification: 'verified',
        },
      ];
      spec.nodes[0].details.files = ['fixtures.js'];
      spec.nodes[0].evidenceIds = ['ev_symbol_uninspected'];
      const skipped = validateArchitecture(spec, { repoRoot: __dirname, verifyFiles: false });
      const skippedRecord = skipped.model.evidence.find((e) => e.id === 'ev_symbol_uninspected');
      assert.notStrictEqual(skippedRecord.verification, 'verified');
      assert.ok(skippedRecord.symbolFound === undefined);
    },
  ],

  [
    'verifies a symbol only after inspecting file contents',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.schemaVersion = 2;
      spec.evidence = [
        {
          id: 'ev_symbol_found',
          type: 'symbol',
          locator: { path: 'fixtures.js', symbol: 'VALID_SPEC' },
        },
        {
          id: 'ev_symbol_missing',
          type: 'symbol',
          locator: { path: 'fixtures.js', symbol: 'NotARealSymbol_XYZ' },
        },
      ];
      spec.nodes[0].details.files = ['fixtures.js'];
      spec.nodes[0].evidenceIds = ['ev_symbol_found', 'ev_symbol_missing'];
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      const found = res.model.evidence.find((e) => e.id === 'ev_symbol_found');
      const missing = res.model.evidence.find((e) => e.id === 'ev_symbol_missing');
      assert.strictEqual(found.verification, 'verified');
      assert.strictEqual(found.symbolFound, true);
      assert.strictEqual(missing.verification, 'stale');
      assert.strictEqual(missing.symbolFound, false);
    },
  ],

  [
    'keeps human assertions distinct from repository verification',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.schemaVersion = 2;
      spec.evidence = [
        {
          id: 'ev_human',
          type: 'assertion',
          locator: { assertion: 'Orders API owns writes' },
        },
      ];
      spec.nodes[0].details.files = ['fixtures.js'];
      spec.nodes[0].evidenceIds = ['ev_human'];
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      const record = res.model.evidence.find((e) => e.id === 'ev_human');
      assert.strictEqual(record.verification, 'asserted');
      assert.ok(record.symbolFound === undefined);
    },
  ],

  [
    'treats first-class evidence as sufficient for a VERIFIED claim',
    () => {
      const spec = clone(VALID_SPEC);
      delete spec.meta.grounding;
      spec.schemaVersion = 2;
      spec.nodes[0].details = { tasks: spec.nodes[0].details.tasks };
      spec.evidence = [
        {
          id: 'ev_first_class',
          type: 'file',
          locator: { path: 'fixtures.js' },
        },
      ];
      spec.nodes[0].evidenceIds = ['ev_first_class'];
      const res = validateArchitecture(spec, { repoRoot: __dirname });
      assert.strictEqual(res.gate.find((g) => g.id === 12).status, 'PASS');
      assert.ok(!res.findings.some((f) => f.nodeIds.includes('api') && /no resolvable evidence/i.test(f.message)));
    },
  ],

  [
    'inspects file locators without inventing symbols or line ranges',
    () => {
      const { RepoInspector } = require('../src/utils/repo-inspector.js');
      const inspector = new RepoInspector(__dirname);
      const result = inspector.inspectEvidence({
        id: 'ev_inspect',
        type: 'file',
        locator: { path: 'fixtures.js' },
      });
      assert.strictEqual(result.verification, 'verified');
      assert.strictEqual(result.exists, true);
      assert.ok(!Object.prototype.hasOwnProperty.call(result.locator, 'symbol'));
      assert.ok(!Object.prototype.hasOwnProperty.call(result.locator, 'startLine'));
      assert.ok(!Object.prototype.hasOwnProperty.call(result.locator, 'endLine'));
    },
  ],

  [
    'normalizes a legacy sequence into one named linear scenario',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const spec = clone(VALID_SPEC);
      const model = normalizeArchitecture(spec);
      assert.strictEqual(model.views.sequence.steps.length, 1);
      assert.strictEqual(model.scenarios.length, 1);
      assert.strictEqual(model.scenarios[0].origin, 'legacy-sequence');
      assert.strictEqual(model.scenarios[0].stages.length, 1);
      assert.strictEqual(model.scenarios[0].stages[0].kind, 'interaction');
      assert.strictEqual(model.scenarios[0].stages[0].interactions[0].from, 'api');
      assert.strictEqual(model.scenarios[0].stages[0].interactions[0].to, 'db');
      assert.strictEqual(model.scenarios[0].stages[0].interactions[0].edgeId, 'e1');
      assert.deepStrictEqual(spec.views.sequence.steps, clone(VALID_SPEC).views.sequence.steps);
    },
  ],

  [
    'preserves authored scenarios instead of duplicating the legacy sequence',
    () => {
      const { normalizeArchitecture } = require('../src/engine/validator.js');
      const model = normalizeArchitecture(clone(VERSION_2_SPEC));
      assert.deepStrictEqual(
        model.scenarios.map((scenario) => scenario.id),
        ['place_order']
      );
      assert.ok(model.views.sequence.steps.length > 0);
    },
  ],

  [
    'accepts parallel stages, branches, payloads, and recovery fields',
    () => {
      const spec = clone(VALID_SPEC);
      spec.schemaVersion = 2;
      spec.scenarios = [
        {
          id: 'checkout',
          name: 'Checkout',
          stages: [
            {
              id: 'stage_serial',
              kind: 'interaction',
              interactions: [{ id: 'i1', from: 'api', to: 'db', edgeId: 'e1', payload: { action: 'insert' } }],
            },
            {
              id: 'stage_parallel',
              kind: 'parallel',
              interactions: [
                { id: 'i2', from: 'api', to: 'db', edgeId: 'e1', metadata: { topic: 'orders' } },
                { id: 'i3', from: 'api', to: 'db', edgeId: 'e1', expectedState: 'row written' },
              ],
            },
            {
              id: 'stage_branch',
              kind: 'branch',
              branches: [
                {
                  id: 'ok',
                  condition: 'write succeeded',
                  stages: [
                    {
                      id: 'ok_done',
                      kind: 'interaction',
                      interactions: [{ id: 'i4', from: 'api', to: 'db', edgeId: 'e1', status: 'completed' }],
                    },
                  ],
                },
                {
                  id: 'fail',
                  condition: 'write failed',
                  stages: [
                    {
                      id: 'recover',
                      kind: 'interaction',
                      interactions: [
                        {
                          id: 'i5',
                          from: 'api',
                          to: 'db',
                          edgeId: 'e1',
                          failureState: 'insert rejected',
                          recovery: 'retry with backoff',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
      const res = validateArchitecture(spec);
      assert.strictEqual(res.valid, true);
      const scenario = res.model.scenarios[0];
      assert.strictEqual(scenario.stages[1].kind, 'parallel');
      assert.strictEqual(scenario.stages[1].interactions.length, 2);
      assert.strictEqual(scenario.stages[2].kind, 'branch');
      assert.strictEqual(scenario.stages[2].branches[1].condition, 'write failed');
      assert.strictEqual(scenario.stages[0].interactions[0].payload.action, 'insert');
      assert.strictEqual(scenario.stages[2].branches[1].stages[0].interactions[0].recovery, 'retry with backoff');
    },
  ],

  [
    'records a forbidden dependency finding with stable structure',
    () => {
      const spec = clone(VALID_SPEC);
      spec.policies = [{ id: 'no-api-db', kind: 'forbidden_dependency', from: 'api', to: 'db' }];
      const res = validateArchitecture(spec);
      const finding = res.findings.find((f) => f.policyId === 'no-api-db');
      assert.ok(finding);
      assert.strictEqual(finding.severity, 'warn');
      assert.ok(finding.id);
      assert.ok(finding.message);
      assert.deepStrictEqual(finding.nodeIds, ['api', 'db']);
      assert.deepStrictEqual(finding.edgeIds, ['e1']);
      assert.deepStrictEqual(finding.evidenceIds, []);
      const again = validateArchitecture(spec);
      assert.deepStrictEqual(
        finding,
        again.findings.find((f) => f.policyId === 'no-api-db')
      );
    },
  ],

  [
    'records a required dependency finding when the edge is missing',
    () => {
      const spec = clone(VALID_SPEC);
      spec.policies = [{ id: 'db-to-api', kind: 'required_dependency', from: 'db', to: 'api' }];
      const res = validateArchitecture(spec);
      const finding = res.findings.find((f) => f.policyId === 'db-to-api');
      assert.ok(finding);
      assert.ok(finding.nodeIds.includes('db'));
      assert.ok(finding.nodeIds.includes('api'));
    },
  ],

  [
    'records a layer-direction finding for a backward edge',
    () => {
      const spec = clone(VALID_SPEC);
      spec.policies = [{ id: 'layers', kind: 'layer_direction', layers: ['data_tier', 'edge_tier'] }];
      const res = validateArchitecture(spec);
      const finding = res.findings.find((f) => f.policyId === 'layers');
      assert.ok(finding);
      assert.ok(finding.edgeIds.includes('e1'));
    },
  ],

  [
    'records a cycle finding with the involved nodes and edges',
    () => {
      const spec = clone(VALID_SPEC);
      spec.edges.push({ id: 'e2', source: 'db', target: 'api', label: 'callback', communication: 'async', pathType: 'event' });
      spec.policies = [{ id: 'no-cycles', kind: 'cycle' }];
      const res = validateArchitecture(spec);
      const finding = res.findings.find((f) => f.policyId === 'no-cycles');
      assert.ok(finding);
      assert.ok(finding.nodeIds.includes('api'));
      assert.ok(finding.nodeIds.includes('db'));
      assert.ok(finding.edgeIds.includes('e1'));
      assert.ok(finding.edgeIds.includes('e2'));
    },
  ],

  [
    'records evidence, fan-in, and fan-out policy findings',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes[1].status = 'VERIFIED';
      spec.policies = [
        { id: 'need-files', kind: 'required_evidence', status: 'VERIFIED', evidenceTypes: ['file'] },
        { id: 'max-out', kind: 'fan_out', max: 0 },
        { id: 'max-in', kind: 'fan_in', max: 0 },
      ];
      const res = validateArchitecture(spec);
      assert.ok(res.findings.some((f) => f.policyId === 'need-files' && f.nodeIds.includes('db')));
      assert.ok(res.findings.some((f) => f.policyId === 'max-out' && f.nodeIds.includes('api')));
      assert.ok(res.findings.some((f) => f.policyId === 'max-in' && f.nodeIds.includes('db')));
    },
  ],

  [
    'warns clearly on an unknown policy kind instead of ignoring it',
    () => {
      const spec = clone(VALID_SPEC);
      spec.policies = [{ id: 'weird', kind: 'teleport_ban' }];
      const res = validateArchitecture(spec);
      assert.ok(res.warnings.some((w) => /unknown policy kind/i.test(w) && w.includes('teleport_ban')));
      assert.ok(res.findings.some((f) => f.policyId === 'weird' && /unknown policy kind/i.test(f.message)));
    },
  ],

  [
    'derives blast radius, assumptions, questions, evidence, and traceability',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes.push({
        id: 'cache',
        label: 'Cache',
        boundary: 'data_tier',
        type: 'cache',
        status: 'UNKNOWN',
        delta: 'ADDED',
        description: 'Where should session state live?',
      });
      spec.edges.push({ id: 'e2', source: 'api', target: 'cache', label: 'cache write', communication: 'sync', pathType: 'write' });
      spec.meta.unresolvedQuestions = ['Who owns cache eviction?'];
      const res = validateArchitecture(spec);
      assert.ok(res.review);
      assert.deepStrictEqual(
        res.review.changedComponents.map((entry) => entry.id),
        ['api', 'cache']
      );
      const apiBlast = res.review.blastRadius.find((entry) => entry.nodeId === 'api');
      assert.deepStrictEqual(apiBlast.downstream.sort(), ['cache', 'db']);
      assert.deepStrictEqual(apiBlast.upstream, []);
      assert.ok(res.review.assumptions.some((entry) => entry.text === 'Single region deployment'));
      assert.ok(res.review.unresolvedQuestions.some((entry) => entry.text === 'Who owns cache eviction?'));
      assert.ok(res.review.unresolvedQuestions.some((entry) => entry.nodeId === 'cache'));
      assert.ok(res.review.evidenceManifest.some((entry) => entry.type === 'file'));
      assert.ok(res.review.traceability.changed.includes('api'));
      assert.ok(res.review.traceability.mapped.includes('api'));
      assert.ok(res.review.traceability.gaps.includes('cache'));
      assert.deepStrictEqual(res.review, validateArchitecture(spec).review);
    },
  ],
];

module.exports = { name: 'Validator', cases };
