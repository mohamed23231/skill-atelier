'use strict';

const { computeOrderTotal, calcTax } = require('./pricing.js');

function receipt(lines, taxRate) {
  const total = computeOrderTotal(lines);
  const tax = calcTax(total, taxRate);
  return lines.map((l) => `${l.sku} x${l.qty}`).concat(`total ${total + tax}`).join('\n');
}

module.exports = { receipt };
