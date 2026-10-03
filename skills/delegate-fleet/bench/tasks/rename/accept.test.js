'use strict';
const test = require('node:test');
const assert = require('node:assert');
const pricing = require('../src/pricing.js');
const { receipt } = require('../src/format.js');

test('accept: computeOrderTotal replaces calcTotal', () => {
  assert.strictEqual(typeof pricing.computeOrderTotal, 'function');
  assert.strictEqual(pricing.calcTotal, undefined);
  assert.strictEqual(pricing.computeOrderTotal([{ sku: 'a', qty: 3, unitCents: 10 }]), 30);
  assert.strictEqual(receipt([{ sku: 'a', qty: 1, unitCents: 100 }], 0), 'a x1\ntotal 100');
});
