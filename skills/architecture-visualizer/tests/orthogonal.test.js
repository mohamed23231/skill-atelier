const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { routeOrthogonal, computeJumps } = require('../src/engine/orthogonal.js');
const { computeLayout: computeDefaultLayout } = require('../src/engine/layout.js');
const computeLayout = (spec, config = {}) => computeDefaultLayout(spec, { layout: 'columns', direction: 'LR', ...config });
const fixtures = require('./fixtures.js');

const node = (id, x, y, rank = 0) => ({ id, x, y, width: 100, height: 60, rank });
const edge = (id, source, target) => ({ id, source, target });
const input = (nodes, edges, boundaries = []) => ({ nodes, edges, boundaries });
const segments = route => route.points.slice(1).map((b, i) => [route.points[i], b, i]);
const crosses = (a, b, box) => a.y === b.y
  ? a.y > box.top && a.y < box.bottom && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right
  : a.x > box.left && a.x < box.right && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom;
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const cardBox = (n, margin = 0) => ({ left: n.x - margin, right: n.x + n.width + margin, top: n.y - margin, bottom: n.y + n.height + margin });
const slotBox = slot => ({ left: slot.x - slot.width / 2 - 8, right: slot.x + slot.width / 2 + 8, top: slot.y - 9, bottom: slot.y + 9 });

function verify(layout, result, margin = layout.config ? 12 : 14, rounded = true) {
  assert.equal(result.stats.cardCrossings, 0);
  const slots = [];
  let bends = 0;
  let jumps = 0;
  for (const e of layout.edges) {
    const route = result.routes[e.id];
    const source = layout.nodes.find(n => n.id === e.source);
    const target = layout.nodes.find(n => n.id === e.target);
    const first = route.points[0];
    const last = route.points[route.points.length - 1];
    assert.equal(first.x, source.x + source.width);
    assert.equal(last.x, route.kind === 'same-column' || route.kind === 'self' ? target.x + target.width : target.x);
    assert(first.y > source.y && first.y < source.y + source.height);
    assert(last.y > target.y && last.y < target.y + target.height);
    assert.equal(route.points[1].y, first.y);
    assert(route.points[1].x > first.x);
    assert.equal(route.points[route.points.length - 2].y, last.y);
    assert(route.kind === 'same-column' || route.kind === 'self'
      ? route.points[route.points.length - 2].x > last.x
      : route.points[route.points.length - 2].x < last.x);
    const parts = segments(route);
    parts.forEach(([a, b, i]) => {
      assert(a.x === b.x || a.y === b.y, `${e.id} has a diagonal segment`);
      assert(a.x !== b.x || a.y !== b.y);
      layout.boundaries.forEach(boundary => {
        const members = layout.nodes.filter(n => n.boundary === boundary.id);
        const bottom = Math.min(boundary.y + Math.min(layout.config?.boundaryHeaderHeight ?? 36, boundary.height), ...(members.length ? members.map(n => n.y) : [Infinity])) + margin;
        assert(!crosses(a, b, { left: boundary.x - margin, right: boundary.x + boundary.width + margin, top: boundary.y - margin, bottom }), `${e.id} crosses a boundary header`);
      });
      layout.nodes.forEach(n => {
        assert(!crosses(a, b, cardBox(n)), `${e.id} crosses card ${n.id}`);
        if ((i === 0 && n.id === e.source) || (i === parts.length - 1 && n.id === e.target)) return;
        assert(!crosses(a, b, cardBox(n, margin)), `${e.id} violates clearance at ${n.id}`);
      });
    });
    let routeBends = 0;
    for (let i = 1; i < parts.length; i++) {
      if ((parts[i - 1][0].y === parts[i - 1][1].y) !== (parts[i][0].y === parts[i][1].y)) routeBends++;
    }
    bends += routeBends;
    assert(route.points.length >= routeBends + 2);
    assert(route.path.startsWith(`M ${first.x} ${first.y}`));
    if (routeBends && rounded) assert(route.path.includes(' A '));
    jumps += route.jumps.length;
    if (route.labelSlot) {
      const slot = route.labelSlot;
      const [a, b] = parts[slot.segment];
      assert.equal(slot.height, 18);
      assert.equal(slot.orientation, a.y === b.y ? 'horizontal' : 'vertical');
      if (slot.orientation === 'horizontal') {
        assert.equal((slot.tether || slot).y, a.y);
        assert(slot.x >= Math.min(a.x, b.x) && slot.x <= Math.max(a.x, b.x));
      } else {
        assert.equal((slot.tether || slot).x, a.x);
        assert(slot.y >= Math.min(a.y, b.y) && slot.y <= Math.max(a.y, b.y));
      }
      const box = slotBox(slot);
      layout.nodes.forEach(n => assert(!overlaps(box, cardBox(n))));
      layout.boundaries.forEach(boundary => assert(!overlaps(box, {
        left: boundary.x, right: boundary.x + boundary.width,
        top: boundary.y, bottom: boundary.y + Math.min(layout.config?.boundaryHeaderHeight ?? 36, boundary.height)
      })));
      slots.forEach(other => assert(!overlaps(box, other)));
      slots.push(box);
    }
    for (const [a, b, i] of parts) {
      if (a.y !== b.y) continue;
      for (const other of Object.values(result.routes)) {
        if (other === route) continue;
        for (const [c, d] of segments(other)) {
          if (c.x !== d.x) continue;
          if (c.x > Math.min(a.x, b.x) && c.x < Math.max(a.x, b.x) && a.y > Math.min(c.y, d.y) && a.y < Math.max(c.y, d.y)) {
            // The horizontal route carries the bridge, unless the crossing sits at its end: then the vertical one does.
            assert(route.jumps.some(jump => jump.x === c.x && jump.y === a.y && jump.segment === i) || other.jumps.some(jump => jump.x === c.x && jump.y === a.y), 'Crossing lacks a jump');
          }
        }
      }
    }
  }
  assert.equal(result.stats.bends, bends);
  assert.equal(result.stats.jumps, jumps);
  assert.equal(result.stats.crossings, jumps);
}

