const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeLayout: computeDefaultLayout, buildEdgeGeometry, cubicPointAt, curveSanityScore, resolveLabelCollisions } = require('../src/engine/layout.js');
// Existing geometry cases explicitly exercise the curved fallback.
const computeLayout = (spec, config = {}) => computeDefaultLayout(spec, { layout: 'columns', direction: spec.layout?.direction || 'LR', ...config, router: 'curved' });
const geometry = require('../src/engine/geometry.js');
const { loadTemplate } = require('../src/workbench/assemble.js');
const {
  VALID_SPEC,
  ADVERSARIAL_RECIPROCAL_SPEC,
  ADVERSARIAL_DENSE_PORTS_SPEC,
  ADVERSARIAL_CLIPPED_BOUNDS_SPEC,
  ADVERSARIAL_SIBLING_SPEC,
  ADVERSARIAL_COLLISION_SPEC,
  clone,
} = require('./fixtures.js');

const crossingSpec = {
  meta: { title: 'Crossing', description: 'Barycenter check', grounding: 'illustrative' },
  boundaries: [
    { id: 'left', label: 'Left', order: 1 },
    { id: 'right', label: 'Right', order: 2 },
  ],
  nodes: [
    { id: 'a1', label: 'A1', boundary: 'left', type: 'service' },
    { id: 'a2', label: 'A2', boundary: 'left', type: 'service' },
    { id: 'b1', label: 'B1', boundary: 'right', type: 'service' },
    { id: 'b2', label: 'B2', boundary: 'right', type: 'service' },
  ],
  edges: [
    { id: 'e1', source: 'a1', target: 'b2', label: 'x', communication: 'sync' },
    { id: 'e2', source: 'a2', target: 'b1', label: 'y', communication: 'sync' },
  ],
};

