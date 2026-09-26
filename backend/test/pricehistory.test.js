// Runnable check for price-history recording. The sweep runs on every boot and
// nodemon reboots on every edit, which wrote a fresh row per card per restart —
// 17k identical rows in one day. Only movements belong in a price series.
// No framework — plain node + assert. Run: `node test/pricehistory.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-pricehist-${process.pid}.db`);
const db = require('../src/db');
const { recordPrice, shouldSweepPrices, markPricesSwept } = require('../src/utils/priceHelpers');

const CARD = 'mtg-test-card';
const count = async () => (await db.get(`SELECT COUNT(*) n FROM price_history WHERE card_id = ?`, [CARD])).n;

async function main() {
  await db.initDb();

  // 1. First price is recorded.
  assert.strictEqual(await recordPrice(CARD, 1.5), true, 'first price should be recorded');
  assert.strictEqual(await count(), 1);

  // 2. The same price again is NOT recorded, however many times the sweep runs.
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(await recordPrice(CARD, 1.5), false, 'unchanged price must not be recorded');
  }
  assert.strictEqual(await count(), 1, 'restarts must not pile up identical rows');

  // 3. A real movement IS recorded.
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(await recordPrice(CARD, 2.25), true, 'a price change should be recorded');
  assert.strictEqual(await count(), 2);

  // 4. Returning to an earlier price is still a movement worth recording.
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(await recordPrice(CARD, 1.5), true, 'a move back down is still a move');
  assert.strictEqual(await count(), 3);

  // 5. Junk is ignored rather than written as a zero-price data point.
  assert.strictEqual(await recordPrice(CARD, 0), false, 'zero is not a price');
  assert.strictEqual(await recordPrice(CARD, null), false, 'null is not a price');
  assert.strictEqual(await recordPrice(null, 5), false, 'no card id, no row');
  assert.strictEqual(await count(), 3, 'junk must not reach the table');

  // --- Once-a-day sweep gate ---
  // Scryfall only moves prices once a day, so sweeping more often is pure load.
  // The boot sweep used to re-run on every restart; under nodemon that meant a
  // full sweep per code edit.
  for (const game of ['mtg', 'lorcana']) {
    assert.strictEqual(await shouldSweepPrices(game), true, `${game}: a never-swept DB should sweep`);
    await markPricesSwept(game);
    assert.strictEqual(await shouldSweepPrices(game), false, `${game}: must not re-sweep right after sweeping`);
  }

  // The two games are tracked independently — one sweeping must not silence the other.
  await db.run(`UPDATE app_settings SET mtg_prices_swept_at = datetime('now', '-25 hours') WHERE id = 1`);
  assert.strictEqual(await shouldSweepPrices('mtg'), true, 'over 24h old should sweep again');
  assert.strictEqual(await shouldSweepPrices('lorcana'), false, 'the other game stays gated');

  // Just under a day is still too soon.
  await db.run(`UPDATE app_settings SET mtg_prices_swept_at = datetime('now', '-23 hours') WHERE id = 1`);
  assert.strictEqual(await shouldSweepPrices('mtg'), false, '23h is inside the daily window');

  console.log('pricehistory.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
