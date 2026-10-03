Two independent changes:
1. Add `formatCurrency(cents, currency)` to `src/format.js` and export it: `USD` gives `$12.34`, `EUR` gives `12,34 €`, negative amounts put a leading minus before everything (`-$0.05`), and any other currency throws a `RangeError`.
2. Add `lowStock(inventory, threshold)` to `src/inventory.js` and export it: return the SKUs whose quantity is strictly below `threshold`, sorted alphabetically.
Add tests for both and run `npm test`.
