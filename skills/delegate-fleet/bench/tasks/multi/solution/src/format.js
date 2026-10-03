'use strict';

const { calcTotal, calcTax } = require('./pricing.js');

function receipt(lines, taxRate) {
  const total = calcTotal(lines);
  const tax = calcTax(total, taxRate);
  return lines.map((l) => `${l.sku} x${l.qty}`).concat(`total ${total + tax}`).join('\n');
}

function formatCurrency(cents, currency) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  if (currency === 'USD') return `${sign}$${whole}.${frac}`;
  if (currency === 'EUR') return `${sign}${whole},${frac} €`;
  throw new RangeError(`unsupported currency ${currency}`);
}

module.exports = { receipt, formatCurrency };