function verifyPorts(layout, result) {
  const faces = new Map();
  layout.edges.forEach(e => {
    const route = result.routes[e.id];
    [[e.source, route.points[0]], [e.target, route.points.at(-1)]].forEach(([id, port]) => {
      const key = `${id}:${port.x}`;
      if (!faces.has(key)) faces.set(key, []);
      faces.get(key).push(port.y);
    });
  });
  faces.forEach(ports => {
    ports.sort((a, b) => a - b);
    ports.slice(1).forEach((y, i) => assert(y - ports[i] >= 8 - 1e-9, 'Ports must be distinct and at least 8px apart'));
  });
}

function verifyBackward(layout, result, margin = 14) {
  layout.edges.forEach(e => {
    const route = result.routes[e.id];
    if (route.kind !== 'backward') return;
    const source = layout.nodes.find(n => n.id === e.source);
    const target = layout.nodes.find(n => n.id === e.target);
    const involved = layout.nodes.filter(n => n.rank >= target.rank && n.rank <= source.rank);
    const height = Math.max(...involved.map(n => n.y + n.height)) - Math.min(...involved.map(n => n.y));
    const vertical = segments(route).reduce((sum, [a, b]) => sum + Math.abs(a.y - b.y), 0);
    const extra = vertical - Math.abs(route.points[0].y - route.points.at(-1).y);
    assert(extra <= height + 2 * margin + 1e-9, `${e.id} takes an excessive vertical detour`);
  });
}

