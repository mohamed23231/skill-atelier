'use strict';

/** An inventory is a plain object: { [sku]: quantity }. */

function createInventory() {
  return {};
}

function addItem(inventory, sku, qty) {
  inventory[sku] = (inventory[sku] || 0) + qty;
  return inventory;
}

function removeItem(inventory, sku, qty) {
  const have = inventory[sku] || 0;
  if (qty > have) throw new RangeError(`only ${have} of ${sku} in stock`);
  inventory[sku] = have - qty;
  return inventory;
}

function lowStock(inventory, threshold) {
  return Object.keys(inventory).filter((sku) => inventory[sku] < threshold).sort();
}

module.exports = { createInventory, addItem, removeItem, lowStock };
