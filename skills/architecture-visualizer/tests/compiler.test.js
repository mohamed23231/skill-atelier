const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { compileArchitecture, generateMarkdownReport } = require('../src/engine/compiler.js');
const { validateArchitecture } = require('../src/engine/validator.js');
const { exportToMermaid } = require('../src/utils/mermaid-exporter.js');
const { VALID_SPEC, clone } = require('./fixtures.js');
const { assembleWorkbench, loadTemplate, compactSource, WORKBENCH_DIR } = require('../src/workbench/assemble.js');

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
      assert.ok(result.html.includes('"schemaVersion":2'));
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
      // The page carries the compacted source: the same code without indentation or comment-only lines.
      assert.ok(result.html.includes(compactSource(geometrySource)), 'exact geometry.js code must be inlined');
      assert.ok(!result.html.includes('/* __GEOMETRY_RUNTIME__ */'), 'geometry placeholder must be substituted');
      assert.ok(!result.html.includes('// Edge geometry mirrored from src/engine/layout.js'));
      assert.ok(!/src=["'][^"']*geometry\.js/.test(result.html), 'generated HTML must stay a single offline file');

      const ctx = { Math, String, Number, Array, JSON, console };
      vm.createContext(ctx);
      vm.runInContext(geometrySource, ctx);
      const routerSource = fs.readFileSync(path.join(__dirname, '../src/engine/orthogonal.js'), 'utf8');
      assert.ok(result.html.includes(compactSource(routerSource)), 'exact router runtime code must be inlined');
      vm.runInContext(routerSource, ctx);
      assert.strictEqual(typeof ctx.ArchVizOrthogonal.routeOrthogonal, 'function');
      assert.strictEqual(typeof ctx.ArchVizOrthogonal.buildRouteGeometry, 'function');
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
        assert.ok(fs.readFileSync(htmlPath, 'utf8').includes('"resolvedPath":"src/api/Api.ts"'));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    'marks an illustrative diagram as illustrative in the built HTML',
    () => {
      const illustrative = compileArchitecture(clone(VALID_SPEC));
      // The trust strip's grounding pill replaced the filter bar's Illustrative badge.
      assert.ok(illustrative.html.includes('data-trust-pills'));
      assert.ok(illustrative.html.includes('function renderTrustStrip'));
      assert.ok(/"grounding":"illustrative"/.test(illustrative.html));
      assert.ok(illustrative.html.includes("if (key === 'grounding' && entry.label === 'Illustrative') pill.setAttribute('data-illustrative', 'true');"));
    },
  ],
  [
    'rewrites absolute paths written in the spec before publishing them',
    () => {
      const dir = tmpDir();
      try {
        fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'api', 'Api.ts'), 'export const api = 1;\n');
        const spec = clone(VALID_SPEC);
        delete spec.meta.grounding;
        spec.schemaVersion = 2;
        spec.evidence = [
          { id: 'ev_abs_inside', type: 'file', locator: { path: path.join(dir, 'src', 'api', 'Api.ts') } },
          { id: 'ev_abs_outside', type: 'file', locator: { path: path.join(os.homedir(), 'private-notes', 'secret.ts') } },
          { id: 'ev_route', type: 'api', locator: { method: 'GET', path: '/api/orders' } },
          { id: 'ev_dotdot', type: 'file', locator: { path: '../../elsewhere/private/notes.ts' } },
        ];
        spec.nodes[0].evidenceIds = spec.evidence.map((e) => e.id);
        spec.nodes[0].details.files = [path.join(dir, 'src', 'api', 'Api.ts')];
        const result = compileArchitecture(spec, { repoRoot: dir });
        [result.html, result.markdown].forEach((text) => {
          assert.ok(!text.includes(dir) && !text.includes(fs.realpathSync(dir)), 'repo root leaked');
          assert.ok(!text.includes(os.homedir()), 'home directory leaked');
        });
        assert.ok(result.html.includes('"path":"src/api/Api.ts"'));
        assert.ok(result.markdown.includes('<outside repository>/secret.ts'));
        assert.ok(!result.html.includes('elsewhere/private') && !result.markdown.includes('elsewhere/private'), 'a ../ path outside the root leaked');
        assert.ok(result.markdown.includes('<outside repository>/notes.ts'));
        assert.ok(result.html.includes('"path":"/api/orders"'), 'API routes are not file paths and stay as written');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    'the workbench assembles every style and script module exactly once, leaving no include behind',
    () => {
      const { html, modules } = assembleWorkbench();
      const onDisk = ['styles', 'scripts'].flatMap((sub) =>
        fs.readdirSync(path.join(WORKBENCH_DIR, sub)).map((name) => `${sub}/${name}`));
      assert.deepStrictEqual([...modules].sort(), onDisk.sort(), 'every module on disk is included, and only those');
      assert.ok(!html.includes('<!-- include:'), 'no include line may survive assembly');
      assert.strictEqual((html.match(/<style>/g) || []).length, 1, 'all styles land in one <style> block');
    },
  ],
  [
    'the built template strips indentation only where whitespace carries no meaning',
    () => {
      const { html } = assembleWorkbench();
      const built = loadTemplate();
      assert.ok(built.length < html.length - 10000, 'indentation should be stripped from the built template');
      assert.ok(!/^[ \t]+\S/m.test(built), 'no line of the built template keeps leading indentation');
      // Stripping is only safe while nothing authored depends on leading whitespace.
      assert.ok(!/<pre[^>]*>[^<\s]/.test(html) && !/<textarea/.test(html), 'the shell must not author whitespace-sensitive <pre> or <textarea> content');
      const scriptsDir = path.join(WORKBENCH_DIR, 'scripts');
      fs.readdirSync(scriptsDir).forEach((file) => {
        const source = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
        (source.match(/`[^`]*`/g) || []).filter((literal) => literal.includes('\n')).forEach((literal) => {
          assert.ok(/^`\s*</.test(literal) || /^`[^\n]*\n\s*</.test(literal) || /^`[^`]*\$\{/.test(literal),
            `${file}: a multi-line template literal that is not HTML would lose its indentation: ${literal.slice(0, 60)}`);
        });
      });
    },
  ],
  [
    'the workbench assembler refuses includes that escape, are missing, nest or repeat',
    () => {
      const dir = tmpDir();
      try {
        fs.mkdirSync(path.join(dir, 'styles'));
        fs.writeFileSync(path.join(dir, 'styles', 'a.css'), 'a {}\n');
        fs.writeFileSync(path.join(dir, 'styles', 'nested.css'), '<!-- include: styles/a.css -->\n');
        const shellWith = (line) => fs.writeFileSync(path.join(dir, 'shell.html'), `<style>\n${line}\n</style>\n`);
        shellWith('    <!-- include: styles/a.css -->');
        assert.strictEqual(assembleWorkbench(dir).html, '<style>\n    a {}\n</style>\n', 'a module is indented to its include line');
        shellWith('    <!-- include: ../outside.css -->');
        assert.throws(() => assembleWorkbench(dir), /escapes the workbench directory/);
        shellWith('    <!-- include: styles/missing.css -->');
        assert.throws(() => assembleWorkbench(dir), /not found/);
        shellWith('    <!-- include: styles/nested.css -->');
        assert.throws(() => assembleWorkbench(dir), /may not include other modules/);
        shellWith('    <!-- include: styles/a.css -->\n    <!-- include: styles/a.css -->');
        assert.throws(() => assembleWorkbench(dir), /included twice/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  ],
  [
    'the compiled workbench is one self-contained offline file',
    () => {
      const { html } = compileArchitecture(clone(VALID_SPEC));
      assert.strictEqual((html.match(/<html[\s>]/g) || []).length, 1, 'exactly one document');
      [/<link\b/i, /<script[^>]+\bsrc=/i, /@import\b/i, /url\(\s*['"]?https?:/i, /\bsrc=['"]https?:/i, /<iframe\b/i].forEach((pattern) => {
        assert.ok(!pattern.test(html), `the workbench must not load anything from outside the file (${pattern})`);
      });
    },
  ],
  [
    'every shipped example compiles within the 500 KB offline size budget',
    () => {
      const BUDGET_BYTES = 500 * 1024;
      const examplesDir = path.join(__dirname, '..', 'examples');
      fs.readdirSync(examplesDir).forEach((name) => {
        const spec = JSON.parse(fs.readFileSync(path.join(examplesDir, name, 'architecture.json'), 'utf8'));
        const bytes = Buffer.byteLength(compileArchitecture(spec).html, 'utf8');
        assert.ok(bytes <= BUDGET_BYTES, `${name} is ${bytes} bytes, over the ${BUDGET_BYTES} byte budget`);
      });
    },
  ],
  [
    'the workbench uses one icon set: no emoji and no bracketed status tags anywhere in its sources',
    () => {
      const { html } = assembleWorkbench();
      const emoji = html.match(/\p{Extended_Pictographic}/gu) || [];
      assert.deepStrictEqual([...new Set(emoji)], [], 'emoji found in the workbench');
      // A status or key written inside brackets, literally ("[ADDED]", "[FK→orders]") or built from a value ("[${n.delta}]").
      assert.ok(!/\[(VERIFIED|INFERRED|ASSUMED|UNKNOWN|ADDED|CHANGED|REMOVED|MOVED|PK|FK)[\]→ ]/.test(html), 'bracketed status or key tag found');
      assert.ok(!/\[\$\{n\.(status|delta)/.test(html), 'bracketed status tag built from a node value');
    },
  ],
  [
    'every color comes from a design token, and every token the workbench uses is defined',
    () => {
      const read = (rel) => fs.readFileSync(path.join(WORKBENCH_DIR, rel), 'utf8');
      const { modules } = assembleWorkbench();
      const tokensCss = read('styles/tokens.css');
      const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
      const sources = ['shell.html', ...modules].filter((rel) => rel !== 'styles/tokens.css');
      sources.forEach((rel) => {
        const text = read(rel);
        const literals = (text.match(/#[0-9a-fA-F]{3,8}\b(?![\w-])|rgba?\(/g) || []).filter((m) => !/^#(i|ui|kind|arrow)/.test(m));
        assert.deepStrictEqual(literals, [], `${rel} has a color literal; use a token`);
        [...text.matchAll(/var\((--[a-z0-9-]+)/g)].forEach((m) => {
          const local = new RegExp(`${m[1]}\\s*:`).test(text) || /--canvas-(left|right)|--overlay-clearance|--chrome-top/.test(m[1]);
          assert.ok(defined.has(m[1]) || local, `${rel} uses ${m[1]}, which no stylesheet defines`);
        });
      });
      const stateJs = read('scripts/state.js');
      const listed = [...stateJs.match(/DESIGN_TOKENS = \[([^\]]+)\]/)[1].matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]);
      assert.deepStrictEqual([...listed].sort(), [...defined].sort(), 'DESIGN_TOKENS must list every token so exports carry them');
    },
  ],
  [
    'lens state defaults and explicit selections are owned by store actions',
    () => {
      const source = fs.readFileSync(path.join(WORKBENCH_DIR, 'scripts/state.js'), 'utf8');
      const store = fs.readFileSync(path.join(WORKBENCH_DIR, 'scripts/store.js'), 'utf8');
      const sandbox = { ArchVizGeometry: {} };
      vm.runInNewContext(source + store + '; this.result = { state, actions, STORE_FIELDS };', sandbox);
      const { state, actions, STORE_FIELDS } = sandbox.result;
      assert.strictEqual(state.lens, 'structure');
      assert.strictEqual(state.lensExplicit, false);
      assert.ok(STORE_FIELDS.includes('lens') && STORE_FIELDS.includes('lensExplicit'));
      actions.setLens('risk', true);
      assert.strictEqual(state.lens, 'risk');
      assert.strictEqual(state.lensExplicit, true);
      actions.setLens('risk', false);
      assert.strictEqual(state.lensExplicit, false);
    },
  ],
  [
    'view state changes only through named actions in store.js',
    () => {
      const scriptsDir = path.join(WORKBENCH_DIR, 'scripts');
      const storeSource = fs.readFileSync(path.join(scriptsDir, 'store.js'), 'utf8');
      const storeSandbox = { Object, state: {} };
      vm.runInNewContext(storeSource + '; this.STORE_FIELDS = STORE_FIELDS;', storeSandbox);
      const storeFields = storeSandbox.STORE_FIELDS;
      assert.ok(Array.isArray(storeFields) && storeFields.length > 0, 'STORE_FIELDS must be a non-empty array');

      const stateSource = fs.readFileSync(path.join(scriptsDir, 'state.js'), 'utf8');
      const stateSandbox = { ArchVizGeometry: {} };
      vm.runInNewContext(stateSource + '; this.state = state;', stateSandbox);
      const stateKeys = Object.keys(stateSandbox.state || {});

      storeFields.forEach((field) => {
        assert.ok(
          stateKeys.includes(field),
          `every STORE_FIELDS name must be a key of the state object in state.js (${field} missing)`
        );
      });

      const writePattern = new RegExp(`\\bstate\\.(${storeFields.join('|')})\\s*(=(?!=)|\\+=|-=|\\+\\+|--)`);
      const scriptFiles = fs.readdirSync(scriptsDir).filter((file) => file.endsWith('.js') && file !== 'store.js');

      scriptFiles.forEach((file) => {
        const content = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
        const match = content.match(writePattern);
        assert.strictEqual(
          match,
          null,
          `Direct write to store field found in ${file}: ${match ? match[0] : ''}`
        );
      });
    },
  ],
  [
    'example 3 embeds and marks a generated narrative for every stage and interaction',
    () => {
      const examplePath = path.join(__dirname, '..', 'examples', '3-async-event-driven-workflow', 'architecture.json');
      const spec = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
      const result = compileArchitecture(spec);
      const embedded = readEmbeddedSpec(result.html);

      assert.ok(Array.isArray(embedded.scenarios) && embedded.scenarios.length > 0);
      const stages = [];
      const visit = (stage) => {
        stages.push(stage);
        (stage.branches || []).forEach((branch) => (branch.stages || []).forEach(visit));
      };
      embedded.scenarios.forEach((scenario) => (scenario.stages || []).forEach(visit));

      assert.ok(stages.length > 0);
      stages.forEach((stage) => {
        assert.strictEqual(typeof stage.narrative, 'string', `stage ${stage.id} must carry a narrative`);
        assert.ok(stage.narrative.length > 0, `stage ${stage.id} narrative must not be empty`);
        (stage.interactions || []).forEach((interaction) => {
          assert.strictEqual(typeof interaction.narrative, 'string', `interaction ${interaction.id} must carry a narrative`);
          assert.ok(interaction.narrative.length > 0, `interaction ${interaction.id} narrative must not be empty`);
          assert.strictEqual(interaction.narrativeGenerated, true, `interaction ${interaction.id} must be flagged as generated`);
        });
      });
      assert.ok(stages.every((stage) => stage.narrativeGenerated === true), 'generated stages must be flagged');
    },
  ],

  [
    'keeps an authored narrative and never flags it',
    () => {
      const spec = clone(VALID_SPEC);
      spec.schemaVersion = 2;
      spec.scenarios = [
        {
          id: 'authored',
          name: 'Authored',
          stages: [
            {
              id: 's1',
              name: 'Authored stage',
              kind: 'interaction',
              narrative: 'A hand-written stage.',
              interactions: [
                { id: 'i1', from: 'api', to: 'db', label: 'Insert', edgeId: 'e1', narrative: 'A hand-written hop.' },
              ],
            },
          ],
        },
      ];
      const result = compileArchitecture(spec);
      const stage = readEmbeddedSpec(result.html).scenarios[0].stages[0];
      assert.strictEqual(stage.narrative, 'A hand-written stage.');
      assert.strictEqual(stage.narrativeGenerated, undefined);
      assert.strictEqual(stage.interactions[0].narrative, 'A hand-written hop.');
      assert.strictEqual(stage.interactions[0].narrativeGenerated, undefined);
    },
  ],

  [
    'markdown report tells each scenario as numbered steps and marks generated sentences',
    () => {
      const examplePath = path.join(__dirname, '..', 'examples', '3-async-event-driven-workflow', 'architecture.json');
      const spec = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
      const result = compileArchitecture(spec);

      assert.ok(result.markdown.includes('## Scenarios'));
      assert.ok(result.markdown.includes('### Order Fulfillment Saga with Parallel Execution & DLQ Compensation'));
      assert.ok(result.markdown.includes(' _(generated)_'));
      assert.ok(/1\. \*\*[^*]+\*\*: /.test(result.markdown), 'top-level stages are a numbered list');
      assert.ok(result.markdown.includes('   - **Dispatch Successful**'), 'branch outcomes are nested bullets');
    },
  ],
];

function readEmbeddedSpec(html) {
  const marker = 'const ARCH_SPEC = ';
  const markerIndex = html.indexOf(marker);
  assert.ok(markerIndex !== -1, 'embedded ARCH_SPEC must be present');
  const start = html.indexOf('{', markerIndex);
  assert.ok(start !== -1, 'embedded ARCH_SPEC must be JSON');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error('Unterminated embedded ARCH_SPEC');
}

cases.push(['the workbench assembles from a relative or trailing-slash directory exactly as from its own', () => {
  const relative = path.relative(process.cwd(), WORKBENCH_DIR) + path.sep;
  assert.strictEqual(assembleWorkbench(relative).html, assembleWorkbench().html);
  assert.strictEqual(assembleWorkbench(WORKBENCH_DIR + path.sep).html, assembleWorkbench().html);
}]);

cases.push(['CLI build accepts both router modes and rejects unknown modes', () => {
  const { execFileSync } = require('node:child_process');
  const dir = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(VALID_SPEC));
    const cli = path.join(__dirname, '../bin/arch-viz.js');
    for (const router of ['orthogonal', 'curved']) {
      const output = path.join(dir, router + '.html');
      execFileSync(process.execPath, [cli, 'build', specPath, '-o', output, '--router', router, '--no-open'], { stdio: 'pipe' });
      const html = fs.readFileSync(output, 'utf8');
      assert.strictEqual(readEmbeddedSpec(html).layout.router, router);
    }
    assert.throws(() => execFileSync(process.execPath,
      [cli, 'build', specPath, '--router', 'unknown', '--no-open'], { stdio: 'pipe' }), /--router must be curved or orthogonal/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}]);

cases.push(['compact cards and lens keys ship in every example', () => {
  const examples = path.join(__dirname, '../examples');
  for (const name of fs.readdirSync(examples)) {
    const spec = JSON.parse(fs.readFileSync(path.join(examples, name, 'architecture.json'), 'utf8'));
    const { html, layout } = compileArchitecture(spec);
    assert.ok(html.includes('aria-label="Lens key"'));
    assert.ok(!/class="filter-bar"|id="delta-bar"|class="legend-box"/.test(html));
    assert.ok(html.includes('data-flow-toggle'));
    assert.ok(!/Cylinder: datastore|Chevron:|Pill:|Dashed border: external system/.test(html));
    layout.nodes.forEach(n => assert.deepStrictEqual([n.width, n.height], [220, 72]));
    const b = layout.totalVisualBounds;
    assert.ok(Math.min(1040 / (b.width + 48), 806 / (b.height + 48)) >= 0.75, name);
  }
}]);


cases.push(['CLI explicit direction selects columns for both LR and TB', () => {
  const { execFileSync } = require('node:child_process');
  const dir = tmpDir();
  try {
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({ ...clone(VALID_SPEC), layout: { layout: 'lanes' } }));
    for (const direction of ['LR', 'TB']) {
      const output = path.join(dir, `${direction}.html`);
      execFileSync(process.execPath, [path.join(__dirname, '../bin/arch-viz.js'), 'build', specPath, '-o', output, '--direction', direction, '--no-open'], { stdio: 'pipe' });
      const layout = readEmbeddedSpec(fs.readFileSync(output, 'utf8')).layout;
      assert.strictEqual(layout.layout, 'columns');
      assert.strictEqual(layout.direction, direction);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}]);

cases.push(['scalar payloads survive generated walkthrough narration', () => {
  const { narrateInteraction } = require('../src/engine/narrative.js');
  for (const payload of ['order=42', 0, false]) {
    assert.ok(narrateInteraction({ from: 'api', to: 'db', label: 'Write', payload }).includes(`Payload: ${payload}.`));
    assert.ok(narrateInteraction({ from: 'api', to: 'db', payload }).includes(`Payload: ${payload}.`));
  }
  for (const payload of ['', '  ', null, undefined]) {
    assert.ok(!narrateInteraction({ from: 'api', to: 'db', label: 'Write', payload }).includes('Payload:'));
  }
}]);

cases.push(['nested parallel child narratives survive compilation', () => {
  const spec = clone(VALID_SPEC);
  spec.scenarios = [{ id: 'authored_parallel', name: 'Parallel', stages: [{ id: 'p', type: 'parallel', stages: [
    { id: 'a', type: 'interaction', from: 'api', to: 'db', narrative: 'Authored child.' },
  ] }] }];
  const result = compileArchitecture(spec, {});
  const stage = readEmbeddedSpec(result.html).scenarios[0].stages[0];
  assert.strictEqual(stage.interactions[0].narrative, 'Authored child.');
  assert.strictEqual(stage.interactions[0].narrativeGenerated, undefined);
  assert.ok(stage.narrative.includes('Authored child'));
  assert.ok(!result.validation.notices.some(n => n.includes('no authored narrative')));
}]);

cases.push(['branch narratives summarize outcome predicates in HTML and Markdown', () => {
  const spec = clone(VALID_SPEC);
  spec.scenarios = [{ id: 'decision', stages: [{ id: 'choose', kind: 'branch', branches: [
    { name: 'Success', condition: 'write succeeds', stages: [] },
    { name: 'Retry', condition: 'write fails', stages: [] },
  ] }] }];
  const result = compileArchitecture(spec, {});
  const narrative = readEmbeddedSpec(result.html).scenarios[0].stages[0].narrative;
  assert.ok(narrative.startsWith('Decision: write succeeds or write fails.'));
  assert.ok(!narrative.includes('unspecified condition'));
  assert.ok(result.markdown.includes(narrative));
  spec.scenarios[0].stages[0].condition = 'write result';
  assert.ok(readEmbeddedSpec(compileArchitecture(spec, {}).html).scenarios[0].stages[0].narrative.startsWith('Decision: write result.'));
}]);

cases.push(['multi-hop interaction narratives include every hop in HTML and Markdown', () => {
  const spec = clone(VALID_SPEC);
  spec.scenarios = [{ id: 'multi', stages: [{ id: 'hops', kind: 'interaction', interactions: [
    { from: 'api', to: 'db', label: 'Insert' },
    { from: 'db', to: 'api', narrative: 'Return the saved order.' },
  ] }] }];
  const result = compileArchitecture(spec, {});
  const stage = readEmbeddedSpec(result.html).scenarios[0].stages[0];
  assert.strictEqual(stage.narrative, stage.interactions.map(hop => hop.narrative).join(' '));
  assert.ok(stage.narrative.includes('Return the saved order.'));
  assert.ok(result.markdown.includes(stage.narrative));
}]);

module.exports = { name: 'Compiler & Exporter', cases };
