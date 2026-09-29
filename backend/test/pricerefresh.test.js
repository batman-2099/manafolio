// The configurable Magic price-refresh interval survives restarts.
// No framework — plain node + assert. Run: `node test/pricerefresh.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-pricerefresh-${process.pid}.db`);
const db = require('../src/db');
const {
  shouldSweepPrices,
  markPricesSwept,
  priceRefreshDays,
  DEFAULT_PRICE_REFRESH_DAYS,
} = require('../src/utils/priceHelpers');

const setDays = (n) => db.run(`UPDATE app_settings SET price_refresh_days = ? WHERE id = 1`, [n]);
const sweptDaysAgo = (col, days) =>
  db.run(`UPDATE app_settings SET ${col} = datetime('now', '-${days} days') WHERE id = 1`);

// Every provider that calls shouldSweepPrices, and the column each one records
// against. A provider present here but absent from SWEEP_COLUMN is silently
// never swept, which is the whole point of the last case below.
const PROVIDERS = [
  ['mtg', 'mtg_prices_swept_at'],
];

async function main() {
  await db.initDb();

  // --- 1. Default is daily, so nothing changes for an install that ignores this.
  assert.strictEqual(await priceRefreshDays(), DEFAULT_PRICE_REFRESH_DAYS);
  assert.strictEqual(DEFAULT_PRICE_REFRESH_DAYS, 1, 'the default must stay daily');

  // --- 2. Never swept: always due, whatever the interval.
  for (const [game] of PROVIDERS) {
    assert.strictEqual(await shouldSweepPrices(game), true, `${game}: a never-swept install must sweep`);
  }

  // --- 3. Every provider actually records its sweep.
  for (const [game, col] of PROVIDERS) {
    await markPricesSwept(game);
    const row = await db.get(`SELECT ${col} AS at FROM app_settings WHERE id = 1`);
    assert.ok(row && row.at, `${game}: markPricesSwept must write ${col} — is "${game}" in SWEEP_COLUMN?`);
    assert.strictEqual(await shouldSweepPrices(game), false,
      `${game}: a sweep that just ran is not due again`);
  }

  // --- 4. The interval is honoured, per provider.
  await setDays(7);
  assert.strictEqual(await priceRefreshDays(), 7);
  for (const [game, col] of PROVIDERS) {
    await sweptDaysAgo(col, 3);
    assert.strictEqual(await shouldSweepPrices(game), false,
      `${game}: 3 days into a 7-day interval is not due`);
    await sweptDaysAgo(col, 8);
    assert.strictEqual(await shouldSweepPrices(game), true,
      `${game}: 8 days into a 7-day interval is due`);
  }

  // --- 5. Zero switches automatic refreshes off, however long it has been.
  await setDays(0);
  for (const [game, col] of PROVIDERS) {
    await sweptDaysAgo(col, 400);
    assert.strictEqual(await shouldSweepPrices(game), false,
      `${game}: 0 means the automatic sweep does not run`);
  }
  // Off means off for the timer, not for a deliberate refresh: every provider
  // takes force and skips this gate entirely, which is what makes 0 safe to
  // offer at all.

  // --- 6. Junk in the column falls back to daily rather than to "never".
  //    Reading it as 0 would quietly stop every price in the app. NULL is not
  //    in the list because the column is NOT NULL, so the database refuses it
  //    before this code ever sees it.
  for (const bad of [-1, 'weekly']) {
    await db.run(`UPDATE app_settings SET price_refresh_days = ? WHERE id = 1`, [bad]);
    assert.strictEqual(await priceRefreshDays(), DEFAULT_PRICE_REFRESH_DAYS,
      `an unreadable interval (${JSON.stringify(bad)}) must fall back to daily, never to off`);
  }

  // --- 7. An unknown provider is still refused, which is the behaviour the
  //    SWEEP_COLUMN comment relies on.
  assert.strictEqual(await shouldSweepPrices('not-a-provider'), false);

  console.log('pricerefresh.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