const cases = [
  [
    'labelLeader tethers a displaced label to its curve and stays silent for a label on its edge',
    () => {
      const onCurve = { labelX: 100, labelY: 50, labelWidth: 60, labelTether: { x: 100, y: 50 } };
      assert.strictEqual(geometry.labelLeader(onCurve), null);
      const pushedRight = { labelX: 300, labelY: 50, labelWidth: 60, labelTether: { x: 100, y: 50 } };
      assert.deepStrictEqual(geometry.labelLeader(pushedRight), { x1: 100, y1: 50, x2: 270, y2: 50 });
      assert.strictEqual(geometry.labelLeader({ labelX: 1, labelY: 1, labelWidth: 0, labelTether: { x: 99, y: 99 } }), null);
    },
  ],
  [
    'every edge label in the examples records the curve point it was placed from',
    () => {
      ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow'].forEach((name) => {
        const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', name, 'architecture.json'), 'utf8'));
        computeLayout(spec).edges.filter((e) => e.labelWidth > 0).forEach((e) => {
          assert.ok(e.labelTether && Number.isFinite(e.labelTether.x), `${name}: edge ${e.id} has no label tether`);
        });
      });
    },
  ],
  [
    'throws a helpful error when nodes are missing',
    () => {
      assert.throws(() => computeLayout({ meta: { title: 'x' } }), /non-empty array/);
    },
  ],

  [
    'is deterministic across runs',
    () => {
      const a = JSON.stringify(computeLayout(clone(VALID_SPEC)));
      const b = JSON.stringify(computeLayout(clone(VALID_SPEC)));
      assert.strictEqual(a, b);
    },
  ],

  [
    'keeps nodes inside their boundary box',
    () => {
      const layout = computeLayout(clone(VALID_SPEC));
      layout.nodes.forEach((node) => {
        const boundary = layout.boundaries.find((b) => b.id === node.boundary);
        assert.ok(node.x >= boundary.x, `${node.id} left of boundary`);
        assert.ok(node.x + node.width <= boundary.x + boundary.width, `${node.id} right of boundary`);
        assert.ok(node.y >= boundary.y, `${node.id} above boundary`);
        assert.ok(node.y + node.height <= boundary.y + boundary.height, `${node.id} below boundary`);
      });
    },
  ],

  [
    'orders ranks by barycenter to remove a crossing',
    () => {
      const layout = computeLayout(crossingSpec);
      const y = (id) => layout.nodes.find((n) => n.id === id).y;
      // a1 -> b2 and a2 -> b1 must not cross: the right rank flips to b2 above b1
      const crossed = y('a1') < y('a2') !== y('b2') < y('b1');
      assert.strictEqual(crossed, false, 'barycenter ordering should remove the crossing');
    },
  ],

  [
    'respects explicit node order over barycenter',
    () => {
      const pinned = clone(crossingSpec);
      pinned.nodes.find((n) => n.id === 'b1').order = 1;
      pinned.nodes.find((n) => n.id === 'b2').order = 2;
      const layout = computeLayout(pinned);
      const y = (id) => layout.nodes.find((n) => n.id === id).y;
      assert.ok(y('b1') < y('b2'), 'explicitly ordered nodes keep their order');
    },
  ],

  [
    'emits a cubic path and anchors every label to a point on its own curve',
    () => {
      const layout = computeLayout(clone(VALID_SPEC));
      const tCandidates = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8];
      const offsets = [0, -10, 10, -28, 26, -46, 44, -64, 62];

      layout.edges
        .filter((e) => e.points && e.labelWidth)
        .forEach((edge) => {
          assert.match(edge.path, /^M [-\d.]+ [-\d.]+ C /);
          const onCurve = tCandidates.some((t) => {
            const point = cubicPointAt(t, edge.points, edge.controls);
            return Math.abs(point.x - edge.labelX) < 0.01 && offsets.some((dy) => Math.abs(point.y + dy - edge.labelY) < 0.01);
          });
          assert.ok(onCurve, `label for ${edge.id} is not anchored to its curve`);
        });
    },
  ],

  [
    'halves edges that cut through an unrelated card by scoring candidate routes',
    () => {
      const layout = computeLayout(clone(VALID_SPEC));
      const tunnelling = layout.edges.filter((edge) => {
        if (!edge.points) return false;
        return layout.nodes.some((n) => {
          if (n.id === edge.source || n.id === edge.target) return false;
          for (let i = 1; i < 100; i++) {
            const p = cubicPointAt(i / 100, edge.points, edge.controls);
            if (p.x > n.x && p.x < n.x + n.width && p.y > n.y && p.y < n.y + n.height) return true;
          }
          return false;
        });
      });
      assert.strictEqual(tunnelling.length, 0, `unrelated cards crossed: ${tunnelling.map((e) => e.id).join(', ')}`);
    },
  ],

  [
    'classifies self, sibling, backward and forward edges',
    () => {
      const source = { id: 's', x: 400, y: 100, width: 240, height: 110 };
      const sibling = { id: 't', x: 400, y: 300, width: 240, height: 110 };
      const backward = { id: 'u', x: 0, y: 100, width: 240, height: 110 };
      const forward = { id: 'v', x: 900, y: 100, width: 240, height: 110 };
      assert.strictEqual(buildEdgeGeometry(source, source, true).points.kind, 'self');
      assert.strictEqual(buildEdgeGeometry(source, sibling, true).points.kind, 'sibling');
      assert.strictEqual(buildEdgeGeometry(source, backward, true).points.kind, 'backward');
      assert.strictEqual(buildEdgeGeometry(source, forward, true).points.kind, 'forward');
    },
  ],

  [
    'supports top-to-bottom direction',
    () => {
      const layout = computeLayout(clone(VALID_SPEC), { direction: 'TB' });
      const [first, second] = layout.boundaries;
      assert.ok(second.y > first.y, 'TB stacks boundaries vertically');
      assert.strictEqual(first.x, second.x);
    },
  ],

  [
    'edge labels never land on top of a node card',
    () => {
      const layout = computeLayout(VALID_SPEC);
      const collisions = layout.edges.filter((edge) =>
        layout.nodes.some((node) => edge.labelX > node.x - 4 && edge.labelX < node.x + node.width + 4 && edge.labelY > node.y - 4 && edge.labelY < node.y + node.height + 4)
      );
      assert.deepStrictEqual(
        collisions.map((e) => e.id),
        []
      );
    },
  ],

  [
    'label anchor search is deterministic across runs',
    () => {
      const a = computeLayout(VALID_SPEC).edges.map((e) => `${e.id}:${e.labelX},${e.labelY}`);
      const b = computeLayout(VALID_SPEC).edges.map((e) => `${e.id}:${e.labelX},${e.labelY}`);
      assert.deepStrictEqual(a, b);
    },
  ],

  [
    'edge endpoints sit one EDGE_END_GAP off the drawn shape outline of the destination node',
    () => {
      const layout = computeLayout(clone(VALID_SPEC));
      layout.edges.forEach((e) => {
        if (!e.points) return;
        const target = layout.nodes.find((n) => n.id === e.target);
        if (!target) return;
        const face = e.points.targetFace || 'left';
        let gap;
        if (face === 'left') {
          const dy = e.points.y2 - (target.y + target.height / 2);
          const boundaryX = geometry.shapeLeftX(target, dy);
          gap = boundaryX - e.points.x2;
        } else if (face === 'right') {
          const dy = e.points.y2 - (target.y + target.height / 2);
          const boundaryX = geometry.shapeRightX(target, dy);
          gap = e.points.x2 - boundaryX;
        } else if (face === 'top') {
          const dx = e.points.x2 - (target.x + target.width / 2);
          const boundaryY = geometry.shapeTopY(target, dx);
          gap = boundaryY - e.points.y2;
        } else {
          const dx = e.points.x2 - (target.x + target.width / 2);
          const boundaryY = geometry.shapeBottomY(target, dx);
          gap = e.points.y2 - boundaryY;
        }
        assert.ok(
          gap >= geometry.EDGE_END_GAP - 2 && gap <= geometry.EDGE_END_GAP + 4,
          `endpoint of ${e.id} sits ${gap.toFixed(2)}px off the ${face} outline of ${target.id} (expected ~${geometry.EDGE_END_GAP}px)`
        );
      });
    },
  ],

  [
    'all component kinds share rounded card attachment geometry',
    () => {
      const card = { x: 100, y: 100, width: 220, height: 72 };
      for (const type of ['service', 'database', 'storage', 'queue', 'topic', 'actor', 'worker', 'cloud_function', 'external']) {
        const n = { ...card, type };
        assert.strictEqual(geometry.shapeRightX(n, 24), 320);
        assert.strictEqual(geometry.shapeLeftX(n, 24), 100);
        assert.strictEqual(geometry.shapeTopY(n, 40), 100);
        assert.strictEqual(geometry.shapeBottomY(n, 40), 172);
        assert.strictEqual(geometry.shapeRightX(n, 36), 308);
        assert.strictEqual(geometry.shapeLeftX(n, 36), 112);
        assert.strictEqual(geometry.shapeTopY(n, 110), 112);
        assert.strictEqual(geometry.shapeBottomY(n, 110), 160);
        assert.strictEqual(geometry.shapeHorizontalPortOffset(n, 110), 98);
      }
    },
  ],

  [
    'edge labels never overlap a 28px box centred on either endpoint of their own edge',
    () => {
      const layout = computeLayout(clone(VALID_SPEC));
      const ov = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      layout.edges
        .filter((e) => e.points && e.labelWidth)
        .forEach((e) => {
          const b = { left: e.labelX - e.labelWidth / 2, right: e.labelX + e.labelWidth / 2, top: e.labelY - 9, bottom: e.labelY + 9 };
          [
            [e.points.x1, e.points.y1],
            [e.points.x2, e.points.y2],
          ].forEach(([x, y]) => {
            const overlap = ov(b, { left: x - 14, right: x + 14, top: y - 14, bottom: y + 14 });
            assert.strictEqual(overlap, 0, `label of ${e.id} overlaps an endpoint zone`);
          });
        });
    },
  ],

  [
    'browser runtime produces identical geometry to compiler layout across all example specs',
    () => {
      const geometrySource = fs.readFileSync(path.join(__dirname, '../src/engine/geometry.js'), 'utf8');
      const ctx = { console, Math, String, Number, Array, JSON };
      vm.createContext(ctx);
      vm.runInContext(geometrySource, ctx);
      const api = ctx.ArchVizGeometry;
      assert.ok(api, 'geometry.js must attach ArchVizGeometry in the browser');
      assert.strictEqual(typeof api.buildEdgeGeometry, 'function');
      assert.strictEqual(typeof api.estimateLabelWidth, 'function');

      const exampleSpecs = [
        '../examples/1-crud-business-feature/architecture.json',
        '../examples/2-complex-database-migration/architecture.json',
        '../examples/3-async-event-driven-workflow/architecture.json',
      ];

      for (const specRel of exampleSpecs) {
        const spec = require(path.join(__dirname, specRel));
        const l = computeLayout(spec);
        const isLR = l.config.direction !== 'TB';
        const band = l.nodes.reduce(
          (a, n) => ({
            top: Math.min(a.top, n.y),
            bottom: Math.max(a.bottom, n.y + n.height),
            left: Math.min(a.left, n.x),
            right: Math.max(a.right, n.x + n.width),
          }),
          { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity }
        );
        const byId = new Map(l.nodes.map((n) => [n.id, n]));

        l.edges.forEach((e) => {
          const s = byId.get(e.source);
          const t = byId.get(e.target);
          if (!s || !t) return;
          const options = {
            obstacles: l.nodes,
            nodes: l.nodes,
            band,
            labelWidth: api.estimateLabelWidth(e.label || e.packetLabel),
          };
          const compilerGeom = buildEdgeGeometry(s, t, isLR, { ...options });
          const browserGeom = api.buildEdgeGeometry(s, t, isLR, { ...options });

          assert.strictEqual(browserGeom.path, compilerGeom.path, `path divergence on edge ${e.id} in ${specRel}: compiler="${compilerGeom.path}" browser="${browserGeom.path}"`);
          assert.ok(Math.abs(compilerGeom.labelX - browserGeom.labelX) <= 0.001, `labelX divergence on edge ${e.id} in ${specRel}: compiler=${compilerGeom.labelX} browser=${browserGeom.labelX}`);
          assert.ok(Math.abs(compilerGeom.labelY - browserGeom.labelY) <= 0.001, `labelY divergence on edge ${e.id} in ${specRel}: compiler=${compilerGeom.labelY} browser=${browserGeom.labelY}`);
        });
      }
    },
  ],

  [
    'arrowheads always point towards their target card',
    () => {
      const exampleSpecs = [
        '../examples/1-crud-business-feature/architecture.json',
        '../examples/2-complex-database-migration/architecture.json',
        '../examples/3-async-event-driven-workflow/architecture.json',
      ];

      for (const specRel of exampleSpecs) {
        const spec = require(path.join(__dirname, specRel));
        const layout = computeLayout(spec);
        const byId = new Map(layout.nodes.map((n) => [n.id, n]));

        layout.edges.forEach((edge) => {
          if (!edge.points || !edge.controls) return;
          const target = byId.get(edge.target);
          if (!target) return;

          const tangent = {
            x: 3 * (edge.points.x2 - edge.controls.cx2),
            y: 3 * (edge.points.y2 - edge.controls.cy2),
          };
          const toTarget = {
            x: target.x + target.width / 2 - edge.points.x2,
            y: target.y + target.height / 2 - edge.points.y2,
          };
          const magnitude = Math.hypot(tangent.x, tangent.y) * Math.hypot(toTarget.x, toTarget.y);
          const cosine = magnitude > 0 ? (tangent.x * toTarget.x + tangent.y * toTarget.y) / magnitude : 0;

          assert.ok(cosine >= 0.2, `edge ${edge.id} in ${specRel} has misdirected arrowhead: cos=${cosine.toFixed(2)} < 0.2`);
        });
      }
    },
  ],

  [
    'no two edges share an arrival point across all example specs',
    () => {
      const exampleSpecs = [
        '../examples/1-crud-business-feature/architecture.json',
        '../examples/2-complex-database-migration/architecture.json',
        '../examples/3-async-event-driven-workflow/architecture.json',
      ];

      for (const specRel of exampleSpecs) {
        const spec = require(path.join(__dirname, specRel));
        const layout = computeLayout(spec);
        const buckets = new Map();

        layout.edges.forEach((edge) => {
          if (!edge.points) return;
          const key = `${Math.round(edge.points.x2 / 6)},${Math.round(edge.points.y2 / 6)}`;
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(edge.id);
        });

        for (const [key, edgeIds] of buckets) {
          assert.ok(edgeIds.length <= 1, `edges share an arrival point in ${specRel} at bucket (${key}): ${edgeIds.join(', ')}`);
        }
      }
    },
  ],

  [
    'every design token pair meets WCAG contrast in both themes (text 4.5:1, graphics 3:1)',
    () => {
      const css = fs.readFileSync(path.join(__dirname, '../src/workbench/styles/tokens.css'), 'utf8');
      const block = (selector) => {
        const start = css.indexOf(`${selector} {`);
        assert.ok(start >= 0, `tokens.css must define ${selector}`);
        const body = css.slice(start, css.indexOf('}', start));
        return Object.fromEntries([...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
      };
      const parse = (value) => {
        const hex = value.match(/^#([0-9a-f]{6})$/i);
        if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
        const rgba = value.match(/^rgba?\(([^)]+)\)$/);
        assert.ok(rgba, `unparseable color ${value}`);
        const parts = rgba[1].split(',').map((p) => Number(p.trim()));
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      };
      const over = (fg, bg) => fg.slice(0, 3).map((c, i) => Math.round(c * fg[3] + bg[i] * (1 - fg[3])));
      const luminance = (rgb) => {
        const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

      const dark = block(':root');
      const themes = { dark, light: { ...dark, ...block('[data-theme="light"]') } };
      const failures = [];
      Object.entries(themes).forEach(([theme, tokens]) => {
        const solid = (name) => { const c = parse(tokens[name]); return c[3] === 1 ? c.slice(0, 3) : over(c, solid('--surface')); };
        const check = (fg, bg, min, fgColor) => {
          const value = ratio(fgColor || solid(fg), solid(bg));
          if (value < min) failures.push(`${theme}: ${fg} on ${bg} is ${value.toFixed(2)}:1, needs ${min}:1`);
        };
        // Text people must read.
        ['--ink', '--muted'].forEach((fg) => ['--bg', '--surface', '--surface-2', '--lane'].forEach((bg) => check(fg, bg, 4.5)));
        check('--accent', '--surface', 4.5);
        check('--accent-ink', '--accent', 4.5);
        ['--ok', '--warn', '--risk'].forEach((tone) => {
          check(tone, '--surface', 4.5);
          check(tone, `${tone}-soft`, 4.5, solid(tone)); // badge text on its own tint, composited over the surface
        });
        // Supplementary text (counts, hints) and information-bearing graphics.
        ['--bg', '--surface'].forEach((bg) => check('--faint', bg, 3));
        ['--edge', '--accent', '--ok', '--warn', '--risk'].forEach((fg) => ['--bg', '--surface', '--lane'].forEach((bg) => check(fg, bg, 3)));
      });
      assert.deepStrictEqual(failures, []);
    },
  ],

  [
    'workbench template normalises boundary tier heights without mutating layout data',
    () => {
      const html = loadTemplate();

      assert.ok(html.includes('tierBottom.set(b.y, Math.max(tierBottom.get(b.y) ?? -Infinity, b.y + b.height));'), 'tierBottom map should record max bottom coordinate per y');
      assert.ok(html.includes('height: collapsed ? COLLAPSED_PILL_HEIGHT : (tierBottom.get(b.y) - b.y)'), 'boundary height should normalize display height across tier');

      const boundaries = [
        { id: 'b1', y: 80, height: 188 },
        { id: 'b2', y: 80, height: 448 },
        { id: 'b3', y: 80, height: 318 },
        { id: 'b4', y: 600, height: 200 },
      ];
      const initialCopy = JSON.parse(JSON.stringify(boundaries));
      const tierBottom = new Map();
      boundaries.forEach((b) => {
        tierBottom.set(b.y, Math.max(tierBottom.get(b.y) ?? -Infinity, b.y + b.height));
      });

      assert.strictEqual(tierBottom.get(80) - 80, 448);
      assert.strictEqual(tierBottom.get(600) - 600, 200);
      assert.deepStrictEqual(boundaries, initialCopy, 'LAYOUT_DATA boundaries must not be mutated');
    },
  ],

  [
    'workbench template contains dvh fallbacks, responsive viewport rules, and debounced resize listener with userMovedView latch',
    () => {
      const html = loadTemplate();

      assert.ok(html.includes('height: 100vh;\nheight: 100dvh;\nwidth: 100%;'), 'body should use 100vh with 100dvh and 100% width');
      assert.ok(html.includes('height: calc(100vh - var(--chrome-top));\nheight: calc(100dvh - var(--chrome-top));'), 'canvas-container should use dvh fallback below the header and trust strip');
      assert.ok(html.includes('width: min(400px, calc(100vw - 48px));'), 'rail drawer width should use min(400px, calc(100vw - 48px))');
      assert.ok(html.includes('transform: translateX(105%);'), 'rail drawer parked position should be responsive');
      assert.ok(html.includes('top: calc(var(--chrome-top) + 16px);'), 'lens key should sit below the chrome without a filter offset');
      assert.ok(html.includes('function canvasSafeArea()'), 'camera framing should measure overlay insets');
      assert.ok(html.includes("window.addEventListener('resize'"), 'resize listener should be registered');
      assert.ok(html.includes('!state.userMovedView'), 'resize listener should check userMovedView latch before fitToScreen');
    },
  ],

  [
    'curve sanity rejects candidate that leaves bounding box by > 1.2x',
    () => {
      const points = { x1: 100, y1: 100, x2: 200, y2: 100 };
      const tameControls = { cx1: 130, cy1: 120, cx2: 170, cy2: 120 };
      assert.strictEqual(curveSanityScore(points, tameControls), 0);

      const wildControls = { cx1: 100, cy1: 400, cx2: 200, cy2: 400 };
      assert.ok(curveSanityScore(points, wildControls) > 0, 'wild control points should be penalized');
    },
  ],

  [
    'curve sanity rejects candidate that reverses direction',
    () => {
      const points = { x1: 100, y1: 100, x2: 100, y2: 200 };
      const monotonicControls = { cx1: 100, cy1: 130, cx2: 100, cy2: 170 };
      assert.strictEqual(curveSanityScore(points, monotonicControls), 0);

      const reversingControls = { cx1: 100, cy1: 400, cx2: 100, cy2: 50 };
      assert.ok(curveSanityScore(points, reversingControls) > 0, 'reversing curve should be penalized');
    },
  ],

  [
    'overlapping labels are resolved so bounding boxes are disjoint and remain on curves',
    () => {
      const spec = {
        meta: { title: 'Label Collision Spec', description: 'Test', grounding: 'illustrative' },
        nodes: [
          { id: 'n1', label: 'Node 1', type: 'service' },
          { id: 'n2', label: 'Node 2', type: 'service' },
          { id: 'n3', label: 'Node 3', type: 'service' },
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', label: 'Long First Label Description', communication: 'sync' },
          { id: 'e2', source: 'n1', target: 'n3', label: 'Long Second Label Description', communication: 'sync' },
        ],
      };
      const layout = computeLayout(spec);
      const e1 = layout.edges.find((e) => e.id === 'e1');
      const e2 = layout.edges.find((e) => e.id === 'e2');
      assert.ok(e1 && e2);

      const box1 = {
        left: e1.labelX - e1.labelWidth / 2,
        right: e1.labelX + e1.labelWidth / 2,
        top: e1.labelY - 9,
        bottom: e1.labelY + 9,
      };
      const box2 = {
        left: e2.labelX - e2.labelWidth / 2,
        right: e2.labelX + e2.labelWidth / 2,
        top: e2.labelY - 9,
        bottom: e2.labelY + 9,
      };
      const overlap = box1.left < box2.right && box1.right > box2.left && box1.top < box2.bottom && box1.bottom > box2.top;
      assert.strictEqual(overlap, false, 'computed label bounding boxes should not overlap');

      const syntheticEdges = [
        {
          id: 'se1',
          labelWidth: 100,
          labelX: 200,
          labelY: 150,
          points: { x1: 100, y1: 150, x2: 300, y2: 150 },
          controls: { cx1: 150, cy1: 150, cx2: 250, cy2: 150 },
        },
        {
          id: 'se2',
          labelWidth: 100,
          labelX: 210,
          labelY: 152,
          points: { x1: 100, y1: 150, x2: 300, y2: 150 },
          controls: { cx1: 150, cy1: 150, cx2: 250, cy2: 150 },
        },
      ];
      resolveLabelCollisions(syntheticEdges, [], []);
      const sbox1 = {
        left: syntheticEdges[0].labelX - 50,
        right: syntheticEdges[0].labelX + 50,
        top: syntheticEdges[0].labelY - 9,
        bottom: syntheticEdges[0].labelY + 9,
      };
      const sbox2 = {
        left: syntheticEdges[1].labelX - 50,
        right: syntheticEdges[1].labelX + 50,
        top: syntheticEdges[1].labelY - 9,
        bottom: syntheticEdges[1].labelY + 9,
      };
      const sOverlap = sbox1.left < sbox2.right && sbox1.right > sbox2.left && sbox1.top < sbox2.bottom && sbox1.bottom > sbox2.top;
      assert.strictEqual(sOverlap, false, 'synthetic overlapping labels should be resolved to disjoint boxes');
    },
  ],

  [
    'angle between end tangent and chord over last 12px is at most 8 degrees for all example specs',
    () => {
      const exampleSpecs = [
        '../examples/1-crud-business-feature/architecture.json',
        '../examples/2-complex-database-migration/architecture.json',
        '../examples/3-async-event-driven-workflow/architecture.json',
      ];

      for (const specRel of exampleSpecs) {
        const spec = require(path.join(__dirname, specRel));
        const layout = computeLayout(spec);

        layout.edges.forEach((edge) => {
          if (!edge.points || !edge.controls) return;
          const end = { x: edge.points.x2, y: edge.points.y2 };
          const tan = { x: 3 * (end.x - edge.controls.cx2), y: 3 * (end.y - edge.controls.cy2) };
          let cf = null;
          for (let i = 99; i >= 50; i--) {
            const p = cubicPointAt(i / 100, edge.points, edge.controls);
            if (Math.hypot(p.x - end.x, p.y - end.y) >= 12) {
              cf = p;
              break;
            }
          }
          if (cf) {
            const ch = { x: end.x - cf.x, y: end.y - cf.y };
            const m = Math.hypot(tan.x, tan.y) * Math.hypot(ch.x, ch.y);
            const deg = Math.round((Math.acos(Math.max(-1, Math.min(1, m > 0 ? (tan.x * ch.x + tan.y * ch.y) / m : 1))) * 180) / Math.PI);
            assert.ok(deg <= 8, `edge ${edge.id} in ${specRel} has kink angle ${deg} deg > 8 deg`);
          }
        });
      }
    },
  ],

  [
    'generated browser recomputation matches Node after a node move',
    () => {
      const { compileArchitecture } = require('../src/engine/compiler.js');
      const nodeGeometry = require('../src/engine/geometry.js');
      const spec = require(path.join(__dirname, '../examples/1-crud-business-feature/architecture.json'));
      const compiled = compileArchitecture(spec, { layoutOverrides: { layout: 'columns', router: 'curved' } });
      const geometrySource = fs.readFileSync(path.join(__dirname, '../src/engine/geometry.js'), 'utf8');

      assert.ok(compiled.html.includes(require('../src/workbench/assemble.js').compactSource(geometrySource)), 'generated HTML must contain the exact geometry runtime code');

      const ctx = { Math, String, Number, Array, JSON, console };
      vm.createContext(ctx);
      // Run the code exactly as the page carries it, so the parity below is the browser's.
      const shipped = require('../src/workbench/assemble.js').compactSource(geometrySource);
      const injected = compiled.html.slice(compiled.html.indexOf(shipped), compiled.html.indexOf(shipped) + shipped.length);
      vm.runInContext(injected, ctx);
      const browserGeometry = ctx.ArchVizGeometry;
      assert.ok(browserGeometry, 'injected runtime must attach ArchVizGeometry');
      assert.strictEqual(typeof browserGeometry.buildEdgeGeometry, 'function');

      const layout = compiled.layout;
      const moved = layout.nodes.find((n) => n.id === layout.edges[0].source);
      assert.ok(moved, 'layout must expose the source node of the first edge');
      moved.x += 80;
      moved.y += 40;

      const isLR = layout.config.direction !== 'TB';
      const band = layout.nodes.reduce(
        (acc, n) => ({
          top: Math.min(acc.top, n.y),
          bottom: Math.max(acc.bottom, n.y + n.height),
          left: Math.min(acc.left, n.x),
          right: Math.max(acc.right, n.x + n.width),
        }),
        { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity }
      );
      const byId = new Map(layout.nodes.map((n) => [n.id, n]));
      const affected = layout.edges.filter((e) => e.source === moved.id || e.target === moved.id);
      assert.ok(affected.length > 0, 'moved node must have incident edges');

      affected.forEach((edge) => {
        const sourceNode = byId.get(edge.source);
        const targetNode = byId.get(edge.target);
        const options = {
          obstacles: layout.nodes,
          nodes: layout.nodes,
          band,
          label: edge.label || edge.packetLabel,
          sourcePortOffset: edge.sourcePortOffset || 0,
          targetPortOffset: edge.targetPortOffset || 0,
          isReciprocal: edge.isReciprocal,
        };
        const fromNode = nodeGeometry.buildEdgeGeometry(sourceNode, targetNode, isLR, { ...options });
        const fromBrowser = browserGeometry.buildEdgeGeometry(sourceNode, targetNode, isLR, { ...options });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(fromBrowser)), JSON.parse(JSON.stringify(fromNode)), `live drag recomputation diverged on edge ${edge.id}`);
      });

      const recipCompiled = compileArchitecture(clone(ADVERSARIAL_RECIPROCAL_SPEC), { layoutOverrides: { layout: 'columns', router: 'curved' } });
      const makeEl = () => ({
        querySelector: () => makeEl(),
        querySelectorAll: () => [],
        getAttribute: () => '50',
        setAttribute: () => {},
        toggleAttribute: () => {},
        classList: { add: () => {}, remove: () => {} },
      });
      const runtimeCtx = {
        Math,
        String,
        Number,
        Array,
        JSON,
        console,
        Map,
        Set,
        parseFloat,
        Infinity,
        document: {
          getElementById: () => makeEl(),
          querySelectorAll: () => [],
          createElement: () => makeEl(),
        },
        window: {
          addEventListener: () => {},
          setTimeout: () => {},
        },
      };
      vm.createContext(runtimeCtx);
      const scriptRegex = /<script>([\s\S]*?)<\/script>/g;
      let m;
      while ((m = scriptRegex.exec(recipCompiled.html)) !== null) {
        vm.runInContext(m[1], runtimeCtx);
      }

      const movedRecipNode = vm.runInContext('LAYOUT_DATA.nodes.find((n) => n.id === "node_web")', runtimeCtx);
      movedRecipNode.x += 60;
      movedRecipNode.y += 30;
      runtimeCtx.recalculateNodeEdges('node_web');

      const browserRecipBackward = vm.runInContext('LAYOUT_DATA.edges.find((e) => e.id === "edge_backward")', runtimeCtx);
      const browserRecipForward = vm.runInContext('LAYOUT_DATA.edges.find((e) => e.id === "edge_forward")', runtimeCtx);
      assert.ok(browserRecipBackward && browserRecipForward);

      const pFwd = browserGeometry.cubicPointAt(0.5, browserRecipForward.points, browserRecipForward.controls);
      const pBwd = browserGeometry.cubicPointAt(0.5, browserRecipBackward.points, browserRecipBackward.controls);
      const liveSeparation = Math.hypot(pFwd.x - pBwd.x, pFwd.y - pBwd.y);
      assert.ok(liveSeparation >= 25, `reciprocal separation lost after live drag: separation=${liveSeparation.toFixed(2)}px < 25px`);

      const recipSource = vm.runInContext('LAYOUT_DATA.nodes.find((n) => n.id === "node_api")', runtimeCtx);
      const recipTarget = movedRecipNode;
      const expectedBackward = nodeGeometry.buildEdgeGeometry(recipSource, recipTarget, true, {
        obstacles: vm.runInContext('LAYOUT_DATA.nodes', runtimeCtx),
        nodes: vm.runInContext('LAYOUT_DATA.nodes', runtimeCtx),
        band: { top: 80, bottom: 250, left: 60, right: 600 },
        labelWidth: 50,
        sourcePortOffset: browserRecipBackward.sourcePortOffset || 0,
        targetPortOffset: browserRecipBackward.targetPortOffset || 0,
        isReciprocal: true,
      });
      assert.strictEqual(browserRecipBackward.controls.cy1, expectedBackward.controls.cy1, 'browser recomputation must preserve reciprocal bow');
    },
  ],

  [
    'rejects folded terminal curves on sibling and backward routes',
    () => {
      const layout = computeLayout(clone(ADVERSARIAL_SIBLING_SPEC));
      const edge = layout.edges[0];
      assert.ok(edge && edge.points && edge.controls);
      assert.ok(edge.controls.cy1 <= edge.controls.cy2, 'sibling curve control points must not invert vertical order');
      const end = { x: edge.points.x2, y: edge.points.y2 };
      let lastDist = Infinity;
      for (let i = 70; i <= 100; i++) {
        const pt = cubicPointAt(i / 100, edge.points, edge.controls);
        const dist = Math.hypot(pt.x - end.x, pt.y - end.y);
        assert.ok(dist <= lastDist + 0.05, `terminal curve folds back or overshoots at t=${i / 100}`);
        lastDist = dist;
      }

      const lrLayout = computeLayout(clone(ADVERSARIAL_RECIPROCAL_SPEC));
      const lrBackward = lrLayout.edges.find((e) => e.points && e.points.kind === 'backward');
      assert.ok(lrBackward && lrBackward.points && lrBackward.controls);
      assert.strictEqual(lrBackward.points.kind, 'backward');
      const lrEnd = { x: lrBackward.points.x2, y: lrBackward.points.y2 };
      let lrLastDist = Infinity;
      for (let i = 70; i <= 100; i++) {
        const pt = cubicPointAt(i / 100, lrBackward.points, lrBackward.controls);
        const dist = Math.hypot(pt.x - lrEnd.x, pt.y - lrEnd.y);
        assert.ok(dist <= lrLastDist + 0.05, `backward LR terminal curve folds back or overshoots at t=${i / 100}`);
        lrLastDist = dist;
      }

      const tbSpec = clone(ADVERSARIAL_RECIPROCAL_SPEC);
      tbSpec.layout = { direction: 'TB' };
      const tbLayout = computeLayout(tbSpec);
      const tbBackward = tbLayout.edges.find((e) => e.points && e.points.kind === 'backward');
      assert.ok(tbBackward && tbBackward.points && tbBackward.controls);
      assert.strictEqual(tbBackward.points.kind, 'backward');
      const tbEnd = { x: tbBackward.points.x2, y: tbBackward.points.y2 };
      let tbLastDist = Infinity;
      for (let i = 70; i <= 100; i++) {
        const pt = cubicPointAt(i / 100, tbBackward.points, tbBackward.controls);
        const dist = Math.hypot(pt.x - tbEnd.x, pt.y - tbEnd.y);
        assert.ok(dist <= tbLastDist + 0.05, `backward TB terminal curve folds back or overshoots at t=${i / 100}`);
        tbLastDist = dist;
      }
    },
  ],

  [
    'prevents marker tangent mismatch by keeping terminal approach within 8 degrees',
    () => {
      const specs = [clone(ADVERSARIAL_RECIPROCAL_SPEC), clone(ADVERSARIAL_SIBLING_SPEC), clone(ADVERSARIAL_COLLISION_SPEC)];
      specs.forEach((spec) => {
        const layout = computeLayout(spec);
        layout.edges.forEach((edge) => {
          if (!edge.points || !edge.controls) return;
          const end = { x: edge.points.x2, y: edge.points.y2 };
          const tan = { x: 3 * (end.x - edge.controls.cx2), y: 3 * (end.y - edge.controls.cy2) };
          let cf = null;
          for (let i = 99; i >= 50; i--) {
            const p = cubicPointAt(i / 100, edge.points, edge.controls);
            if (Math.hypot(p.x - end.x, p.y - end.y) >= 12) {
              cf = p;
              break;
            }
          }
          if (cf) {
            const ch = { x: end.x - cf.x, y: end.y - cf.y };
            const m = Math.hypot(tan.x, tan.y) * Math.hypot(ch.x, ch.y);
            const deg = Math.round((Math.acos(Math.max(-1, Math.min(1, m > 0 ? (tan.x * ch.x + tan.y * ch.y) / m : 1))) * 180) / Math.PI);
            assert.ok(deg <= 8, `edge ${edge.id} has terminal tangent error ${deg} deg > 8 deg`);
          }
        });
      });
    },
  ],

  [
    'total visual bounds enclose all curve extents, labels, and markers with fit margin >= 12px',
    () => {
      const layout = computeLayout(clone(ADVERSARIAL_CLIPPED_BOUNDS_SPEC));
      const dims = layout.dimensions;
      assert.ok(dims, 'layout dimensions must exist');

      layout.edges.forEach((edge) => {
        if (!edge.points || !edge.controls) return;
        for (let i = 0; i <= 50; i++) {
          const pt = cubicPointAt(i / 50, edge.points, edge.controls);
          assert.ok(pt.x >= dims.minX - 0.01, `curve point x ${pt.x} < minX ${dims.minX}`);
          assert.ok(pt.x <= dims.maxX + 0.01, `curve point x ${pt.x} > maxX ${dims.maxX}`);
          assert.ok(pt.y >= dims.minY - 0.01, `curve point y ${pt.y} < minY ${dims.minY}`);
          assert.ok(pt.y <= dims.maxY + 0.01, `curve point y ${pt.y} > maxY ${dims.maxY}`);
        }
        if (typeof edge.labelX === 'number' && typeof edge.labelWidth === 'number' && edge.labelWidth > 0) {
          const left = edge.labelX - edge.labelWidth / 2;
          const right = edge.labelX + edge.labelWidth / 2;
          const top = edge.labelY - 9;
          const bottom = edge.labelY + 9;
          assert.ok(left >= dims.minX - 0.01, `label left ${left} < minX ${dims.minX}`);
          assert.ok(right <= dims.maxX + 0.01, `label right ${right} > maxX ${dims.maxX}`);
          assert.ok(top >= dims.minY - 0.01, `label top ${top} < minY ${dims.minY}`);
          assert.ok(bottom <= dims.maxY + 0.01, `label bottom ${bottom} > maxY ${dims.maxY}`);
        }
        const markerRadius = 6;
        assert.ok(edge.points.x2 - markerRadius >= dims.minX - 0.01, `marker left < minX`);
        assert.ok(edge.points.x2 + markerRadius <= dims.maxX + 0.01, `marker right > maxX`);
        assert.ok(edge.points.y2 - markerRadius >= dims.minY - 0.01, `marker top < minY`);
        assert.ok(edge.points.y2 + markerRadius <= dims.maxY + 0.01, `marker bottom > maxY`);
      });

      const fitMarginX = dims.canvasWidth - (dims.maxX - dims.minX);
      const fitMarginY = dims.canvasHeight - (dims.maxY - dims.minY);
      assert.ok(fitMarginX >= 24, `fit horizontal margin ${fitMarginX} < 24px`);
      assert.ok(fitMarginY >= 24, `fit vertical margin ${fitMarginY} < 24px`);
    },
  ],

  [
    'prevents edge label collisions with node cards across adversarial topologies',
    () => {
      const specs = [clone(ADVERSARIAL_SIBLING_SPEC), clone(ADVERSARIAL_COLLISION_SPEC), clone(ADVERSARIAL_RECIPROCAL_SPEC)];
      specs.forEach((spec) => {
        const layout = computeLayout(spec);
        layout.edges.forEach((edge) => {
          if (!edge.points || typeof edge.labelX !== 'number' || typeof edge.labelWidth !== 'number' || edge.labelWidth <= 0) return;
          const lb = {
            left: edge.labelX - edge.labelWidth / 2,
            right: edge.labelX + edge.labelWidth / 2,
            top: edge.labelY - 9,
            bottom: edge.labelY + 9,
          };
          layout.nodes.forEach((node) => {
            const nb = { left: node.x, right: node.x + node.width, top: node.y, bottom: node.y + node.height };
            const overlap = lb.left < nb.right && lb.right > nb.left && lb.top < nb.bottom && lb.bottom > nb.top;
            assert.strictEqual(overlap, false, `label of edge ${edge.id} overlaps node card ${node.id}`);
          });
        });
      });
    },
  ],

  [
    'resolves label-label collisions so all bounding boxes are disjoint across dense routes',
    () => {
      const layout = computeLayout(clone(ADVERSARIAL_COLLISION_SPEC));
      const labeled = layout.edges.filter((e) => typeof e.labelX === 'number' && typeof e.labelWidth === 'number' && e.labelWidth > 0);
      for (let i = 0; i < labeled.length; i++) {
        for (let j = i + 1; j < labeled.length; j++) {
          const e1 = labeled[i];
          const e2 = labeled[j];
          const b1 = { left: e1.labelX - e1.labelWidth / 2, right: e1.labelX + e1.labelWidth / 2, top: e1.labelY - 9, bottom: e1.labelY + 9 };
          const b2 = { left: e2.labelX - e2.labelWidth / 2, right: e2.labelX + e2.labelWidth / 2, top: e2.labelY - 9, bottom: e2.labelY + 9 };
          const overlap = b1.left < b2.right && b1.right > b2.left && b1.top < b2.bottom && b1.bottom > b2.top;
          assert.strictEqual(overlap, false, `label collision between ${e1.id} and ${e2.id}`);
        }
      }
    },
  ],

  [
    'routes reciprocal edges along separate non-overlapping paths with disjoint labels',
    () => {
      const layout = computeLayout(clone(ADVERSARIAL_RECIPROCAL_SPEC));
      const e1 = layout.edges.find((e) => e.id === 'edge_forward');
      const e2 = layout.edges.find((e) => e.id === 'edge_backward');
      assert.ok(e1 && e2 && e1.points && e2.points);

      const p1 = cubicPointAt(0.5, e1.points, e1.controls);
      const p2 = cubicPointAt(0.5, e2.points, e2.controls);
      const separation = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      assert.ok(separation >= 16, `reciprocal edge paths overlap in transit: separation=${separation.toFixed(2)}px < 16px`);

      const b1 = { left: e1.labelX - e1.labelWidth / 2, right: e1.labelX + e1.labelWidth / 2, top: e1.labelY - 9, bottom: e1.labelY + 9 };
      const b2 = { left: e2.labelX - e2.labelWidth / 2, right: e2.labelX + e2.labelWidth / 2, top: e2.labelY - 9, bottom: e2.labelY + 9 };
      const overlap = b1.left < b2.right && b1.right > b2.left && b1.top < b2.bottom && b1.bottom > b2.top;
      assert.strictEqual(overlap, false, 'reciprocal edge labels must not overlap');

      const arrivalDist = Math.hypot(e1.points.x2 - e2.points.x1, e1.points.y2 - e2.points.y1);
      assert.ok(arrivalDist >= 8, 'reciprocal arrival and departure ports must not clash');
    },
  ],

  [
    'routes reciprocal edges along separate non-overlapping paths when IDs are omitted',
    () => {
      const spec = clone(ADVERSARIAL_RECIPROCAL_SPEC);
      delete spec.edges[0].id;
      delete spec.edges[1].id;
      const layout = computeLayout(spec);
      const e1 = layout.edges[0];
      const e2 = layout.edges[1];
      assert.ok(e1 && e2 && e1.points && e2.points);
      assert.strictEqual(e1.isReciprocal, true, 'first idless reciprocal edge must be marked reciprocal');
      assert.strictEqual(e2.isReciprocal, true, 'second idless reciprocal edge must be marked reciprocal');

      const p1 = cubicPointAt(0.5, e1.points, e1.controls);
      const p2 = cubicPointAt(0.5, e2.points, e2.controls);
      const separation = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      assert.ok(separation >= 16, `idless reciprocal edge paths overlap in transit: separation=${separation.toFixed(2)}px < 16px`);

      const b1 = { left: e1.labelX - e1.labelWidth / 2, right: e1.labelX + e1.labelWidth / 2, top: e1.labelY - 9, bottom: e1.labelY + 9 };
      const b2 = { left: e2.labelX - e2.labelWidth / 2, right: e2.labelX + e2.labelWidth / 2, top: e2.labelY - 9, bottom: e2.labelY + 9 };
      const overlap = b1.left < b2.right && b1.right > b2.left && b1.top < b2.bottom && b1.bottom > b2.top;
      assert.strictEqual(overlap, false, 'idless reciprocal edge labels must not overlap');

      const arrivalDist = Math.hypot(e1.points.x2 - e2.points.x1, e1.points.y2 - e2.points.y1);
      assert.ok(arrivalDist >= 8, 'idless reciprocal arrival and departure ports must not clash');
    },
  ],

  [
    'orders dense shared ports monotonically to prevent immediate crossing',
    () => {
      const layout = computeLayout(clone(ADVERSARIAL_DENSE_PORTS_SPEC));
      const eSink1 = layout.edges.find((e) => e.id === 'e_sink_1');
      const eSink5 = layout.edges.find((e) => e.id === 'e_sink_5');
      assert.ok(eSink1 && eSink5);

      const targetOrder = eSink1.points.y2 < eSink5.points.y2;
      const portOrder = eSink1.points.y1 < eSink5.points.y1;
      assert.strictEqual(portOrder, targetOrder, 'departure port order must match target arrival order to prevent port crossing');

      const arrivalPoints = new Set();
      layout.edges.forEach((edge) => {
        const key = `${Math.round(edge.points.x2)},${Math.round(edge.points.y2)}`;
        assert.strictEqual(arrivalPoints.has(key), false, `shared arrival port detected at ${key}`);
        arrivalPoints.add(key);
      });
    },
  ],

  [
    'route output exposes endpoint, path, segments, label anchor/bounds, terminal tangent, marker bounds, and total visual bounds',
    () => {
      const layout = computeLayout(clone(VALID_SPEC));
      layout.edges.forEach((edge) => {
        if (!edge.points) return;
        assert.ok(edge.endpoint && typeof edge.endpoint.x === 'number' && typeof edge.endpoint.y === 'number');
        assert.ok(typeof edge.path === 'string' && edge.path.startsWith('M '));
        assert.ok(Array.isArray(edge.segments) && edge.segments.length > 0);
        assert.ok(edge.labelAnchor && typeof edge.labelAnchor.x === 'number' && typeof edge.labelAnchor.y === 'number');
        assert.ok(edge.labelBounds && typeof edge.labelBounds.left === 'number' && typeof edge.labelBounds.width === 'number');
        assert.ok(edge.terminalTangent && typeof edge.terminalTangent.x === 'number' && typeof edge.terminalTangent.y === 'number' && typeof edge.terminalTangent.angle === 'number');
        assert.ok(edge.markerBounds && typeof edge.markerBounds.minX === 'number' && typeof edge.markerBounds.maxX === 'number');
        assert.ok(edge.totalVisualBounds && typeof edge.totalVisualBounds.minX === 'number' && typeof edge.totalVisualBounds.maxY === 'number');
      });
    },
  ],
  [
    'p4: band-aware fit clears cards and labels without shrinking desktop examples below 0.75',
    () => {
      const { compileArchitecture } = require('../src/engine/compiler.js');
      const source = fs.readFileSync(path.join(__dirname, '../src/workbench/scripts/fit.js'), 'utf8');
      for (const name of fs.readdirSync(path.join(__dirname, '../examples'))) {
        const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8'));
        const { layout } = compileArchitecture(spec);
        for (const [width, height] of [[1040, 806], [1024, 674]]) {
          const overlay = (left, top, w, h, isKey = false) => ({ hidden: false,
            matches: () => isKey, getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h }) });
          const elements = {
            '.lens-key': overlay(width - 262, 16, 246, 190, true),
            '.workbench-minimap': overlay(16, height - 132, 176, 116),
            '.viewport-controls': overlay(width - 58, height - 166, 38, 146),
          };
          const state = { collapsedBoundaries: new Set() };
          const context = vm.createContext({ LAYOUT_DATA: layout, ArchVizGeometry: geometry, state,
            svg: { getBoundingClientRect: () => ({ left: 0, top: 0, width, height }) },
            document: { querySelector: selector => elements[selector] }, getComputedStyle: () => ({ display: 'block' }),
            isNodeHidden: () => false, clampZoom: zoom => Math.max(0.15, Math.min(4, zoom)),
            actions: { setCamera: camera => Object.assign(state, camera) }, updateTransform() {} });
          vm.runInContext(source + '\nfitToScreen();', context);
          if (width === 1040) assert.ok(state.zoom >= 0.75, name + ': ' + state.zoom);
          const marks = layout.nodes.concat(layout.edges.filter(edge => edge.labelBounds)
            .map(edge => ({ x: edge.labelBounds.left, y: edge.labelBounds.top, width: edge.labelBounds.width, height: edge.labelBounds.height })));
          // The minimap hides once the diagram fits, so fitting may use the space under it.
          marks.forEach(mark => Object.entries(elements).filter(([selector]) => selector !== '.workbench-minimap').map(([, element]) => element).forEach(element => {
            const b = element.getBoundingClientRect();
            const a = { left: state.panX + mark.x * state.zoom, top: state.panY + mark.y * state.zoom };
            a.right = a.left + mark.width * state.zoom; a.bottom = a.top + mark.height * state.zoom;
            assert.ok(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom,
              name + ': a card or label overlaps an overlay');
          }));
        }
      }
    },
  ],

];

