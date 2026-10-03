'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { receipt } = require('../src/format.js');

test('receipt lists lines and a taxed total', () => {
  assert.strictEqual(receipt([{ sku: 'a', qty: 2, unitCents: 100 }], 0.1), 'a x2\ntotal 220');
});
