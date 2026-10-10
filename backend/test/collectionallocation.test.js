const assert = require('assert');

process.env.DB_PATH = ':memory:';
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { checkedOutAllocation } = require('../src/utils/collectionHelpers');
const collectionRouter = require('../src/routes/collection');
const getCollection = collectionRouter.stack.find(layer => layer.route?.path === '/collection' && layer.route.methods.get).route.stack[0].handle;

async function main() {
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other')");
    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('card', 'Card', 'mtg'), ('legacy', 'Legacy', 'unsupported')");
    const box = (await db.get('SELECT id FROM locations WHERE user_id = 1 LIMIT 1')).id;
    await db.run(`INSERT INTO collection (id, user_id, card_id, quantity, location_id, added_at, list_type, missing, game) VALUES
      (101, 1, 'card', 2, ?, '2026-01-01', 'collection', 1, 'mtg'),
      (102, 1, 'card', 3, NULL, '2026-02-01', 'collection', 0, 'mtg'),
      (103, 1, 'card', 99, NULL, '2026-03-01', 'arena', 0, 'mtg'),
      (104, 2, 'card', 99, NULL, '2026-03-01', 'collection', 0, 'mtg'),
      (105, 1, 'legacy', 1, NULL, '2026-01-01', 'collection', 0, 'unsupported')`, [box]);
    await db.run(`INSERT INTO decks (id, user_id, name, checked_out, game) VALUES
      (1, 1, 'First', 1, 'mtg'), (2, 1, 'Second', 1, 'mtg'), (3, 1, 'Historical', 1, 'unsupported')`);
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (1, 'card', 2), (2, 'card', 1), (3, 'legacy', 1)");
    const oldDeck = await db.get('SELECT * FROM decks WHERE id = 3');
    const oldEntry = await db.get('SELECT * FROM collection WHERE id = 105');

    // Upgrading must reserve the historical copies, even ones later marked missing.
    await db.initDb();
    assert.deepStrictEqual(await checkedOutAllocation(1), new Map([[101, 2], [102, 1], [105, 1]]));
    assert.deepStrictEqual(await checkedOutAllocation(1, 1), new Map([[102, 1], [105, 1]]));
    await db.run("INSERT INTO collection (id, card_id, quantity, location_id, user_id) VALUES (106, 'card', 4, ?, 1)", [box]);
    await db.initDb();
    assert.strictEqual((await checkedOutAllocation(1)).has(106), false, 'new inventory cannot steal an existing checkout reservation');
    assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = 3'), oldDeck);
    assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = 105'), oldEntry);

    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 101).checked_out_qty, 2);
    assert.strictEqual(res.body.find(row => row.entry_id === 102).checked_out_qty, 1);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).checked_out_qty, 0);
    assert.ok(res.body.find(row => row.entry_id === 101).deck_names.includes('First'));
    await db.run('UPDATE decks SET checked_out = 0 WHERE id = 1');
    assert.deepStrictEqual(await checkedOutAllocation(1), new Map([[102, 1], [105, 1]]), 'returning one deck does not reassign another deck');
    assert.deepStrictEqual(await checkedOutAllocation(2), new Map(), 'another owner does not inherit reservations');
    await db.run("INSERT INTO decks (id, user_id, name, checked_out, game) VALUES (4, 1, 'Draft', 0, 'mtg')");
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (4, 'card', 2, 106)");
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).in_deck_qty, 0, 'deck membership alone is not in deck');
    await db.run('UPDATE deck_cards SET checked_out = 1 WHERE deck_id = 4');
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).in_deck_qty, 2, 'pulled copies are shown in deck');
    assert.strictEqual(res.body.find(row => row.entry_id === 106).checked_out_qty, 0, 'pulled status does not reserve inventory');
    assert.strictEqual(res.body.find(row => row.entry_id === 102).in_deck_qty, 1, 'checkout shows unpulled copies in deck');
    await db.run('UPDATE deck_cards SET checked_out = 0 WHERE deck_id = 4');
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).in_deck_qty, 0, 'clearing pulled removes the indicator');
    console.log('Historical checkout allocation SQLite regression passed');
  } finally {
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