cases.push(['orthogonal layout is the default and widens overfull column gaps', () => {
  const spec = clone(ADVERSARIAL_DENSE_PORTS_SPEC);
  const narrow = computeDefaultLayout(spec, { layout: 'columns', boundaryGapX: 0 });
  const curved = computeLayout(spec, { boundaryGapX: 0 });
  assert.strictEqual(narrow.config.router, 'orthogonal');
  assert.strictEqual(narrow.routingStats.cardCrossings, 0);
  assert.ok(narrow.nodes.some(n => n.x > curved.nodes.find(c => c.id === n.id).x), 'overfull gap must widen');
  assert.ok(!narrow.routingStats.gapDemand, 'widening resolves track demand');
  narrow.boundaries.forEach(b => {
    const left = Math.min(...narrow.nodes.filter(n => n.boundary === b.id).map(n => n.x));
    assert.strictEqual(left - b.x, narrow.config.boundaryPaddingX, 'whole boundary moves with its columns');
  });
  assert.deepStrictEqual(narrow, computeDefaultLayout(spec, { layout: 'columns', boundaryGapX: 0 }));
}]);

cases.push(['auto selects the larger reference fit with LR winning ties', () => {
  const specs = [VALID_SPEC, ADVERSARIAL_RECIPROCAL_SPEC, ADVERSARIAL_DENSE_PORTS_SPEC,
    ADVERSARIAL_CLIPPED_BOUNDS_SPEC, ADVERSARIAL_SIBLING_SPEC, ADVERSARIAL_COLLISION_SPEC];
  for (const name of ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow']) {
    specs.push(JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8')));
  }
  const fit = ({ totalVisualBounds: b }) => Math.min(1040 / (b.width + 48), 806 / (b.height + 48), 1.4);
  for (const spec of specs) {
    for (const router of ['orthogonal', 'curved']) {
      const lr = computeDefaultLayout(spec, { layout: 'columns', direction: 'LR', router });
      const tb = computeDefaultLayout(spec, { layout: 'columns', direction: 'TB', router });
      const auto = computeDefaultLayout(spec, { layout: 'columns', direction: 'auto', router });
      assert.deepStrictEqual(auto, fit(tb) > fit(lr) ? tb : lr);
      assert.deepStrictEqual(auto, computeDefaultLayout(spec, { layout: 'columns', direction: 'auto', router }));
      auto.nodes.forEach(n => assert.deepStrictEqual([n.width, n.height], [220, 72]));
      if (router === 'orthogonal') assert.strictEqual(auto.routingStats.cardCrossings, 0);
    }
  }
  assert.throws(() => computeDefaultLayout(VALID_SPEC, { direction: 'diagonal' }), /direction/);
}]);

cases.push(['lanes share a full-width grid, keep spec ties, and contain every card', () => {
  const fixtures = require('./fixtures.js');
  const specs = Object.entries(fixtures).filter(([key]) => key.startsWith('ADVERSARIAL_')).map(([, value]) => value);
  for (const name of ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow']) {
    specs.push(JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8')));
  }
  specs.push({ boundaries: [{ id: 'z', type: 'container' }, { id: 'a', type: 'container' }],
    nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, boundary: i < 8 ? 'z' : 'a' })), edges: [] });
  for (const spec of specs) {
    const before = JSON.stringify(spec);
    const layout = computeDefaultLayout(spec);
    assert.strictEqual(layout.config.layout, 'lanes');
    assert.strictEqual(layout.config.direction, 'TB');
    assert.deepStrictEqual(layout, computeDefaultLayout(spec));
    assert.strictEqual(JSON.stringify(spec), before, 'input is immutable');
    const k = layout.boundaries[0].slotCount;
    layout.boundaries.forEach((b, i) => {
      assert.strictEqual(b.x, 24);
      assert.strictEqual(b.width, layout.boundaries[0].width);
      if (i) assert.strictEqual(b.y - layout.boundaries[i - 1].y - layout.boundaries[i - 1].height, 56);
      const members = layout.nodes.filter(n => n.boundary === b.id);
      assert.strictEqual(b.height, Math.max(1, Math.ceil(members.length / k)) * layout.config.nodeHeight + 48 + b.rowGaps.reduce((sum, gap) => sum + gap, 0));
      members.forEach(n => {
        assert.ok(n.x >= b.x + b.gutterWidth);
        assert.ok(n.x + n.width <= b.x + b.width && n.y >= b.y && n.y + n.height <= b.y + b.height);
        assert.strictEqual(n.x - b.x - 170, n.slot * (n.width + b.slotGap));
        assert.ok(n.slot < k);
      });
    });
    assert.strictEqual(layout.routingStats.cardCrossings, 0);
  }
  const tied = computeDefaultLayout(specs[specs.length - 1]);
  assert.deepStrictEqual(tied.boundaries.map(b => b.id), ['z', 'a']);
}]);

