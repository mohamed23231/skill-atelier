'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatCurrency } = require('../src/format.js');
const { lowStock } = require('../src/inventory.js');

test('accept: formatCurrency', () => {
  assert.strictEqual(formatCurrency(1234, 'USD'), '$12.34');
  assert.strictEqual(formatCurrency(1234, 'EUR'), '12,34 €');
  assert.strictEqual(formatCurrency(-5, 'USD'), '-$0.05');
  assert.strictEqual(formatCurrency(0, 'USD'), '$0.00');
  assert.throws(() => formatCurrency(1, 'GBP'), RangeError);
});

test('accept: lowStock', () => {
  assert.deepStrictEqual(lowStock({ c: 1, a: 0, b: 5, d: 2 }, 2), ['a', 'c']);
  assert.deepStrictEqual(lowStock({}, 3), []);
});
