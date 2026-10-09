// Any model, not just the examples: sixty generated specs of every shape must compile, lay out and
// route with the same guarantees the examples have.
const assert = require('assert');
const { generateSpec } = require('./spec-generator.js');
const { compileArchitecture } = require('../src/engine/compiler.js');
const { computeLayout } = require('../src/engine/layout.js');

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const overlap = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

// Reuse the property-test layouts for the additional channel/fit checks.
// The determinism case deliberately computes fresh layouts twice.
const propertyLayouts = new Map();

const cases = [
  ['generated specs of every shape compile into a page within the size budget', () => {
    SEEDS.forEach(seed => {
      const result = compileArchitecture(generateSpec(seed), {});
      const html = typeof result === 'string' ? result : result.html;
      assert.ok(html && html.includes('</html>'), `seed ${seed}: no page`);
      assert.ok(Buffer.byteLength(html) < 500 * 1024, `seed ${seed}: ${Buffer.byteLength(html)} bytes`);
    });
  }],
  ['generated specs route without card crossings, keep every card in its lane and labels apart', () => {
    SEEDS.forEach(seed => {
      const spec = generateSpec(seed);
      const layout = computeLayout(spec);
      propertyLayouts.set(seed, layout);
      assert.strictEqual(layout.routingStats.cardCrossings, 0, `seed ${seed}: a route crosses a card`);
      const lanes = new Map((layout.boundaries || []).map(b => [b.id, b]));
      layout.nodes.forEach(node => {
        const lane = lanes.get(node.boundary);
        if (!lane) return;
        assert.ok(node.x >= lane.x - 0.5 && node.x + node.width <= lane.x + lane.width + 0.5 && node.y >= lane.y - 0.5 && node.y + node.height <= lane.y + lane.height + 0.5,
          `seed ${seed}: ${node.id} leaves its lane`);
      });
      layout.nodes.forEach((a, i) => layout.nodes.slice(i + 1).forEach(b => {
        assert.ok(!overlap({ left: a.x, top: a.y, width: a.width, height: a.height }, { left: b.x, top: b.y, width: b.width, height: b.height }), `seed ${seed}: ${a.id} overlaps ${b.id}`);
      }));
      const labels = layout.edges.filter(edge => edge.labelBounds).map(edge => ({ id: edge.id, ...edge.labelBounds }));
      labels.forEach((a, i) => labels.slice(i + 1).forEach(b => assert.ok(!overlap(a, b), `seed ${seed}: labels ${a.id} and ${b.id} overlap`)));
      labels.forEach(label => layout.nodes.forEach(node => assert.ok(!overlap(label, { left: node.x, top: node.y, width: node.width, height: node.height }),
        `seed ${seed}: label ${label.id} covers ${node.id}`)));
    });
  }],
  ['generated specs use bounded CPU time and leave almost no label without room', () => {
    // Bound work done by this process; wall time also counts unrelated host contention.
    let slowest = 0;
    let unplaced = 0;
    SEEDS.forEach(seed => {
      const spec = generateSpec(seed);
      const started = process.cpuUsage();
      const layout = computeLayout(spec);
      const elapsed = process.cpuUsage(started);
      slowest = Math.max(slowest, (elapsed.user + elapsed.system) / 1000);
      unplaced += layout.edges.filter(edge => edge.label && !edge.labelBounds).length;
    });
    assert.ok(slowest < 1500, `slowest generated layout used ${Math.round(slowest)}ms CPU`);
    // A label with no clear room is left off the canvas (its tooltip and sheet still name it).
    assert.ok(unplaced <= 5, `${unplaced} labels found no room across ${SEEDS.length} specs`);
  }],
  ['generated specs lay out identically every time', () => {
    SEEDS.filter(seed => seed % 6 === 0).forEach(seed => {
      assert.deepStrictEqual(computeLayout(generateSpec(seed)), computeLayout(generateSpec(seed)), `seed ${seed}`);
    });
  }],
];