const cases = [
  ['straight adjacent edge has no bends', () => {
    const layout = input([node('a', 0, 100), node('b', 300, 100, 1)], [edge('ab', 'a', 'b')]);
    const result = routeOrthogonal(layout);
    assert.deepEqual(result.routes.ab.points, [{ x: 100, y: 130 }, { x: 300, y: 130 }]);
    assert.equal(result.stats.bends, 0);
    verify(layout, result);
  }],
  ['offset adjacent edge has two bends', () => {
    const layout = input([node('a', 0, 100), node('b', 300, 200, 1)], [edge('ab', 'a', 'b')]);
    const result = routeOrthogonal(layout);
    assert.equal(result.stats.bends, 2);
    assert.equal(result.routes.ab.points[1].x, 200);
    verify(layout, result);
  }],
  ['shared source and target faces spread ordered ports', () => {
    const layout = input([node('a', 0, 100), node('b', 300, 0, 1), node('c', 300, 200, 1)], [edge('ac', 'a', 'c'), edge('ab', 'a', 'b')]);
    const result = routeOrthogonal(layout);
    assert.equal(result.routes.ab.points[0].y, 112);
    assert.equal(result.routes.ac.points[0].y, 148);
    verify(layout, result);
    const incoming = input([node('a', 0, 0), node('b', 0, 200), node('c', 300, 100, 1)], [edge('bc', 'b', 'c'), edge('ac', 'a', 'c')]);
    const routes = routeOrthogonal(incoming);
    assert.equal(routes.routes.ac.points.at(-1).y, 112);
    assert.equal(routes.routes.bc.points.at(-1).y, 148);
    verify(incoming, routes);
  }],
  ['spanning edge avoids a blocking card and boundary header', () => {
    const nodes = [node('a', 0, 100), node('block', 300, 100, 1), node('b', 600, 100, 2)];
    nodes[1].boundary = 'middle';
    const boundary = { id: 'middle', x: 280, y: 40, width: 140, height: 180 };
    const layout = input(nodes, [edge('ab', 'a', 'b')], [boundary]);
    const result = routeOrthogonal(layout);
    assert.equal(result.stats.bends, 4);
    assert(result.routes.ab.points.some(p => p.y >= 174 || p.y <= 26));
    segments(result.routes.ab).forEach(([a, b]) => assert(!crosses(a, b, { left: 266, right: 434, top: 26, bottom: 90 })));
    verify(layout, result);
  }],
  ['spanning edge uses a shorter free corridor between cards', () => {
    const layout = input([node('a', 0, 0), node('upper', 300, 0, 1), node('lower', 300, 120, 1), node('b', 600, 120, 2)], [edge('ab', 'a', 'b')]);
    const result = routeOrthogonal(layout);
    assert(result.routes.ab.points.some(p => p.x > 300 && p.y >= 74 && p.y <= 106));
    verify(layout, result);
  }],
  ['backward edge chooses the shorter exterior corridor', () => {
    const layout = input([node('a', 0, 100), node('block', 300, 100, 1), node('b', 600, 100, 2)], [edge('ba', 'b', 'a')]);
    const result = routeOrthogonal(layout);
    assert.equal(result.routes.ba.kind, 'backward');
    assert.equal(result.stats.bends, 4);
    const corridor = segments(result.routes.ba).find(([a, b]) => a.x > b.x && a.y === b.y);
    assert(corridor[0].y <= 86 || corridor[0].y >= 174);
    verify(layout, result);
  }],
  ['same-column edge loops to the right and self edge has separate ports', () => {
    const layout = input([node('a', 0, 100), node('b', 0, 200)], [edge('ab', 'a', 'b'), edge('aa', 'a', 'a')]);
    const result = routeOrthogonal(layout);
    assert.equal(result.routes.ab.kind, 'same-column');
    assert.equal(result.routes.aa.kind, 'self');
    assert.notEqual(result.routes.aa.points[0].y, result.routes.aa.points.at(-1).y);
    assert(result.routes.ab.points.some(p => p.x > 114));
    verify(layout, result);
  }],
  ['shared gap uses distinct centred tracks with configured spacing', () => {
    const layout = input([node('a', 0, 0), node('b', 0, 120), node('c', 300, 200, 1), node('d', 300, 320, 1)], [edge('ac', 'a', 'c'), edge('bd', 'b', 'd')]);
    const result = routeOrthogonal(layout, { trackSpacing: 16 });
    assert.equal(result.routes.ac.points[1].x, 192);
    assert.equal(result.routes.bd.points[1].x, 208);
    verify(layout, result);
  }],
  ['same-column routing clears siblings in a second physical column', () => {
    const nodes = [node('a', 0, 100), node('b', 150, 100), node('c', 0, 200), node('d', 150, 200)];
    const layout = input(nodes, [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('aa', 'a', 'a')]);
    const result = routeOrthogonal(layout, { trackSpacing: 6 });
    Object.values(result.routes).forEach(route => assert(route.points.some(p => p.x > 264)));
    verify(layout, result);
  }],
  ['custom spacing and clearance are respected without mutating input', () => {
    const layout = input([node('a', 0, 100), node('b', 300, 0, 1), node('c', 300, 200, 1)], [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]);
    const before = JSON.stringify(layout);
    const result = routeOrthogonal(layout, { margin: 20, portSpacing: 8, trackSpacing: 20, cornerRadius: 0, jumpRadius: 0 });
    assert.equal(result.routes.ac.points[0].y - result.routes.ab.points[0].y, 8);
    assert(!result.routes.ab.path.includes(' A '));
    assert.equal(JSON.stringify(layout), before);
    verify(layout, result, 20, false);
  }],
  ['proper crossing gets exactly one jump on the horizontal route', () => {
    const routes = {
      horizontal: { points: [{ x: 0, y: 50 }, { x: 100, y: 50 }], jumps: [{ x: -1, y: -1, segment: 0 }] },
      vertical: { points: [{ x: 50, y: 0 }, { x: 50, y: 100 }], jumps: [] }
    };
    assert.equal(computeJumps(routes), 1);
    assert.deepEqual(routes.horizontal.jumps, [{ x: 50, y: 50, segment: 0 }]);
    assert.deepEqual(routes.vertical.jumps, []);
    assert.equal(computeJumps(routes), 1);
    routes.vertical.points = [{ x: 100, y: 50 }, { x: 100, y: 100 }];
    assert.equal(computeJumps(routes), 0);
  }],
  ['jump paths use SVG semicircles with configurable radii', () => {
    const spec = computeLayout(fixtures.clone(fixtures.ADVERSARIAL_DENSE_PORTS_SPEC));
    const result = routeOrthogonal(spec, { jumpRadius: 3, cornerRadius: 4 });
    assert(result.stats.jumps > 0);
    Object.values(result.routes).filter(route => route.jumps.length).forEach(route => {
      assert(route.path.includes('A 3 3 0 0 '));
    });
    verify(spec, result);
  }],
  ['label slots fit straight segments and avoid cards and earlier slots', () => {
    const layout = input([node('a', 0, 100), node('b', 500, 100, 1)], [edge('ab1', 'a', 'b'), edge('ab2', 'a', 'b')]);
    const result = routeOrthogonal(layout, { labelWidths: { ab1: 120, ab2: 120 } });
    assert.equal(result.routes.ab1.labelSlot.width, 120);
    assert.equal(result.routes.ab2.labelSlot.width, 120);
    assert.notDeepEqual([result.routes.ab1.labelSlot.x, result.routes.ab1.labelSlot.y], [result.routes.ab2.labelSlot.x, result.routes.ab2.labelSlot.y]);
    verify(layout, result);
    assert.equal(routeOrthogonal(layout, { labelWidths: { ab1: 1000, ab2: 1000 } }).routes.ab1.labelSlot, null);
  }],
  ['short horizontal runs fall back to a vertical pill and slide clear of headers', () => {
    const nodes = [node('a', 0, 100), node('b', 180, 230, 1)];
    const layout = input(nodes, [{ ...edge('ab', 'a', 'b'), label: 'Transfer' }], [
      { id: 'header', x: 175, y: 170, width: 105, height: 150 }
    ]);
    const result = routeOrthogonal(layout, { labelWidths: { ab: 70 } });
    const slot = result.routes.ab.labelSlot;
    assert(slot);
    assert.equal(slot.orientation, 'vertical');
    verify(layout, result);
  }],
  ['ports span sixty percent with an eight pixel minimum', () => {
    const nodes = [node('a', 0, 200), ...Array.from({ length: 6 }, (_, i) => node(`b${i}`, 300, i * 100, 1))];
    const layout = input(nodes, nodes.slice(1).map(n => edge(`a${n.id}`, 'a', n.id)));
    const result = routeOrthogonal(layout);
    verifyPorts(layout, result);
    verify(layout, result);
    const pair = input([node('a', 0, 100), node('b', 300, 0, 1), node('c', 300, 200, 1)], [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')]);
    const routes = routeOrthogonal(pair).routes;
    assert.equal(routes.ac.points[0].y - routes.ab.points[0].y, 0.6 * 60);
  }],
  ['backward routing ignores distant columns and uses a free gap between cards', () => {
    const layout = input([
      node('far', 0, -1000), node('a', 300, 100, 1), node('lowerA', 300, 260, 1),
      node('b', 600, 200, 2), node('lowerB', 600, 360, 2)
    ], [edge('ba', 'b', 'a')]);
    const result = routeOrthogonal(layout);
    verify(layout, result);
    verifyBackward(layout, result);
    const corridor = segments(result.routes.ba).find(([a, b]) => a.x > b.x && a.y === b.y);
    assert(corridor[0].y >= 174 && corridor[0].y <= 186);
  }],
  ['six tracks in a narrow gap report width demand without losing clearance', () => {
    const nodes = Array.from({ length: 6 }, (_, i) => node(`a${i}`, 0, i * 100));
    nodes.push(...Array.from({ length: 6 }, (_, i) => node(`b${i}`, 220, i * 100 + 30, 1)));
    const layout = input(nodes, Array.from({ length: 6 }, (_, i) => edge(`e${i}`, `a${i}`, `b${i}`)));
    const result = routeOrthogonal(layout, { trackSpacing: 20 });
    assert.deepEqual(result.stats.gapDemand, { 0: 128 });
    verify(layout, result);
    verifyPorts(layout, result);
    assert.deepEqual(routeOrthogonal(layout, { trackSpacing: 20 }), result);
    const fitting = routeOrthogonal(layout);
    assert.equal(fitting.stats.gapDemand, undefined);
    verify(layout, fitting);
  }],
  ['routing is deterministic even when input arrays are reordered', () => {
    const layout = computeLayout(fixtures.clone(fixtures.ADVERSARIAL_DENSE_PORTS_SPEC));
    const result = routeOrthogonal(layout);
    assert.deepEqual(routeOrthogonal(layout), result);
    assert.deepEqual(routeOrthogonal({ ...layout, nodes: [...layout.nodes].reverse(), edges: [...layout.edges].reverse(), boundaries: [...layout.boundaries].reverse() }), result);
  }],
  ['standalone module exposes its browser UMD API', () => {
    const sandbox = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/engine/orthogonal.js'), 'utf8'), sandbox);
    assert.equal(typeof sandbox.ArchVizOrthogonal.routeOrthogonal, 'function');
    assert.equal(typeof sandbox.ArchVizOrthogonal.computeJumps, 'function');
  }],
  ['empty edges produce empty routes and zero stats', () => {
    assert.deepEqual(routeOrthogonal(input([], [])), { routes: {}, stats: { cardCrossings: 0, crossings: 0, jumps: 0, bends: 0 } });
  }]
];

Object.keys(fixtures).filter(name => name.startsWith('ADVERSARIAL_')).sort().forEach(name => {
  cases.push([`${name} preserves ports, clearance, axis alignment and crossing jumps`, () => {
    const layout = computeLayout(fixtures.clone(fixtures[name]));
    verify(layout, routeOrthogonal(layout));
  }]);
});

cases.push(['all architecture examples preserve routing invariants', () => {
  const examples = path.join(__dirname, '../examples');
  const report = [];
  fs.readdirSync(examples).sort().forEach(name => {
    const file = path.join(examples, name, 'architecture.json');
    if (!fs.existsSync(file)) return;
    const layout = computeLayout(JSON.parse(fs.readFileSync(file, 'utf8')));
    const result = routeOrthogonal(layout);
    verify(layout, result);
    verifyPorts(layout, result);
    verifyBackward(layout, result);
    const minY = Math.min(...layout.nodes.map(n => n.y));
    Object.values(result.routes).filter(route => route.kind === 'backward').forEach(route => {
      assert(Math.min(...route.points.map(p => p.y)) >= minY - 28);
    });
    const labelled = layout.edges.filter(e => e.label || e.packetLabel);
    const placed = labelled.filter(e => result.routes[e.id].labelSlot);
    assert.equal(placed.length, labelled.length, `${name} has missing labels`);
    report.push(`${name}: bends=${result.stats.bends}, crossings=${result.stats.crossings}, jumps=${result.stats.jumps}, labels=${placed.length}/${labelled.length}, gapDemand=${JSON.stringify(result.stats.gapDemand || {})}`);
  });
  assert.equal(report.length, 3);
  console.log(report.join('\n'));
}]);

cases.push(['compact example cards leave a straight 12px marker approach in both directions', () => {
  const examples = path.join(__dirname, '../examples');
  for (const name of fs.readdirSync(examples).sort()) {
    const file = path.join(examples, name, 'architecture.json');
    if (!fs.existsSync(file)) continue;
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const direction of ['LR', 'TB']) {
      const layout = computeLayout(spec, { direction });
      for (const e of layout.edges) {
        // Measure the actual final line after all corner and jump arcs,
        // including the workbench's endpoint gap, rather than the raw route.
        const commands = e.path.match(/[MLA] [^MLA]+/g);
        assert(commands.at(-1).startsWith('L '));
        const endpoint = command => command.trim().split(/\s+/).slice(-2).map(Number);
        const [x1, y1] = endpoint(commands.at(-2));
        const [x2, y2] = endpoint(commands.at(-1));
        assert(Math.hypot(x2 - x1, y2 - y1) >= 12 - 1e-8,
          `${name}/${direction}/${e.id} needs a straight marker approach`);
        assert(Math.abs(e.terminalTangent.x * (y2 - y1) - e.terminalTangent.y * (x2 - x1)) < 1e-8);
        assert(e.terminalTangent.x * (x2 - x1) + e.terminalTangent.y * (y2 - y1) > 0);
      }
    }
  }
}]);

cases.push(['integrated layouts preserve routes, slots, jumps and bounds across examples and adversarial fixtures', () => {
  const specs = Object.entries(fixtures).filter(([name]) => name.startsWith('ADVERSARIAL_'));
  const examples = path.join(__dirname, '../examples');
  fs.readdirSync(examples).sort().forEach(name => {
    const file = path.join(examples, name, 'architecture.json');
    if (fs.existsSync(file)) specs.push([name, JSON.parse(fs.readFileSync(file, 'utf8'))]);
  });
  for (const [name, spec] of specs) {
    for (const direction of ['LR', 'TB', 'auto']) {
      const layout = computeLayout(spec, { direction });
      assert.deepEqual(layout, computeLayout(spec, { direction }), `${name} is deterministic`);
      assert.equal(layout.routingStats.cardCrossings, 0);
      if (direction === 'LR') verify(layout, routeOrthogonal(layout, { labelWidths: Object.fromEntries(layout.edges.map(e => [e.id, e.labelWidth])) }));
      const labels = [];
      for (const e of layout.edges) {
        assert(!/[CQ]/.test(e.path), 'routing uses only lines and arcs');
        if (e.labelWidth > 0) {
          assert(e.labelSlot, `${name}/${direction}/${e.id} needs a label slot`);
          layout.nodes.forEach(n => assert(!overlaps(e.labelBounds, cardBox(n))));
          labels.forEach(box => assert(!overlaps(e.labelBounds, box)));
          labels.push(e.labelBounds);
        }
        e.polyline.forEach(p => {
          assert(p.x >= e.pathBounds.minX && p.x <= e.pathBounds.maxX);
          assert(p.y >= e.pathBounds.minY && p.y <= e.pathBounds.maxY);
        });
        assert.equal(e.points.x2, e.endpoint.x);
        assert.equal(e.points.y2, e.endpoint.y);
        const target = layout.nodes.find(n => n.id === e.target);
        const shape = require('../src/engine/geometry.js');
        const face = e.points.targetFace;
        const outline = face === 'left' ? shape.shapeLeftX(target, e.endpoint.y - target.y - target.height / 2)
          : face === 'right' ? shape.shapeRightX(target, e.endpoint.y - target.y - target.height / 2)
          : face === 'top' ? shape.shapeTopY(target, e.endpoint.x - target.x - target.width / 2)
          : shape.shapeBottomY(target, e.endpoint.x - target.x - target.width / 2);
        assert(Math.abs(Math.abs((face === 'left' || face === 'right' ? e.endpoint.x : e.endpoint.y) - outline) - shape.EDGE_END_GAP) < 1e-8);
        const previous = e.polyline[e.polyline.length - 2];
        assert.equal(e.terminalTangent.x, e.endpoint.x - previous.x);
        assert.equal(e.terminalTangent.y, e.endpoint.y - previous.y);
      }
    }
  }
}]);

cases.push(['browser drag reroutes all edges with the same geometry as Node', () => {
  const layout = computeLayout(fixtures.clone(fixtures.ADVERSARIAL_DENSE_PORTS_SPEC));
  const paths = new Map();
  const ctx = {
    LAYOUT_DATA: layout,
    nodeById: new Map(layout.nodes.map(n => [n.id, n])),
    document: { getElementById: id => id.startsWith('path-')
      ? { setAttribute: (key, value) => paths.set(id, value) } : null }
  };
  vm.createContext(ctx);
  for (const file of ['engine/geometry.js', 'engine/orthogonal.js', 'workbench/scripts/drag.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ctx);
  }
  ctx.estimateLabelWidth = ctx.ArchVizGeometry.estimateLabelWidth;
  const before = layout.edges.map(e => e.path);
  layout.nodes.find(n => n.id === 'hub').y += 35;
  ctx.recalculateNodeEdges('hub');
  assert.equal(layout.routingStats.cardCrossings, 0);
  assert(layout.edges.some((e, i) => e.path !== before[i]));
  assert.equal(paths.size, layout.edges.length, 'every edge path must update');
  const widths = Object.fromEntries(layout.edges.map(e => [e.id, e.labelWidth]));
  const result = routeOrthogonal(layout, { labelWidths: widths });
  const geometry = require('../src/engine/geometry.js');
  const { buildRouteGeometry } = require('../src/engine/orthogonal.js');
  layout.edges.forEach(e => {
    const expected = buildRouteGeometry(result.routes[e.id], widths[e.id], geometry,
      { source: ctx.nodeById.get(e.source), target: ctx.nodeById.get(e.target) });
    assert.equal(paths.get('path-' + e.id), expected.path);
    assert.equal(JSON.stringify(e.polyline), JSON.stringify(expected.polyline));
    assert.equal(JSON.stringify(e.labelBounds), JSON.stringify(expected.labelBounds));
  });
}]);

cases.push(['browser lane drag uses the same routes and labels as Node', () => {
  const layout = computeDefaultLayout(fixtures.clone(fixtures.ADVERSARIAL_DENSE_PORTS_SPEC));
  const ctx = { LAYOUT_DATA: layout, nodeById: new Map(layout.nodes.map(n => [n.id, n])),
    document: { getElementById: () => null } };
  vm.createContext(ctx);
  for (const file of ['engine/geometry.js', 'engine/orthogonal.js', 'workbench/scripts/drag.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ctx);
  }
  ctx.estimateLabelWidth = ctx.ArchVizGeometry.estimateLabelWidth;
  const before = layout.edges.map(e => e.path);
  layout.nodes.find(n => n.id === 'hub').x += 35;
  ctx.recalculateNodeEdges('hub');
  assert.equal(layout.routingStats.cardCrossings, 0);
  assert(layout.edges.some((e, i) => e.path !== before[i]));
  const widths = Object.fromEntries(layout.edges.map(e => [e.id, e.labelWidth]));
  const result = routeOrthogonal(layout, { direction: 'TB', labelWidths: widths });
  const { buildRouteGeometry } = require('../src/engine/orthogonal.js');
  const geometry = require('../src/engine/geometry.js');
  layout.edges.forEach(e => {
    const expected = buildRouteGeometry(result.routes[e.id], widths[e.id], geometry,
      { source: ctx.nodeById.get(e.source), target: ctx.nodeById.get(e.target) });
    assert.equal(e.path, expected.path);
    assert.equal(JSON.stringify(e.labelBounds), JSON.stringify(expected.labelBounds));
  });
}]);

cases.push(['lane routes clear every card and gutter, pack every label, and stay deterministic', () => {
  const specs = Object.entries(fixtures).filter(([key]) => key.startsWith('ADVERSARIAL_'));
  for (const name of ['1-crud-business-feature', '2-complex-database-migration', '3-async-event-driven-workflow']) {
    specs.push([name, JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8'))]);
  }
  for (const [name, spec] of specs) {
    const layout = computeDefaultLayout(spec);
    const widths = Object.fromEntries(layout.edges.map(e => [e.id, e.labelWidth]));
    const result = routeOrthogonal(layout, { direction: 'TB', labelWidths: widths });
    assert.deepStrictEqual(result, routeOrthogonal(layout, { direction: 'TB', labelWidths: widths }));
    assert.equal(result.stats.cardCrossings, 0, name);
    const labels = [];
    for (const edge of layout.edges) {
      const route = result.routes[edge.id];
      for (const [a, b] of segments(route)) {
        assert(a.x === b.x || a.y === b.y, name);
        layout.nodes.forEach(n => assert(!crosses(a, b, cardBox(n)), `${name}/${edge.id}/${n.id}`));
        layout.boundaries.forEach(lane => assert(!crosses(a, b, { left: lane.x, right: lane.x + lane.gutterWidth,
          top: lane.y, bottom: lane.y + lane.height }), `${name}/${edge.id}/gutter`));
      }
      if (edge.labelWidth > 0) {
        assert(edge.labelSlot, `${name}/${edge.id} label`);
        layout.nodes.forEach(n => assert(!overlaps(edge.labelBounds, cardBox(n)), `${name}/${edge.id} label/card`));
        labels.forEach(box => assert(!overlaps(edge.labelBounds, box), `${name}/${edge.id} label/label`));
        layout.boundaryHeaderBoxes.forEach(b => assert(!overlaps(edge.labelBounds,
          { left: b.x, right: b.x + b.width, top: b.y, bottom: b.y + b.height })));
        labels.push(edge.labelBounds);
      }
    }
    const jumps = Object.values(result.routes).reduce((sum, route) => sum + route.jumps.length, 0);
    assert.equal(jumps, result.stats.crossings);
    if (name.startsWith('3-')) {
      const short = layout.edges.filter(e => e.polyline.length <= 4).length;
      const straight = layout.edges.filter(e => e.polyline.length === 2).length;
      assert(short / layout.edges.length >= 0.6, `${short}/${layout.edges.length} short`);
      assert(straight >= 4, `${straight} straight`);
    }
  }
}]);

cases.push(['example and adversarial labels clear every other connection', () => {
  const specs = Object.entries(fixtures).filter(([name]) => name.startsWith('ADVERSARIAL_'));
  for (const name of fs.readdirSync(path.join(__dirname, '../examples')).sort()) {
    specs.push([name, JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8'))]);
  }
  for (const [name, spec] of specs) {
    const layout = computeDefaultLayout(fixtures.clone(spec));
    for (const edge of layout.edges) {
      assert(edge.labelSlot, `${name}/${edge.id} needs a label`);
      for (const other of layout.edges) {
        if (other.id === edge.id) continue;
        for (let i = 1; i < other.polyline.length; i++) {
          assert(!crosses(other.polyline[i - 1], other.polyline[i], edge.labelBounds), `${name}/${edge.id} label crosses ${other.id}`);
        }
      }
    }
  }
}]);

cases.push(['lane face ports span sixty percent and overlapping channel runs stay fourteen pixels apart', () => {
  const specs = Object.entries(fixtures).filter(([name]) => name.startsWith('ADVERSARIAL_'));
  for (const name of fs.readdirSync(path.join(__dirname, '../examples')).sort()) {
    specs.push([name, JSON.parse(fs.readFileSync(path.join(__dirname, '../examples', name, 'architecture.json'), 'utf8'))]);
  }
  for (const [name, spec] of specs) {
    const layout = computeDefaultLayout(fixtures.clone(spec));
    const result = routeOrthogonal(layout, { direction: 'TB', labelWidths: Object.fromEntries(layout.edges.map(e => [e.id, e.labelWidth])) });
    const faces = new Map();
    const channels = [];
    for (const edge of layout.edges) {
      const points = result.routes[edge.id].points;
      for (const [id, p] of [[edge.source, points[0]], [edge.target, points.at(-1)]]) {
        const n = layout.nodes.find(n => n.id === id);
        const horizontalFace = p.y === n.y || p.y === n.y + n.height;
        const key = `${id}:${horizontalFace ? p.y : p.x}`;
        if (!faces.has(key)) faces.set(key, { size: horizontalFace ? n.width : n.height, positions: [] });
        faces.get(key).positions.push(horizontalFace ? p.x : p.y);
      }
      for (let i = 1; i < points.length - 2; i++) {
        const a = points[i], b = points[i + 1];
        const horizontal = a.y === b.y;
        channels.push({ id: edge.id, horizontal, fixed: horizontal ? a.y : a.x, low: Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y), high: Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y) });
      }
    }
    faces.forEach(({ size, positions }) => {
      if (positions.length >= 2) assert(Math.max(...positions) - Math.min(...positions) >= size * 0.6 - 1e-8, `${name}: port span`);
    });
    channels.forEach((a, i) => channels.slice(i + 1).forEach(b => {
      if (a.id === b.id || a.horizontal !== b.horizontal || Math.max(a.low, b.low) >= Math.min(a.high, b.high)) return;
      const separation = Math.abs(a.fixed - b.fixed);
      assert(separation >= 14 - 1e-8, `${name}: parallel channel separation ${separation}`);
    }));
  }
}]);


cases.push(['multi-row lane links approach lower rows from above and upper rows from below', () => {
  const nodes = [
    { ...node('a', 194, 48), width: 220, height: 72, boundary: 'lane', row: 0 },
    { ...node('b', 446, 204), width: 220, height: 72, boundary: 'lane', row: 1 },
    { ...node('c', 698, 48), width: 220, height: 72, boundary: 'lane', row: 0 },
  ];
  for (const [source, target] of [['a', 'b'], ['b', 'c']]) {
    const layout = { config: { layout: 'lanes', nodeGapX: 24, nodeGapY: 24 }, nodes,
      boundaries: [{ id: 'lane', x: 24, y: 24, width: 918, height: 276, gutterWidth: 150 }],
      edges: [edge('link', source, target)] };
    const result = routeOrthogonal(layout, { direction: 'TB' });
    assert.strictEqual(result.stats.cardCrossings, 0);
    const route = result.routes.link;
    assert(route.labelSlot);
    const from = nodes.find(n => n.id === source), to = nodes.find(n => n.id === target);
    const sign = Math.sign(to.y - from.y);
    assert.strictEqual(route.points[0].y, from.y + (sign > 0 ? from.height : 0));
    assert.strictEqual(route.points.at(-1).y, to.y + (sign > 0 ? 0 : to.height));
    route.points.slice(1).forEach((p, i) => assert((p.y - route.points[i].y) * sign >= 0, 'route progresses through rows monotonically'));
    assert.deepStrictEqual(result, routeOrthogonal(layout, { direction: 'TB' }));
  }
}]);


cases.push(['local links in a packed lane use an internal row channel for their labels', () => {
  const layout = computeDefaultLayout({ nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}` })),
    edges: [{ id: 'local', source: 'n0', target: 'n1', label: 'Read inventory' }] });
  const from = layout.nodes.find(n => n.id === 'n0'), to = layout.nodes.find(n => n.id === 'n1');
  assert.strictEqual(from.row, to.row);
  assert.strictEqual(layout.routingStats.cardCrossings, 0);
  assert(layout.edges[0].labelBounds);
  assert.strictEqual(layout.edges[0].polyline[0].y, from.y + from.height);
  const end = layout.edges[0].polyline.at(-1);
  // The workbench trims the target by ten pixels for its marker.
  assert(end.y > to.y + to.height);
}]);


cases.push(['vertical jump carriers bridge crossings in both travel directions', () => {
  const { buildRouteGeometry } = require('../src/engine/orthogonal.js');
  const geometry = require('../src/engine/geometry.js');
  for (const reverse of [false, true]) {
    const routes = {
      h: { points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] },
      v: { points: reverse ? [{ x: 10, y: 100 }, { x: 10, y: 0 }] : [{ x: 10, y: 0 }, { x: 10, y: 100 }] },
    };
    assert.strictEqual(computeJumps(routes), 1);
    assert.strictEqual(routes.v.jumps.length, 1);
    const result = buildRouteGeometry(routes.v, 0, geometry);
    assert.ok(result.path.includes(reverse ? 'L 10 55 A 5 5 0 0 0 10 45' : 'L 10 45 A 5 5 0 0 1 10 55'), result.path);
  }
}]);

module.exports = { name: 'Orthogonal router', cases };
