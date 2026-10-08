const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compileArchitecture } = require('../src/engine/compiler.js');

const source = fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/trust.js'), 'utf8');
const ctx = { JSON, Object, Array, Set, String, Number, Math };
vm.createContext(ctx);
vm.runInContext(source, ctx);
const { nodeEvidence, trustSummary } = ctx;

// Objects built inside the vm realm have that realm's prototypes; rebuilding them in
// the host realm keeps the assertions about values, not realms.
function host(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseSpec(overrides) {
  return Object.assign(
    {
      meta: { grounding: 'illustrative' },
      nodes: [],
      evidence: [],
      policies: [],
      findings: [],
      review: {},
    },
    overrides || {}
  );
}

function evidenceRecord(id, nodeId, overrides) {
  return Object.assign(
    { id, nodeId, type: 'file', locator: `src/${id}.ts`, verification: 'verified' },
    overrides || {}
  );
}

const cases = [
  // --- nodeEvidence: matching and de-duplication ---

  [
    'nodeEvidence matches by nodeId and by evidenceIds, counting each record once',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED', evidenceIds: ['e2'] }],
        evidence: [
          evidenceRecord('e1', 'a'),
          evidenceRecord('e2', 'a', { type: 'table', locator: 'orders' }),
          evidenceRecord('e3', 'b'),
        ],
      });
      const result = host(nodeEvidence(spec, 'a'));
      assert.deepStrictEqual(result.records.map((record) => record.id), ['e1', 'e2']);
    },
  ],

  [
    'locators drop duplicate type plus path, keeping the first record',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [
          evidenceRecord('e1', 'a', { locator: 'src/x.ts' }),
          evidenceRecord('e2', 'a', { locator: 'src/x.ts', verification: 'stale' }),
          evidenceRecord('e3', 'a', { locator: 'src/y.ts' }),
        ],
      });
      const result = host(nodeEvidence(spec, 'a'));
      assert.strictEqual(result.locators.length, 2);
      assert.strictEqual(result.locators[0].id, 'e1');
      assert.strictEqual(result.locators[1].id, 'e3');
      assert.strictEqual(result.records.length, 3);
    },
  ],

  [
    'a string locator and an object locator with the same path collapse to one',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [
          evidenceRecord('e1', 'a', { locator: 'src/x.ts' }),
          evidenceRecord('e2', 'a', { locator: { path: 'src/x.ts' } }),
        ],
      });
      const result = host(nodeEvidence(spec, 'a'));
      assert.strictEqual(result.locators.length, 1);
      assert.strictEqual(result.locators[0].id, 'e1');
    },
  ],

  [
    'an api method plus path is its own locator key',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [
          evidenceRecord('e1', 'a', { type: 'api', locator: { method: 'GET', path: '/orders' } }),
          evidenceRecord('e2', 'a', { type: 'api', locator: { method: 'POST', path: '/orders' } }),
        ],
      });
      const result = host(nodeEvidence(spec, 'a'));
      assert.strictEqual(result.locators.length, 2);
    },
  ],

  // --- nodeEvidence: state precedence and every branch ---

  [
    'unresolved beats verified (one verified plus one unresolved is missing)',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [
          evidenceRecord('e1', 'a', { verification: 'verified' }),
          evidenceRecord('e2', 'a', { verification: 'unresolved' }),
        ],
      });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'missing');
      assert.strictEqual(result.label, 'Missing');
    },
  ],

  [
    'stale beats compatibility and verified',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a', { verification: 'stale' })],
      });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'stale');
      assert.strictEqual(result.label, 'Stale');
    },
  ],

  [
    'compatibility on a repository spec is declared, not checked',
    () => {
      const spec = baseSpec({
        meta: { grounding: 'repository' },
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a', { verification: 'compatibility' })],
      });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'declared-unchecked');
      assert.strictEqual(result.label, 'Declared, not checked');
    },
  ],

  [
    'compatibility on an illustrative spec is declared',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a', { verification: 'compatibility' })],
      });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'declared');
      assert.strictEqual(result.label, 'Declared');
    },
  ],

  [
    'asserted records name their author, or a reviewer by default',
    () => {
      const withAuthor = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a', { verification: 'asserted', author: 'Dana' })],
      });
      const withoutAuthor = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a', { verification: 'asserted' })],
      });
      assert.strictEqual(nodeEvidence(withAuthor, 'a').label, 'Asserted by Dana');
      assert.strictEqual(nodeEvidence(withoutAuthor, 'a').label, 'Asserted by a reviewer');
      assert.strictEqual(nodeEvidence(withAuthor, 'a').state, 'asserted');
    },
  ],

  [
    'an assertion-typed record is asserted even without an asserted verification',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a', { type: 'assertion', verification: undefined })],
      });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'asserted');
      assert.strictEqual(result.label, 'Asserted by a reviewer');
    },
  ],

  [
    'all verified records verify the node',
    () => {
      const spec = baseSpec({
        nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }],
        evidence: [evidenceRecord('e1', 'a'), evidenceRecord('e2', 'a')],
      });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'verified');
      assert.strictEqual(result.label, 'Verified');
    },
  ],

  [
    'an added node with no records is planned',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'a', status: 'INFERRED', delta: 'ADDED' }] });
      const result = nodeEvidence(spec, 'a');
      assert.strictEqual(result.state, 'planned');
      assert.strictEqual(result.label, 'Planned');
    },
  ],

  [
    'a recordless node takes its label from its status',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'inferred', status: 'INFERRED', delta: 'UNCHANGED' },
          { id: 'assumed', status: 'ASSUMED', delta: 'UNCHANGED' },
          { id: 'unknown', status: 'UNKNOWN', delta: 'UNCHANGED' },
          { id: 'other', status: 'VERIFIED', delta: 'UNCHANGED' },
        ],
      });
      assert.deepStrictEqual(host(nodeEvidence(spec, 'inferred')), {
        records: [],
        locators: [],
        state: 'unknown',
        label: 'Inferred',
      });
      assert.strictEqual(nodeEvidence(spec, 'assumed').label, 'Assumed');
      assert.strictEqual(nodeEvidence(spec, 'unknown').label, 'Unknown');
      assert.strictEqual(nodeEvidence(spec, 'other').label, 'Unknown');
    },
  ],

  [
    'a missing spec or node never throws',
    () => {
      assert.deepStrictEqual(host(nodeEvidence({}, 'nope')), {
        records: [],
        locators: [],
        state: 'unknown',
        label: 'Unknown',
      });
      assert.strictEqual(nodeEvidence(undefined, 'nope').records.length, 0);
    },
  ],

  // --- trustSummary: grounding ---

  [
    'grounding: illustrative is neutral with the sketch detail',
    () => {
      const entry = host(trustSummary(baseSpec(), []).grounding);
      assert.deepStrictEqual(entry, {
        state: 'neutral',
        label: 'Illustrative',
        detail: 'A design sketch: file paths are examples and were not checked.',
        chapter: 'evidence',
      });
    },
  ],

  [
    'grounding: repository with a commit is ok at the short sha',
    () => {
      const spec = baseSpec({ meta: { grounding: 'repository', groundedAt: 'abcdef1234567890' } });
      const entry = host(trustSummary(spec, []).grounding);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, 'Grounded at abcdef1');
    },
  ],

  [
    'grounding: repository with stale records is a warning',
    () => {
      const spec = baseSpec({
        meta: { grounding: 'repository', groundedAt: 'abcdef1234567890' },
        evidence: [
          evidenceRecord('e1', 'a', { verification: 'stale' }),
          evidenceRecord('e2', 'a', { verification: 'stale' }),
        ],
      });
      const entry = host(trustSummary(spec, []).grounding);
      assert.strictEqual(entry.state, 'warn');
      assert.strictEqual(entry.label, '2 stale since abcdef1');
    },
  ],

  [
    'grounding: repository without a commit is not grounded',
    () => {
      const spec = baseSpec({ meta: { grounding: 'repository' } });
      const entry = host(trustSummary(spec, []).grounding);
      assert.strictEqual(entry.state, 'unchecked');
      assert.strictEqual(entry.label, 'Not grounded');
    },
  ],

  // --- trustSummary: evidence ---

  [
    'evidence: an existing node whose claimed evidence did not resolve warns',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' },
          { id: 'b', status: 'INFERRED', delta: 'CHANGED', evidenceIds: ['ghost'] },
        ],
        evidence: [evidenceRecord('e1', 'a')],
      });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.state, 'warn');
      assert.strictEqual(entry.label, '1/2 backed · 1 missing evidence');
    },
  ],

  [
    'evidence: an inferred node that never claimed evidence is counted as inferred, not missing evidence',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'b', status: 'INFERRED', delta: 'CHANGED' }] });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.state, 'unchecked');
      assert.strictEqual(entry.label, '0/1 backed · 1 inferred');
    },
  ],

  [
    'evidence: a VERIFIED node with no records lacks evidence',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' }] });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.state, 'warn');
      assert.strictEqual(entry.label, '0/1 backed · 1 missing evidence');
    },
  ],

  [
    'evidence: actors are outside the count, since nothing in a repository can back them',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'user', type: 'actor', status: 'VERIFIED', delta: 'UNCHANGED' },
          { id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' },
        ],
        evidence: [evidenceRecord('e1', 'a')],
      });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, '1/1 verified');
    },
  ],

  [
    'evidence: every existing node verified is ok',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'a', status: 'VERIFIED', delta: 'UNCHANGED' },
          { id: 'b', status: 'VERIFIED', delta: 'CHANGED' },
        ],
        evidence: [evidenceRecord('e1', 'a'), evidenceRecord('e2', 'b')],
      });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, '2/2 verified');
    },
  ],

  [
    'evidence: declared but not verified is unchecked, with a planned suffix',
    () => {
      const spec = baseSpec({
        nodes: [
          { id: 'a', status: 'VERIFIED', delta: 'CHANGED' },
          { id: 'b', status: 'INFERRED', delta: 'ADDED' },
          { id: 'c', status: 'INFERRED', delta: 'ADDED' },
        ],
        evidence: [evidenceRecord('e1', 'a', { verification: 'compatibility' })],
      });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.state, 'unchecked');
      assert.strictEqual(entry.label, '1/1 backed · 2 planned');
    },
  ],

  [
    'evidence: an added node alone leaves no existing nodes behind',
    () => {
      const spec = baseSpec({ nodes: [{ id: 'a', status: 'INFERRED', delta: 'ADDED' }] });
      const entry = host(trustSummary(spec, []).evidence);
      assert.strictEqual(entry.label, '1 planned');
      assert.strictEqual(entry.state, 'unchecked', 'nothing existing to check is not a pass');
    },
  ],

  // --- trustSummary: rules ---

  [
    'rules: no policies is neutral',
    () => {
      const entry = host(trustSummary(baseSpec(), []).rules);
      assert.strictEqual(entry.state, 'neutral');
      assert.strictEqual(entry.label, 'No rules');
      assert.strictEqual(entry.chapter, 'review');
    },
  ],

  [
    'rules: matching policies pass',
    () => {
      const spec = baseSpec({ policies: [{ id: 'p1' }, { id: 'p2' }] });
      const entry = host(trustSummary(spec, []).rules);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, '2/2 rules pass');
    },
  ],

  [
    'rules: one violation reads in the singular',
    () => {
      const spec = baseSpec({ policies: [{ id: 'p1' }, { id: 'p2' }], findings: [{ policyId: 'p1' }] });
      const entry = host(trustSummary(spec, []).rules);
      assert.strictEqual(entry.state, 'risk');
      assert.strictEqual(entry.label, '1 violation of 2');
    },
  ],

  [
    'rules: distinct violations are counted once and unknown policies are ignored',
    () => {
      const spec = baseSpec({
        policies: [{ id: 'p1' }, { id: 'p2' }],
        findings: [{ policyId: 'p1' }, { policyId: 'p1' }, { policyId: 'p2' }, { policyId: 'ghost' }],
        review: { policyFindings: [{ policyId: 'p2' }] },
      });
      const entry = host(trustSummary(spec, []).rules);
      assert.strictEqual(entry.state, 'risk');
      assert.strictEqual(entry.label, '2 violations of 2');
    },
  ],

  // --- trustSummary: open items ---

  [
    'open items: questions warn, with singular and plural forms',
    () => {
      const one = baseSpec({
        nodes: [{ id: 'a', status: 'UNKNOWN', delta: 'UNCHANGED' }],
        review: { unresolvedQuestions: ['why?'] },
      });
      const two = baseSpec({ review: { unresolvedQuestions: ['why?', 'when?'] } });
      assert.strictEqual(host(trustSummary(one, []).openItems).label, '1 open question');
      assert.strictEqual(host(trustSummary(two, []).openItems).label, '2 open questions');
      assert.strictEqual(host(trustSummary(one, []).openItems).state, 'warn');
    },
  ],

  [
    'open items: questions and assumptions join in one label',
    () => {
      const spec = baseSpec({ review: { unresolvedQuestions: ['why?'], assumptions: ['a', 'b'] } });
      const entry = host(trustSummary(spec, []).openItems);
      assert.strictEqual(entry.state, 'warn');
      assert.strictEqual(entry.label, '1 open question · 2 assumptions');
    },
  ],

  [
    'open items: assumptions alone are neutral',
    () => {
      const one = baseSpec({ review: { assumptions: ['a'] } });
      const three = baseSpec({ review: { assumptions: ['a', 'b', 'c'] } });
      assert.strictEqual(host(trustSummary(one, []).openItems).label, '1 assumption');
      assert.strictEqual(host(trustSummary(three, []).openItems).label, '3 assumptions');
      assert.strictEqual(host(trustSummary(three, []).openItems).state, 'neutral');
    },
  ],

  [
    'open items: nothing open is ok',
    () => {
      const entry = host(trustSummary(baseSpec(), []).openItems);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, 'No open items');
    },
  ],

  [
    'open items: meta is the fallback when review lacks the arrays',
    () => {
      const spec = baseSpec({
        meta: { grounding: 'illustrative', unresolvedQuestions: ['why?'], assumptions: ['a'] },
        review: {},
      });
      const entry = host(trustSummary(spec, []).openItems);
      assert.strictEqual(entry.label, '1 open question · 1 assumption');
    },
  ],

  // --- trustSummary: gate ---

  [
    'gate: an empty gate was not run',
    () => {
      const entry = host(trustSummary(baseSpec(), []).gate);
      assert.deepStrictEqual(entry, { state: 'unchecked', label: 'Gate not run', detail: '', chapter: 'review' });
      assert.strictEqual(host(trustSummary(baseSpec(), undefined).gate).label, 'Gate not run');
    },
  ],

  [
    'gate: all passing is ok',
    () => {
      const gate = [
        { id: 1, name: 'One', status: 'PASS', detail: 'fine' },
        { id: 2, name: 'Two', status: 'PASS', detail: 'fine' },
      ];
      const entry = host(trustSummary(baseSpec(), gate).gate);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, '2 of 2 pass');
      assert.strictEqual(entry.detail, 'Every quality check passes.');
    },
  ],

  [
    'gate: skips are appended and their details are collected',
    () => {
      const gate = [
        { id: 1, name: 'One', status: 'PASS', detail: 'fine' },
        { id: 2, name: 'Two', status: 'SKIP', detail: 'not applicable' },
      ];
      const entry = host(trustSummary(baseSpec(), gate).gate);
      assert.strictEqual(entry.state, 'ok');
      assert.strictEqual(entry.label, '1 of 2 pass · 1 skipped');
      assert.strictEqual(entry.detail, 'Skipped: Two.');
    },
  ],

  [
    'gate: warnings singular and plural, with details joined in order',
    () => {
      const one = [
        { id: 1, name: 'One', status: 'PASS', detail: 'fine' },
        { id: 2, name: 'Two', status: 'WARN', detail: 'soft' },
        { id: 3, name: 'Three', status: 'SKIP', detail: 'n/a' },
      ];
      const entry = host(trustSummary(baseSpec(), one).gate);
      assert.strictEqual(entry.state, 'warn');
      assert.strictEqual(entry.label, '1 of 3 pass · 1 skipped · 1 warning');
      assert.strictEqual(entry.detail, 'Needs attention: Two. Skipped: Three.');

      const two = [
        { id: 1, name: 'One', status: 'PASS', detail: 'fine' },
        { id: 2, name: 'Two', status: 'WARN', detail: 'soft' },
        { id: 3, name: 'Three', status: 'WARN', detail: 'softer' },
      ];
      assert.strictEqual(host(trustSummary(baseSpec(), two).gate).label, '1 of 3 pass · 2 warnings');
    },
  ],

  [
    'gate: a failure dominates and is reported',
    () => {
      const gate = [
        { id: 1, name: 'One', status: 'PASS', detail: 'fine' },
        { id: 2, name: 'Two', status: 'WARN', detail: 'soft' },
        { id: 3, name: 'Three', status: 'FAIL', detail: 'broken' },
      ];
      const entry = host(trustSummary(baseSpec(), gate).gate);
      assert.strictEqual(entry.state, 'risk');
      assert.strictEqual(entry.label, '1 of 3 pass · 1 warning · 1 failed');
      assert.strictEqual(entry.detail, 'Failing: Three. Needs attention: Two.');
    },
  ],

  // --- empty spec ---

  [
    'an empty spec yields defaults without throwing',
    () => {
      const summary = host(trustSummary({}, []));
      assert.deepStrictEqual(Object.keys(summary), ['grounding', 'evidence', 'rules', 'openItems', 'gate']);
      assert.strictEqual(summary.grounding.state, 'unchecked');
      assert.strictEqual(summary.evidence.state, 'unchecked', 'an empty model must not read as verified');
      assert.strictEqual(summary.evidence.label, 'No components');
      assert.strictEqual(summary.rules.state, 'neutral');
      assert.strictEqual(summary.openItems.state, 'ok');
      assert.strictEqual(summary.gate.state, 'unchecked');
      assert.deepStrictEqual(host(trustSummary(undefined, undefined)).openItems.label, 'No open items');
    },
  ],
];

