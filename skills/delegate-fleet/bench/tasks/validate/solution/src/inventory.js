'use strict';

/** An inventory is a plain object: { [sku]: quantity }. */

function createInventory() {
  return {};
}

function addItem(inventory, sku, qty) {
  if (typeof sku !== 'string' || sku.length === 0) throw new TypeError('sku must be a non-empty string');
  if (!Number.isInteger(qty) || qty <= 0) throw new RangeError('qty must be a positive integer');
  inventory[sku] = (inventory[sku] || 0) + qty;
  return inventory;
}

function removeItem(inventory, sku, qty) {
  const have = inventory[sku] || 0;
  if (qty > have) throw new RangeError(`only ${have} of ${sku} in stock`);
  inventory[sku] = have - qty;
  return inventory;
}

module.exports = { createInventory, addItem, removeItem };
