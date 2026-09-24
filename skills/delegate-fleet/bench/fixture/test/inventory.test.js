'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createInventory, addItem, removeItem } = require('../src/inventory.js');

test('add then remove', () => {
  const inv = addItem(createInventory(), 'a', 3);
  assert.strictEqual(removeItem(inv, 'a', 2).a, 1);
});