// The three real examples must read the same without any rendering.
const EXAMPLE_DIR = path.join(__dirname, '../examples');
const EXAMPLE_EVIDENCE = {
  '1-crud-business-feature': '5/5 backed · 2 planned',
  '2-complex-database-migration': '2/2 backed · 5 planned',
  '3-async-event-driven-workflow': '6/6 backed · 4 planned',
};
fs.readdirSync(EXAMPLE_DIR)
  .filter((name) => fs.existsSync(path.join(EXAMPLE_DIR, name, 'architecture.json')))
  .forEach((name) => {
    cases.push([
      `example ${name} summarises to the expected trust strip`,
      () => {
        const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, name, 'architecture.json'), 'utf8'));
        const result = compileArchitecture(spec);
        const archMatch = result.html.match(/const ARCH_SPEC = (\{[\s\S]*?\});\n/);
        const gateMatch = result.html.match(/const QUALITY_GATE = (\[[\s\S]*?\]);\n/);
        assert.ok(archMatch, 'embedded ARCH_SPEC was not found');
        assert.ok(gateMatch, 'embedded QUALITY_GATE was not found');
        const summary = host(trustSummary(JSON.parse(archMatch[1]), JSON.parse(gateMatch[1])));
        assert.strictEqual(summary.grounding.label, 'Illustrative');
        assert.strictEqual(summary.grounding.state, 'neutral');
        assert.strictEqual(summary.rules.state, 'ok');
        assert.strictEqual(summary.openItems.label, '3 assumptions');
        assert.strictEqual(summary.openItems.state, 'neutral');
        assert.strictEqual(summary.gate.label, '13 of 14 pass · 1 skipped');
        assert.strictEqual(summary.evidence.state, 'unchecked');
        assert.strictEqual(summary.evidence.label, EXAMPLE_EVIDENCE[name], 'actors are left out; every other existing component cites declared evidence');
      },
    ]);
  });

module.exports = { name: 'Trust model', cases };
