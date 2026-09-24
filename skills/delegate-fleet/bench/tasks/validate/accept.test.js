'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInventory, addItem } = require('../src/inventory.js');

test('accept: addItem validates its input', () => {
  assert.throws(() => addItem(createInventory(), '', 1), TypeError);
  assert.throws(() => addItem(createInventory(), 7, 1), TypeError);
  for (const bad of [0, -1, 1.5, NaN, '2']) assert.throws(() => addItem(createInventory(), 'a', bad), RangeError);
  assert.strictEqual(addItem(addItem(createInventory(), 'a', 2), 'a', 3).a, 5);
});
