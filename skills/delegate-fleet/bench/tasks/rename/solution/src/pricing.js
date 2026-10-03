'use strict';

/** Prices are integer cents. A line is { sku, qty, unitCents }. */

function computeOrderTotal(lines) {
  return lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
}

function calcTax(totalCents, rate) {
  return Math.round(totalCents * rate);
}

module.exports = { computeOrderTotal, calcTax };