cases.push(['sparse lanes leave gaps that align connected cards', () => {
  const spec = { boundaries: [{ id: 'top', order: 0 }, { id: 'bottom', order: 1 }],
    nodes: [{ id: 'a', boundary: 'top' }, { id: 'b', boundary: 'top' }, { id: 'c', boundary: 'top' }, { id: 'd', boundary: 'bottom' }],
    edges: [{ id: 'link', source: 'c', target: 'd', label: 'call' }] };
  const layout = computeDefaultLayout(spec, { direction: 'LR' });
  assert.strictEqual(layout.nodes.find(n => n.id === 'd').slot, 2);
  assert.strictEqual(layout.edges[0].polyline.length, 2);
}]);

cases.push(['example labels display in full through the twenty-eight character limit', () => {
  assert.strictEqual(geometry.labelDisplayText('x'.repeat(28)), 'x'.repeat(28));
  assert.strictEqual(geometry.labelDisplayText('x'.repeat(29)), 'x'.repeat(27) + '…');
  for (const name of fs.readdirSync(path.join(__dirname, '../examples')).sort()) {
    const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8'));
    for (const edge of spec.edges) {
      const label = edge.label || edge.packetLabel || '';
      assert.strictEqual(geometry.labelDisplayText(label), label, `${name}/${edge.id}`);
    }
  }
}]);

