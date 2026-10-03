'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { computeOrderTotal, calcTax } = require('../src/pricing.js');

test('total sums lines', () => {
  assert.strictEqual(computeOrderTotal([{ sku: 'a', qty: 2, unitCents: 150 }, { sku: 'b', qty: 1, unitCents: 99 }]), 399);
});

test('tax rounds to cents', () => {
  assert.strictEqual(calcTax(399, 0.2), 80);
});
