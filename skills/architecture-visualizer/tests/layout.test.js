const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeLayout, buildEdgeGeometry, cubicPointAt, curveSanityScore, resolveLabelCollisions } = require('../src/engine/layout.js');
const geometry = require('../src/engine/geometry.js');
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
    'shaped nodes: endpoints land on the chevron, pill and cylinder outlines, not the bounding box',
    () => {
      // Chevron (queue/topic): backward edges arrive on the pointed right face.
      // With a port offset the outline sits left of the rectangular edge.
      const queue = { id: 'q', label: 'Q', type: 'topic', x: 100, y: 100, width: 200, height: 80 };
      const right1 = { id: 'r1', label: 'R1', type: 'service', x: 500, y: 40, width: 160, height: 70 };
      const g1 = buildEdgeGeometry(right1, queue, true, { targetPortOffset: 24 });
      assert.strictEqual(g1.points.targetFace, 'right');
      const chevronOutline = geometry.shapeRightX(queue, 24);
      assert.ok(
        chevronOutline < queue.x + queue.width - 5,
        `chevron outline at offset should recede from the rectangular edge (got ${chevronOutline}, rect edge ${queue.x + queue.width})`
      );
      assert.ok(
        Math.abs(g1.points.x2 - (chevronOutline + geometry.EDGE_END_GAP)) < 0.01,
        `chevron endpoint x=${g1.points.x2} does not sit one gap off the outline at ${chevronOutline}`
      );

      // Pill (actor): the right cap is a semicircle, so an off-centre backward
      // connection must land on the arc, not the corner of the bounding box.
      const actor = { id: 'a', label: 'A', type: 'actor', x: 400, y: 300, width: 120, height: 60 };
      const svcLeft = { id: 's', label: 'S', type: 'service', x: 0, y: 300, width: 160, height: 70 };
      const g2 = buildEdgeGeometry(svcLeft, actor, true, { targetPortOffset: 20 });
      assert.strictEqual(g2.points.targetFace, 'left');
      const pillOutline = geometry.shapeLeftX(actor, 20);
      assert.ok(pillOutline > actor.x + 5, `pill outline at offset should recede from the rectangular edge (got ${pillOutline})`);
      assert.ok(
        Math.abs(g2.points.x2 - (pillOutline - geometry.EDGE_END_GAP)) < 0.01,
        `pill endpoint x=${g2.points.x2} does not sit one gap off the outline at ${pillOutline}`
      );

      // Cylinder (database/storage): the domed top rises above the rectangular
      // top edge, so an off-centre top connection follows the dome.
      const db = { id: 'd', label: 'D', type: 'database', x: 100, y: 500, width: 180, height: 80 };
      const above = { id: 't', label: 'T', type: 'service', x: 120, y: 300, width: 160, height: 70 };
      const g3 = buildEdgeGeometry(above, db, false, { targetPortOffset: 40 });
      assert.strictEqual(g3.points.targetFace, 'top');
      const domeOutline = geometry.shapeTopY(db, 40);
      assert.ok(domeOutline > db.y + 1, `cylinder dome at offset should sit below the corner height (got ${domeOutline})`);
      assert.ok(
        Math.abs(g3.points.y2 - (domeOutline - geometry.EDGE_END_GAP)) < 0.01,
        `cylinder endpoint y=${g3.points.y2} does not sit one gap off the dome at ${domeOutline}`
      );
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
    'template.html defines WCAG AA contrast tokens and excludes dead accent-indigo',
    () => {
      const templatePath = path.join(__dirname, '../src/engine/template.html');
      const html = fs.readFileSync(templatePath, 'utf8');

      assert.strictEqual(html.includes('--accent-indigo'), false, 'dead --accent-indigo should be removed');
      assert.ok(html.includes('--text-dim: #8b9bb0;'), 'dark text-dim token should be #8b9bb0');
      assert.ok(html.includes('--text-dim: #64748b;'), 'light text-dim token should be #64748b');
      assert.ok(html.includes('--accent-blue: #0369a1;'), 'light accent-blue token should be #0369a1');
      assert.ok(html.includes('--accent-green: #047857;'), 'light accent-green token should be #047857');
      assert.ok(html.includes('--accent-amber: #b45309;'), 'light accent-amber token should be #b45309');
      assert.ok(html.includes('--accent-rose: #be123c;'), 'light accent-rose token should be #be123c');
      assert.ok(html.includes('--badge-tint: rgba(148, 163, 184, 0.15);'), 'dark badge-tint should be defined');
      assert.ok(html.includes('--badge-tint: #f1f5f9;'), 'light badge-tint should be defined');
      assert.ok(html.includes('border: 1px solid currentColor;'), 'badge-status should use currentColor border');
      assert.ok(html.includes('--border-node: #64748b;'), 'dark border-node should be #64748b');
      assert.ok(html.includes('--border-node: #7c8aa3;'), 'light border-node should be #7c8aa3');
    },
  ],

  [
    'template.html normalises boundary tier heights without mutating layout data',
    () => {
      const templatePath = path.join(__dirname, '../src/engine/template.html');
      const html = fs.readFileSync(templatePath, 'utf8');

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
    'template.html contains dvh fallbacks, responsive viewport rules, and debounced resize listener with userMovedView latch',
    () => {
      const templatePath = path.join(__dirname, '../src/engine/template.html');
      const html = fs.readFileSync(templatePath, 'utf8');

      assert.ok(html.includes('height: 100vh;\n      height: 100dvh;\n      width: 100%;'), 'body should use 100vh with 100dvh and 100% width');
      assert.ok(html.includes('height: calc(100vh - 56px);\n      height: calc(100dvh - 56px);'), 'canvas-container should use dvh fallback');
      assert.ok(html.includes('width: min(420px, 100vw);'), 'inspector drawer width should use min(420px, 100vw)');
      assert.ok(html.includes('right: calc(-1 * min(430px, 102vw));'), 'inspector drawer parked position should be responsive');
      assert.ok(html.includes('max-height: min(46vh, 320px);'), 'legend-box max-height should be clamped');
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
      const compiled = compileArchitecture(spec);
      const geometrySource = fs.readFileSync(path.join(__dirname, '../src/engine/geometry.js'), 'utf8');

      assert.ok(compiled.html.includes(geometrySource), 'generated HTML must contain the exact geometry runtime');

      const ctx = { Math, String, Number, Array, JSON, console };
      vm.createContext(ctx);
      const injected = compiled.html.slice(compiled.html.indexOf(geometrySource), compiled.html.indexOf(geometrySource) + geometrySource.length);
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

      const recipCompiled = compileArchitecture(clone(ADVERSARIAL_RECIPROCAL_SPEC));
      const makeEl = () => ({
        querySelector: () => makeEl(),
        querySelectorAll: () => [],
        getAttribute: () => '50',
        setAttribute: () => {},
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
];

module.exports = { name: 'Layout Engine', cases };
