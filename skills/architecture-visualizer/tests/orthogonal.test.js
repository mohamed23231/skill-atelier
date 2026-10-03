const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { routeOrthogonal, computeJumps } = require('../src/engine/orthogonal.js');
const { computeLayout } = require('../src/engine/layout.js');
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

function verify(layout, result, margin = 14, rounded = true) {
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
        const bottom = Math.min(boundary.y + Math.min(36, boundary.height), ...(members.length ? members.map(n => n.y) : [Infinity])) + margin;
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
      assert.equal(a.y, b.y);
      assert.equal(slot.y, a.y);
      assert.equal(slot.x, (a.x + b.x) / 2);
      assert(Math.abs(a.x - b.x) >= slot.width + 16);
      const box = slotBox(slot);
      layout.nodes.forEach(n => assert(!overlaps(box, cardBox(n, margin))));
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
            assert(route.jumps.some(jump => jump.x === c.x && jump.y === a.y && jump.segment === i), 'Crossing lacks a jump');
          }
        }
      }
    }
  }
  assert.equal(result.stats.bends, bends);
  assert.equal(result.stats.jumps, jumps);
  assert.equal(result.stats.crossings, jumps);
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
    assert.equal(result.routes.ab.points[0].y, 124);
    assert.equal(result.routes.ac.points[0].y, 136);
    verify(layout, result);
    const incoming = input([node('a', 0, 0), node('b', 0, 200), node('c', 300, 100, 1)], [edge('bc', 'b', 'c'), edge('ac', 'a', 'c')]);
    const routes = routeOrthogonal(incoming);
    assert.equal(routes.routes.ac.points.at(-1).y, 124);
    assert.equal(routes.routes.bc.points.at(-1).y, 136);
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
    assert.equal(result.routes.ab2.labelSlot, null);
    verify(layout, result);
    assert.equal(routeOrthogonal(layout, { labelWidths: { ab1: 1000, ab2: 1000 } }).routes.ab1.labelSlot, null);
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
    report.push(`${name}: ${JSON.stringify(result.stats)}`);
  });
  assert.equal(report.length, 3);
  console.log(report.join('\n'));
}]);

module.exports = { name: 'Orthogonal router', cases };
