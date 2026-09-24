'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyDiscount } = require('../src/pricing.js');

test('accept: applyDiscount', () => {
  assert.strictEqual(applyDiscount(1000, 'SAVE10'), 900);
  assert.strictEqual(applyDiscount(1005, 'SAVE10'), 905);
  assert.strictEqual(applyDiscount(10000, 'SAVE20'), 8000);
  assert.strictEqual(applyDiscount(100000, 'SAVE20'), 95000);
  assert.strictEqual(applyDiscount(1000, 'FREESHIP'), 501);
  assert.strictEqual(applyDiscount(300, 'FREESHIP'), 0);
  assert.throws(() => applyDiscount(100, 'BOGUS'), /BOGUS/);
});
