const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { compileArchitecture, generateMarkdownReport } = require('../src/engine/compiler.js');
const { validateArchitecture } = require('../src/engine/validator.js');
const { exportToMermaid } = require('../src/utils/mermaid-exporter.js');
const { VALID_SPEC, clone } = require('./fixtures.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-test-'));
}

const cases = [
  [
    'inlines spec, layout, mermaid, markdown and gate data',
    () => {
      const result = compileArchitecture(clone(VALID_SPEC));
      assert.ok(!/__[A-Z_]+__/.test(result.html), 'no placeholder may survive compilation');
      assert.ok(result.html.includes('Orders DB'));
      assert.ok(result.html.includes('MARKDOWN_REPORT'));
      assert.ok(result.html.includes('QUALITY_GATE'));
    },
  ],

  [
    'writes both output files',
    () => {
      const dir = tmpDir();
      const htmlPath = path.join(dir, 'nested', 'out.html');
      const mdPath = path.join(dir, 'nested', 'out.md');
      compileArchitecture(clone(VALID_SPEC), { outputHtml: htmlPath, outputMarkdown: mdPath });
      assert.ok(fs.existsSync(htmlPath));
      assert.ok(fs.existsSync(mdPath));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'neutralizes a </script> breakout in spec content',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes[0].description = '</script><img src=x onerror=alert(1)>';
      const result = compileArchitecture(spec);
      assert.ok(!result.html.includes('</script><img'), 'raw breakout must not reach the document');
      assert.ok(result.html.includes('\\u003c/script\\u003e'), 'angle brackets are unicode-escaped');
    },
  ],

  [
    'does not let $ sequences corrupt the embedded JSON',
    () => {
      const spec = clone(VALID_SPEC);
      spec.meta.description = "price $& and $' and $`";
      const result = compileArchitecture(spec);
      assert.ok(result.html.includes("price $& and $' and $`"));
    },
  ],

  [
    'strict mode rejects a spec with quality warnings',
    () => {
      const spec = clone(VALID_SPEC);
      spec.edges[0].label = undefined;
      assert.throws(() => compileArchitecture(spec, { strict: true }), /Strict mode/);
    },
  ],

  [
    'non-strict mode still refuses structurally invalid specs',
    () => {
      assert.throws(() => compileArchitecture({ meta: { title: 'x' } }), /validation failed/);
    },
  ],

  [
    'markdown report carries gate table and all mermaid views',
    () => {
      const spec = clone(VALID_SPEC);
      const validation = validateArchitecture(spec);
      const markdown = generateMarkdownReport(spec, validation, exportToMermaid(spec));
      assert.ok(markdown.includes('## 6. Quality Gate'));
      assert.ok(markdown.includes('| 14 | Implementation traceability'));
      assert.ok(markdown.includes('```mermaid'));
      assert.ok(markdown.includes('sequenceDiagram'));
    },
  ],

  [
    'mermaid export keeps shapes, async arrows and delta classes',
    () => {
      const mermaid = exportToMermaid(clone(VALID_SPEC));
      assert.ok(mermaid.flowchart.startsWith('flowchart LR'));
      assert.ok(mermaid.flowchart.includes('db[("Orders DB'), 'database renders as a cylinder');
      assert.ok(mermaid.flowchart.includes('classDef changed'));
      assert.ok(mermaid.flowchart.includes('class api changed;'));
    },
  ],

  [
    'mermaid honours TB direction',
    () => {
      const mermaid = exportToMermaid(clone(VALID_SPEC), { direction: 'TB' });
      assert.ok(mermaid.flowchart.startsWith('flowchart TB'));
    },
  ],

  [
    'async edges export as dashed mermaid arrows',
    () => {
      const spec = clone(VALID_SPEC);
      spec.edges[0].communication = 'async';
      const mermaid = exportToMermaid(spec);
      assert.ok(mermaid.flowchart.includes('-.->'));
    },
  ],

  [
    'renders failureModes authored as plain strings without printing undefined',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes[0].details = spec.nodes[0].details || {};
      spec.nodes[0].details.failureModes = ['Empty hint falls back silently'];
      const md = generateMarkdownReport(spec, validateArchitecture(spec, { repoRoot: process.cwd() }), exportToMermaid(spec));
      assert.ok(md.includes('Empty hint falls back silently'));
      assert.ok(!md.includes('undefined'), 'string failure modes must not render undefined');
    },
  ],

  [
    'keeps impact and mitigation when failureModes are objects',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes[0].details = spec.nodes[0].details || {};
      spec.nodes[0].details.failureModes = [{ failure: 'Queue backs up', impact: 'Orders stall', mitigation: 'Add a DLQ' }];
      const md = generateMarkdownReport(spec, validateArchitecture(spec, { repoRoot: process.cwd() }), exportToMermaid(spec));
      assert.ok(md.includes('**Queue backs up**'));
      assert.ok(md.includes('Impact: *Orders stall*'));
      assert.ok(md.includes('Mitigation: Add a DLQ'));
    },
  ],

  [
    'rejects a failureMode object with no failure text',
    () => {
      const spec = clone(VALID_SPEC);
      spec.nodes[0].details = spec.nodes[0].details || {};
      spec.nodes[0].details.failureModes = [{ impact: 'Orders stall' }];
      const result = validateArchitecture(spec, { repoRoot: process.cwd() });
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('failureModes[0]')));
    },
  ],

  [
    'embeds normalized review data in the architecture payload',
    () => {
      const result = compileArchitecture(clone(VALID_SPEC));
      assert.ok(result.html.includes('"schemaVersion": 2'));
      assert.ok(result.html.includes('"blastRadius"'));
      assert.ok(result.html.includes('"evidenceManifest"'));
      assert.ok(result.html.includes('"traceability"'));
      assert.ok(result.html.includes('Orders DB'));
    },
  ],

  [
    'markdown includes review sections for evidence, findings, blast radius, questions, and traceability',
    () => {
      const spec = clone(VALID_SPEC);
      spec.policies = [{ id: 'no-api-db', kind: 'forbidden_dependency', from: 'api', to: 'db' }];
      spec.meta.unresolvedQuestions = ['Who owns retries?'];
      spec.nodes.push({
        id: 'orphan_q',
        label: 'Mystery',
        boundary: 'data_tier',
        type: 'cache',
        status: 'UNKNOWN',
        delta: 'UNCHANGED',
        description: 'What cache is this?',
      });
      spec.edges.push({ id: 'e2', source: 'api', target: 'orphan_q', label: 'lookup', communication: 'sync', pathType: 'read' });
      const result = compileArchitecture(spec);
      assert.ok(result.markdown.includes('## 6. Quality Gate'));
      assert.ok(result.markdown.includes('Blast radius') || result.markdown.includes('Blast Radius'));
      assert.ok(result.markdown.includes('Evidence manifest') || result.markdown.includes('Evidence Manifest'));
      assert.ok(result.markdown.includes('Implementation traceability') || result.markdown.includes('Implementation Traceability'));
      assert.ok(result.markdown.includes('Who owns retries?'));
      assert.ok(result.markdown.includes('no-api-db') || result.markdown.includes('forbidden'));
      assert.ok(result.html.includes('sequenceDiagram'));
    },
  ],

  [
    'compiling a version 1 spec still emits mermaid and does not mutate the caller spec',
    () => {
      const spec = clone(VALID_SPEC);
      const before = JSON.stringify(spec);
      const result = compileArchitecture(spec);
      assert.strictEqual(JSON.stringify(spec), before);
      assert.ok(result.mermaid.flowchart.includes('Orders DB'));
      assert.ok(result.markdown.includes('```mermaid'));
    },
  ],

  [
    'generated artifact contains and boots the shared geometry runtime',
    () => {
      const geometryPath = path.join(__dirname, '../src/engine/geometry.js');
      const geometrySource = fs.readFileSync(geometryPath, 'utf8');
      const result = compileArchitecture(clone(VALID_SPEC));

      assert.ok(geometrySource.length > 0, 'geometry.js must exist');
      assert.ok(result.html.includes(geometrySource), 'exact geometry.js source must be inlined');
      assert.ok(!result.html.includes('/* __GEOMETRY_RUNTIME__ */'), 'geometry placeholder must be substituted');
      assert.ok(!result.html.includes('// Edge geometry mirrored from src/engine/layout.js'));
      assert.ok(!/src=["'][^"']*geometry\.js/.test(result.html), 'generated HTML must stay a single offline file');

      const ctx = { Math, String, Number, Array, JSON, console };
      vm.createContext(ctx);
      vm.runInContext(geometrySource, ctx);
      assert.ok(ctx.ArchVizGeometry, 'runtime must attach ArchVizGeometry');
      assert.strictEqual(typeof ctx.ArchVizGeometry.buildEdgeGeometry, 'function');
      assert.strictEqual(typeof ctx.ArchVizGeometry.resolveLabelCollisions, 'function');
      assert.strictEqual(typeof ctx.ArchVizGeometry.cubicPointAt, 'function');
    },
  ],
  [
    'keeps machine-local absolute paths out of the built HTML and Markdown',
    () => {
      const dir = tmpDir();
      try {
        fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'api', 'Api.ts'), 'export const api = 1;\n');
        const spec = clone(VALID_SPEC);
        delete spec.meta.grounding;
        spec.schemaVersion = 2;
        spec.evidence = [{ id: 'ev_api', type: 'file', locator: { path: 'src/api/Api.ts' } }];
        spec.nodes[0].evidenceIds = ['ev_api'];
        const htmlPath = path.join(dir, 'out', 'index.html');
        const mdPath = path.join(dir, 'out', 'index.md');
        compileArchitecture(spec, { repoRoot: dir, outputHtml: htmlPath, outputMarkdown: mdPath });
        const roots = [dir, fs.realpathSync(dir)];
        [htmlPath, mdPath].forEach((file) => {
          const text = fs.readFileSync(file, 'utf8');
          roots.forEach((root) => assert.ok(!text.includes(root), `${path.basename(file)} leaks ${root}`));
        });
        assert.ok(fs.readFileSync(htmlPath, 'utf8').includes('"resolvedPath": "src/api/Api.ts"'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    'marks an illustrative diagram as illustrative in the built HTML',
    () => {
      const illustrative = compileArchitecture(clone(VALID_SPEC));
      assert.ok(illustrative.html.includes('id="doc-grounding"'));
      assert.ok(/"grounding": "illustrative"/.test(illustrative.html));
      assert.ok(illustrative.html.includes("document.getElementById('doc-grounding').hidden = ARCH_SPEC.meta.grounding !== 'illustrative'"));
    },
  ],
];

module.exports = { name: 'Compiler & Exporter', cases };