// Fit measured on the original four-column grid, including visual bounds and 48px fit padding.
const ORIGINAL_FIT = [
  0.637254902, 0.637254902, 0.802752294, 0.66603235, 0.798175599, 0.637254902, 0.626883665, 0.607831677, 0.637254902, 0.637254902,
  0.637254902, 0.612485277, 0.610149604, 1.220657277, 0.637254902, 0.637254902, 0.637254902, 1.220657277, 0.620802865, 0.500357398,
  0.637254902, 0.637254902, 0.637254902, 0.637254902, 0.837359098, 0.637254902, 0.637254902, 0.837359098, 0.637254902, 0.588730025,
  0.637254902, 0.620802865, 0.634287785, 1.005747126, 0.618403449, 0.667938931, 0.637254902, 0.802752294, 0.637254902, 0.837359098,
  0.667938931, 0.637254902, 0.637254902, 0.667938931, 0.607831677, 0.607831677, 1.005747126, 0.667938931, 1.346153846, 1.005747126,
  0.637254902, 1.220657277, 0.837359098, 0.637254902, 1.346153846, 0.637254902, 0.802752294, 0.637254902, 1.220657277, 0.637254902,
];
cases.push(['generated multi-row lanes improve fit and never double back through a row channel', () => {
  const zooms = [];
  SEEDS.forEach(seed => {
    const layout = propertyLayouts.get(seed) || computeLayout(generateSpec(seed));
    const bounds = layout.totalVisualBounds;
    const zoom = Math.min(1040 / (bounds.width + 48), 700 / (bounds.height + 48), 1.4);
    zooms.push(zoom);
    assert(zoom >= ORIGINAL_FIT[seed - 1] * 0.95, `seed ${seed}: fit regressed to ${zoom}`);
    if (seed === 9 || seed === 23) assert(zoom >= 0.7, `seed ${seed}: fit ${zoom}`);
    // Single-row seed 41 already lacks a label; require completeness for the affected multi-row layouts.
    if (layout.nodes.some(n => n.row > 0)) {
      layout.edges.forEach(edge => assert(edge.labelBounds, `seed ${seed}: missing label ${edge.id}`));
    }
    layout.boundaries.forEach(lane => {
      const members = layout.nodes.filter(n => n.boundary === lane.id);
      const rows = [...new Set(members.map(n => n.row))].sort((a, b) => a - b);
      rows.slice(1).forEach(row => {
        const top = Math.max(...members.filter(n => n.row === row - 1).map(n => n.y + n.height));
        const bottom = Math.min(...members.filter(n => n.row === row).map(n => n.y));
        layout.edges.forEach(edge => {
          const runs = edge.polyline.slice(1).flatMap((b, i) => {
            const a = edge.polyline[i];
            return a.y === b.y && a.y > top && a.y < bottom
              ? [[Math.max(lane.x + lane.gutterWidth, Math.min(a.x, b.x)), Math.min(lane.x + lane.width, Math.max(a.x, b.x))]] : [];
          });
          runs.forEach(([low, high], i) => runs.slice(i + 1).forEach(([otherLow, otherHigh]) => {
            assert(Math.max(low, otherLow) >= Math.min(high, otherHigh), `seed ${seed}: ${edge.id} doubles back in ${lane.id} row ${row} channel`);
          }));
        });
      });
    });
    assert.strictEqual(layout.routingStats.cardCrossings, 0, `seed ${seed}: card crossing`);
    layout.edges.forEach((edge, i) => layout.edges.slice(i + 1).forEach(other => {
      edge.polyline.slice(1).forEach((b, k) => other.polyline.slice(1).forEach((d, j) => {
        const a = edge.polyline[k], c = other.polyline[j];
        if ((a.y === b.y) === (c.y === d.y)) return;
        const horizontal = a.y === b.y ? [a, b] : [c, d];
        const vertical = a.y === b.y ? [c, d] : [a, b];
        const x = vertical[0].x, y = horizontal[0].y;
        if (x <= Math.min(horizontal[0].x, horizontal[1].x) || x >= Math.max(horizontal[0].x, horizontal[1].x)
          || y <= Math.min(vertical[0].y, vertical[1].y) || y >= Math.max(vertical[0].y, vertical[1].y)) return;
        assert([...edge.jumps, ...other.jumps].some(jump => Math.abs(jump.x - x) < 0.001 && Math.abs(jump.y - y) < 0.001),
          `seed ${seed}: ${edge.id}/${other.id} crossing has no jump`);
      }));
    }));
    layout.edges.filter(edge => edge.labelBounds).forEach(edge => {
      const label = edge.labelBounds;
      layout.edges.filter(other => other.id !== edge.id).forEach(other => {
        other.polyline.slice(1).forEach((b, i) => {
          const a = other.polyline[i];
          const crossing = a.y === b.y
            ? a.y > label.top && a.y < label.top + label.height && Math.max(a.x, b.x) > label.left && Math.min(a.x, b.x) < label.left + label.width
            : a.x > label.left && a.x < label.left + label.width && Math.max(a.y, b.y) > label.top && Math.min(a.y, b.y) < label.top + label.height;
          assert(!crossing, `seed ${seed}: label ${edge.id} covers ${other.id}`);
        });
      });
    });
  });
  zooms.sort((a, b) => a - b);
  assert((zooms[29] + zooms[30]) / 2 > 0.6372549019607843, 'median fit must improve');
  assert(zooms[0] >= 0.5003573981415297 * 0.95, 'minimum fit must stay within five percent');
}]);


cases.push(['generated node kinds are recognized by the validator', () => {
  const { VALID_NODE_TYPES } = require('../src/engine/validator.js');
  SEEDS.forEach(seed => generateSpec(seed).nodes.forEach(node => {
    assert(VALID_NODE_TYPES.has(node.type), `seed ${seed}: unsupported ${node.type}`);
  }));
}]);

cases.push(['every generated VERIFIED node has resolvable evidence', () => {
  SEEDS.forEach(seed => {
    const spec = generateSpec(seed);
    const evidence = new Set(spec.evidence.map(record => record.id));
    spec.nodes.filter(node => node.status === 'VERIFIED').forEach(node => {
      assert.ok(node.evidenceIds && node.evidenceIds.length, `seed ${seed}: ${node.id} lacks evidence`);
      node.evidenceIds.forEach(id => assert.ok(evidence.has(id), `seed ${seed}: missing ${id}`));
    });
  });
}]);

cases.push(['generated layout CPU budget ignores unrelated elapsed time', () => {
  const clock = process.hrtime.bigint;
  let calls = 0;
  // Simulate two seconds of host contention per wall-clock read without sleeping.
  process.hrtime.bigint = () => clock() + BigInt(calls++) * 2000000000n;
  try {
    cases.find(([name]) => name.includes('leave almost no label without room'))[1]();
  } finally { process.hrtime.bigint = clock; }
}]);

module.exports = { name: 'Generated Specs', cases };
