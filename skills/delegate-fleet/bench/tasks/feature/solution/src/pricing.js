'use strict';

/** Prices are integer cents. A line is { sku, qty, unitCents }. */

function calcTotal(lines) {
  return lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
}

function calcTax(totalCents, rate) {
  return Math.round(totalCents * rate);
}

function applyDiscount(totalCents, code) {
  if (code === 'SAVE10') return Math.round(totalCents * 0.9);
  if (code === 'SAVE20') return Math.round(totalCents - Math.min(totalCents * 0.2, 5000));
  if (code === 'FREESHIP') return Math.max(0, totalCents - 499);
  throw new Error(`unknown discount code ${code}`);
}

module.exports = { calcTotal, calcTax, applyDiscount };
