// Any model, not just the examples: sixty generated specs of every shape must compile, lay out and
// route with the same guarantees the examples have.
const assert = require('assert');
const { generateSpec } = require('./spec-generator.js');
const { compileArchitecture } = require('../src/engine/compiler.js');
const { computeLayout } = require('../src/engine/layout.js');

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);
const overlap = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

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
  ['generated specs lay out identically every time', () => {
    SEEDS.filter(seed => seed % 6 === 0).forEach(seed => {
      assert.deepStrictEqual(computeLayout(generateSpec(seed)), computeLayout(generateSpec(seed)), `seed ${seed}`);
    });
  }],
];

module.exports = { name: 'Generated Specs', cases };
