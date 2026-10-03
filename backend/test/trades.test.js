const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { randomUUID } = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-trades-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-trade-password';
const db = require('../src/db');

(async () => {
  let server;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'trade-test-other')");
    await db.run(`INSERT INTO card_cache (id, name, game, language, price_normal, price_holofoil, price_currency)
      VALUES ('mtg-give', 'Giving sample', 'mtg', 'English', 2, NULL, 'USD'),
      ('mtg-receive', 'Receiving sample', 'mtg', 'Japanese', 3, NULL, 'EUR')`);
    const entry = (await db.run(`INSERT INTO collection (user_id, card_id, quantity, printing, purchase_price, notes)
      VALUES (1, 'mtg-give', 4, 'Holofoil', 7, 'preserve this')`)).lastID;
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/trades', require('../src/routes/trades'));
    app.use('/api', require('../src/routes/importExport'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const request = async (route, body, user = 1) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
        method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() };
    };
    const available = () => request('/trades/entries');
    const draft = async () => ({ trade_id: randomUUID(), giving: [{ entry_id: entry, quantity: 2, snapshot: (await available()).body.find(row => row.entry_id === entry).snapshot }],
      receiving: [{ card_id: 'mtg-receive', quantity: 3, printing: 'Normal', condition: 'Lightly Played', language: 'Japanese' }] });
    let trade = await draft();
    const review = await request('/trades/review', trade);
    assert.equal(review.body.giving[0].estimate, null, 'foil must not borrow a normal price');
    assert.equal(review.body.receiving[0].estimate, 3);
    assert.equal(review.body.receiving[0].currency, 'EUR');
    assert.equal((await db.get('SELECT quantity FROM collection WHERE id = ?', [entry])).quantity, 4, 'review has no inventory effect');
    assert.equal((await request('/trades/confirm', trade, 2)).status, 409, 'cross-account entry is unavailable');
    assert.equal((await request('/trades/confirm', { ...trade, receiving: [{ ...trade.receiving[0], language: 'English' }] })).status, 400);
    assert.equal((await request('/trades/confirm', { ...trade, giving: [...trade.giving, ...trade.giving] })).status, 400);
    await db.run('UPDATE collection SET missing = 1 WHERE id = ?', [entry]);
    assert.equal((await request('/trades/confirm', trade)).status, 409);
    await db.run('UPDATE collection SET missing = 0, quantity = 5 WHERE id = ?', [entry]);
    assert.equal((await request('/trades/confirm', trade)).status, 409, 'stale quantity invalidates review');
    await db.run('UPDATE collection SET quantity = 4 WHERE id = ?', [entry]);
    const deck = (await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Reserved', 1, 1)")).lastID;
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-give', 1)", [deck]);
    await db.run("INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, 'mtg-give', ?, 1)", [deck, entry]);
    assert.equal((await request('/trades/confirm', trade)).status, 409, 'any reservation blocks the specific entry');
    await db.run('UPDATE decks SET checked_out = 0 WHERE id = ?', [deck]);
    const location = (await db.get('SELECT id FROM locations WHERE user_id = 1 LIMIT 1')).id;
    await db.run('UPDATE collection SET location_id = ? WHERE id = ?', [location, entry]);
    trade = await draft();
    await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [location]);
    assert.equal((await request('/trades/confirm', trade)).status, 409);
    await db.run('UPDATE locations SET locked = 0 WHERE id = ?', [location]);
    for (const inventory of ['arena', 'wishlist', 'graveyard']) {
      await db.run('UPDATE collection SET list_type = ? WHERE id = ?', [inventory, entry]);
      assert.equal((await request('/trades/confirm', trade)).status, 409);
    }
    await db.run("UPDATE collection SET list_type = 'collection' WHERE id = ?", [entry]);
    // Real SQLite failure after the giving UPDATE proves rollback, not just preflight rejection.
    await db.run("CREATE TRIGGER reject_trade_receiving BEFORE INSERT ON collection WHEN NEW.card_id = 'mtg-receive' BEGIN SELECT RAISE(ABORT, 'test receiving failure'); END");
    assert.equal((await request('/trades/confirm', trade)).status, 500);
    assert.equal((await db.get('SELECT quantity FROM collection WHERE id = ?', [entry])).quantity, 4);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM completed_trades')).n, 0);
    await db.run('DROP TRIGGER reject_trade_receiving');
    const committed = await Promise.all([request('/trades/confirm', trade), request('/trades/confirm', trade)]);
    assert.equal(committed[0].status, 200);
    assert.deepEqual(committed[0], committed[1], 'concurrent retries commit once');
    assert.deepEqual((await request('/trades/confirm', trade)), committed[0], 'completed retry survives missing old quantities');
    assert.equal((await request('/trades/confirm', { ...trade, receiving: [{ ...trade.receiving[0], quantity: 1 }] })).status, 409);
    const remaining = await db.get('SELECT * FROM collection WHERE id = ?', [entry]);
    assert.equal(remaining.quantity, 2); assert.equal(remaining.printing, 'Holofoil'); assert.equal(remaining.purchase_price, 7); assert.equal(remaining.notes, 'preserve this'); assert.equal(remaining.location_id, location);
    const received = await db.get("SELECT * FROM collection WHERE card_id = 'mtg-receive'");
    assert.equal(received.quantity, 3); assert.equal(received.language, 'Japanese'); assert.equal(received.condition, 'Lightly Played'); assert.equal(received.purchase_price, null); assert.equal(received.location_id, null); assert.equal(received.compartment_id, null); assert.equal(received.list_type, 'collection');
    const backup = (await request('/api/export?format=backup')).body;
    assert.equal(backup.completed_trades[0].trade_id, trade.trade_id);
    const restore = await request('/api/import', { format: 'backup', data: backup }, 2);
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    assert.equal((await request('/trades/confirm', trade, 2)).status, 200, 'restored receipt prevents replay even after entry IDs remap');
    console.log('Trade transaction, identity, inventory, reservation, rollback, retry, pricing and backup checks passed.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
