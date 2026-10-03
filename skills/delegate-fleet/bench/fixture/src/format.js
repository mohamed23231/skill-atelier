'use strict';

const { calcTotal, calcTax } = require('./pricing.js');

function receipt(lines, taxRate) {
  const total = calcTotal(lines);
  const tax = calcTax(total, taxRate);
  return lines.map((l) => `${l.sku} x${l.qty}`).concat(`total ${total + tax}`).join('\n');
}

module.exports = { receipt };
