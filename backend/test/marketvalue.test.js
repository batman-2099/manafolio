// Runnable checks for per-copy values and the read-only API key.
//
// Two features, one file, because they meet in one place: a graded copy's value is
// what makes a net worth figure correct, and the API key is what lets something
// outside Manafolio read that figure.
//
// What is worth locking down:
//   1. market_value beats every provider price. If it does not, a PSA 10 is valued
//      at the raw card's price and the collection total is wrong by thousands.
//   2. Clearing it is possible. A mistyped 10000 must not be permanent.
//   3. The API key is read-only. It is a long-lived credential that lives in some
//      other machine's config file; a POST that gets through makes it a liability.
//
// No framework, no network — plain node + assert. Run: `node test/marketvalue.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-value-${process.pid}.db`);
const db = require('../src/db');
const { resolveCardPrice } = require('../src/utils/priceHelpers');
const { authenticateToken } = require('../src/middleware/auth');

// Minimal express req/res doubles: enough for the middleware, nothing more.
function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
async function runAuth(token, method = 'GET') {
  const req = { headers: { authorization: `Bearer ${token}` }, method };
  const res = fakeRes();
  let passed = false;
  await authenticateToken(req, res, () => { passed = true; });
  return { req, res, passed };
}

(async () => {
  await db.initDb();

  // --- 1. Price resolution -----------------------------------------------------
  const holo = { printing: 'Holofoil', price_holofoil: 12, price_trend: 5 };
  assert.strictEqual(resolveCardPrice(holo), 12, 'printing price still wins over price_trend');

  const slab = { ...holo, market_value: 2400 };
  assert.strictEqual(resolveCardPrice(slab), 2400, 'a value set on the copy beats every provider price');

  // Zero and null mean "not set", not "worthless". A slab valued at 0 by a bad
  // fetch must fall back to the card price rather than zero out the collection.
  assert.strictEqual(resolveCardPrice({ ...holo, market_value: 0 }), 12);
  assert.strictEqual(resolveCardPrice({ ...holo, market_value: null }), 12);
  // A bare card_cache row has no such column at all.
  assert.strictEqual(resolveCardPrice({ price_trend: 7 }), 7);

  // --- 2. The column round-trips, including being cleared ----------------------
  await db.run(`INSERT INTO users (username, password_hash, role, share_token) VALUES ('valuetest', 'x', 'member', 'valuetest-share')`);
  const user = await db.get(`SELECT id FROM users WHERE username = 'valuetest'`);
  await db.run(
    `INSERT INTO card_cache (id, name, set_id, set_name, number, game, price_trend) VALUES ('mtg-lea-232', 'Black Lotus', 'lea', 'Limited Edition Alpha', '232', 'mtg', 300)`
  );
  const ins = await db.run(
    `INSERT INTO collection (card_id, user_id, quantity, printing, grader, grade, cert_number) VALUES ('mtg-lea-232', ?, 1, 'Normal', 'PSA', 9, '82613901')`,
    [user.id]
  );
  const entryId = ins.lastID;

  await db.run(
    `UPDATE collection SET market_value = ?, market_value_source = 'manual', market_value_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [2400, entryId]
  );
  let row = await db.get(
    `SELECT c.market_value, c.market_value_source, c.printing, cc.price_trend
     FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.id = ?`, [entryId]
  );
  assert.strictEqual(resolveCardPrice(row), 2400, 'the stored value is what a collection query resolves to');
  assert.strictEqual(row.market_value_source, 'manual');

  await db.run(`UPDATE collection SET market_value = NULL, market_value_source = NULL WHERE id = ?`, [entryId]);
  row = await db.get(
    `SELECT c.market_value, c.printing, cc.price_trend FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.id = ?`,
    [entryId]
  );
  assert.strictEqual(resolveCardPrice(row), 300, 'clearing the value returns the card to its provider price');

  // --- 3. The API key is read-only --------------------------------------------
  await db.run(`UPDATE users SET api_key = 'bnd_testkey' WHERE id = ?`, [user.id]);

  const readOk = await runAuth('bnd_testkey', 'GET');
  assert.ok(readOk.passed, 'a GET authenticates with an API key');
  assert.strictEqual(readOk.req.user.id, user.id);
  assert.strictEqual(readOk.req.user.via_api_key, true, 'the request must be marked so admin routes can refuse it');

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const write = await runAuth('bnd_testkey', method);
    assert.ok(!write.passed, `${method} must not pass with an API key`);
    assert.strictEqual(write.res.statusCode, 403, `${method} with an API key is 403, not 401`);
  }

  const bogus = await runAuth('bnd_nosuchkey', 'GET');
  assert.ok(!bogus.passed);
  assert.strictEqual(bogus.res.statusCode, 401, 'an unknown key is rejected as a bad credential');

  // A session token still authenticates a write — the API-key branch must not have
  // swallowed the normal path.
  await db.run(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES (?, 'session-token', DATETIME('now', '+1 day'))`,
    [user.id]
  );
  const sessionWrite = await runAuth('session-token', 'POST');
  assert.ok(sessionWrite.passed, 'a real session still writes');
  assert.notStrictEqual(sessionWrite.req.user.via_api_key, true);

  console.log('marketvalue self-check passed');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