cases.push(['saga preserves its three jumps and fourteen bends after label and port spreading', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/3-async-event-driven-workflow/architecture.json'), 'utf8'));
  const first = computeDefaultLayout(spec);
  assert.strictEqual(first.routingStats.cardCrossings, 0);
  assert(first.routingStats.crossings <= 3);
  assert.strictEqual(first.routingStats.bends, 14);
  assert.deepStrictEqual(computeDefaultLayout(spec), first);
}]);


cases.push(['lane row width maximizes canvas fit, with smaller widths winning ties', () => {
  for (const count of [9, 14, 24, 40]) {
    const spec = { nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}` })), edges: [] };
    const layout = computeDefaultLayout(spec);
    const lane = layout.boundaries[0];
    const scores = Array.from({ length: 4 }, (_, i) => {
      const slots = i + 4, rows = Math.ceil(count / slots);
      return { slots, zoom: Math.min(1040 / (194 + slots * 220 + (slots - 1) * 24 + 48),
        700 / (rows * 72 + 48 + (rows - 1) * 56 + 48), 1.4) };
    }).sort((a, b) => b.zoom - a.zoom || a.slots - b.slots);
    assert.strictEqual(lane.slotCount, scores[0].slots);
    assert(lane.slotCount >= 4 && lane.slotCount <= 7);
  }
}]);

cases.push(['lower rows retain neighbour-pulled slots instead of packing left', () => {
  const spec = { boundaries: [{ id: 'top', order: 0 }, { id: 'bottom', order: 1 }],
    nodes: [...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, boundary: 'top' })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, boundary: 'bottom' }))],
    edges: [{ id: 'pull', source: 'n4', target: 't3' }] };
  const layout = computeDefaultLayout(spec);
  const lower = layout.nodes.find(n => n.id === 'n4'), neighbor = layout.nodes.find(n => n.id === 't3');
  assert.strictEqual(lower.row, 1);
  assert.strictEqual(lower.slot, neighbor.slot);
  assert(lower.slot > 0);
}]);


cases.push(['dense orthogonal hubs fall back to curved routing in LR, auto and lanes', () => {
  for (const [layout, direction, count] of [['columns', 'LR', 10], ['columns', 'auto', 10], ['lanes', 'TB', 30]]) {
    const spec = { layout: { layout, direction }, boundaries: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
      nodes: [{ id: 'hub', boundary: 'a' }, ...Array.from({ length: count }, (_, i) => ({ id: `n${i}`, boundary: 'b' }))],
      edges: Array.from({ length: count }, (_, i) => ({ id: `e${i}`, source: 'hub', target: `n${i}` })) };
    const result = computeDefaultLayout(spec);
    assert.strictEqual(result.edges.length, count);
    assert(result.edges.every(e => e.path && !/NaN|Infinity/.test(e.path)));
    if (direction !== 'auto') {
      assert.strictEqual(result.config.router, 'curved');
      assert.match(result.routingFallback, /Too many ports/);
    }
  }
}]);

cases.push(['numeric lane order pins rows and slots despite reversed input and neighbour pulls', () => {
  const spec = { boundaries: [{ id: 'a', order: 0 }, { id: 'b', order: 1 }],
    nodes: [{ id: 'pull', boundary: 'a' }, ...[6, 5, 4, 3, 2, 1].map(order => ({ id: `n${order}`, boundary: 'b', order }))],
    edges: [{ id: 'pull-edge', source: 'pull', target: 'n6' }] };
  const layout = computeDefaultLayout(spec);
  const nodes = layout.nodes.filter(n => n.boundary === 'b').sort((a, b) => a.row - b.row || a.slot - b.slot);
  assert.deepStrictEqual(nodes.map(n => n.order), [1, 2, 3, 4, 5, 6]);
}]);

module.exports = { name: 'Layout Engine', cases };
