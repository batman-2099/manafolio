// Split a total into cent-denominated entry shares. Cumulative boundaries keep
// every share nonnegative and the rounded total exact, including tiny totals.
// Weighted falls back to equal when no positive finite market values exist.
function splitPrice(prices, total, method = 'weighted') {
  if (!Number.isFinite(total) || total < 0 || !Number.isSafeInteger(Math.round(total * 100))) {
    throw new RangeError('total must be a finite non-negative cent amount');
  }
  if (prices.length === 0) return [];
  const cents = Math.round(total * 100);
  const values = prices.map(p => Number.isFinite(p) && p > 0 ? p : 0);
  const max = Math.max(...values);
  const weights = values.map(p => method === 'weighted' && max > 0 ? p / max : 1);
  const sum = weights.reduce((s, p) => s + p, 0);
  let cumulative = 0;
  let allocated = 0;
  return weights.map((weight, i) => {
    cumulative += weight;
    const boundary = i === weights.length - 1 ? cents : Math.min(cents, Math.floor(cents * (cumulative / sum)));
    const share = boundary - allocated;
    allocated = boundary;
    return share / 100;
  });
}

module.exports = { splitPrice };

if (require.main === module) {
  const assert = require('assert');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const sums = (arr, t) => near(arr.reduce((s, x) => s + x, 0), t);

  // Equal split, clean division.
  assert.deepStrictEqual(splitPrice([1, 1, 1], 30, 'equal'), [10, 10, 10]);
  // Equal split with a remainder — drift lands on the last card, parts sum to total.
  const eq = splitPrice([0, 0, 0], 10, 'equal');
  assert.ok(sums(eq, 10), 'equal parts sum to total');
  assert.deepStrictEqual(eq, [3.33, 3.33, 3.34]);
  // Weighted: a $50 pack, one $45 chase card, rest bulk.
  const w = splitPrice([45, 4, 1], 50, 'weighted');
  assert.ok(sums(w, 50), 'weighted parts sum to total');
  assert.ok(w[0] > w[1] && w[1] > w[2], 'weighted follows value order');
  // Weighted with no market data falls back to equal.
  assert.ok(sums(splitPrice([0, 0], 9, 'weighted'), 9), 'weighted fallback sums to total');
  // Single card gets the whole total.
  assert.deepStrictEqual(splitPrice([5], 12.5, 'weighted'), [12.5]);
  for (const method of ['equal', 'weighted']) {
    const tiny = splitPrice([1, 1, 1, 1], 0.02, method);
    assert.ok(tiny.every(n => n >= 0), 'small totals never create negative costs');
    assert.ok(sums(tiny, 0.02), 'small totals retain every cent');
  }
  for (const invalid of [Infinity, NaN, -1]) {
    assert.throws(() => splitPrice([1], invalid), RangeError);
  }

  console.log('splitPrice self-check passed');
}
