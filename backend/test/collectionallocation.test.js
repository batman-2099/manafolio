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
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 101).deck_allocations,
      [{ deck_id: 1, name: 'First', quantity: 2, checked_out: true }]);
    assert.strictEqual(res.body.find(row => row.entry_id === 101).deck_names, 'First');
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 102).deck_allocations,
      [{ deck_id: 2, name: 'Second', quantity: 1, checked_out: true }]);
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 106).deck_allocations, []);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).deck_names, null);
    await db.run('UPDATE decks SET checked_out = 0 WHERE id = 1');
    assert.deepStrictEqual(await checkedOutAllocation(1), new Map([[102, 1], [105, 1]]), 'returning one deck does not reassign another deck');
    assert.deepStrictEqual(await checkedOutAllocation(2), new Map(), 'another owner does not inherit reservations');
    await db.run("INSERT INTO decks (id, user_id, name, checked_out, game) VALUES (4, 1, 'Draft', 0, 'mtg')");
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (4, 'card', 2, 106)");
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).in_deck_qty, 0, 'deck membership alone is not in deck');
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 106).deck_allocations, [], 'saved-only deck is excluded');
    await db.run('UPDATE deck_cards SET checked_out = 1 WHERE deck_id = 4');
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).in_deck_qty, 2, 'pulled copies are shown in deck');
    assert.strictEqual(res.body.find(row => row.entry_id === 106).checked_out_qty, 0, 'pulled status does not reserve inventory');
    assert.strictEqual(res.body.find(row => row.entry_id === 102).in_deck_qty, 1, 'checkout shows unpulled copies in deck');
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 106).deck_allocations,
      [{ deck_id: 4, name: 'Draft', quantity: 2, checked_out: false }], 'pulled allocation follows the explicit source');
    assert.strictEqual(res.body.find(row => row.entry_id === 106).deck_names, 'Draft');
    await db.run('UPDATE deck_cards SET checked_out = 0 WHERE deck_id = 4');
    await getCollection({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.body.find(row => row.entry_id === 106).in_deck_qty, 0, 'clearing pulled removes the indicator');
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 106).deck_allocations, []);

    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('front', 'Front', 'mtg'), ('reverse', 'Reverse', 'mtg')");
    await db.run(`INSERT INTO collection (id, user_id, card_id, reverse_card_id, quantity, list_type) VALUES
      (107, 1, 'front', 'reverse', 5, 'collection'),
      (108, 1, 'front', 'reverse', 5, 'collection'),
      (109, 1, 'front', 'reverse', 5, 'wishlist')`);
    await db.run(`INSERT INTO decks (id, user_id, name, checked_out, inventory_type) VALUES
      (5, 1, 'Paired, tokens', 1, 'collection'), (6, 1, 'Another deck', 1, 'collection'),
      (7, 1, 'Pulled tokens', 0, 'collection'), (8, 2, 'Private deck', 1, 'collection'),
      (9, 1, 'Arena deck', 1, 'arena')`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id, checked_out) VALUES
      (5, 'front', 1, 107, 0), (5, 'reverse', 1, 107, 0),
      (6, 'reverse', 1, 107, 0),
      (7, 'front', 1, 107, 1), (7, 'reverse', 1, 107, 1),
      (8, 'card', 1, 104, 1), (9, 'card', 1, NULL, 1)`);
    await db.run(`INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES
      (5, 'front', 107, 1), (5, 'reverse', 107, 1), (6, 'reverse', 107, 1),
      (8, 'card', 104, 1)`);
    await getCollection({ query: {}, user: { id: 1 } }, res);
    const paired = res.body.find(row => row.entry_id === 107);
    assert.strictEqual(paired.checked_out_qty, 3);
    assert.strictEqual(paired.in_deck_qty, 5);
    assert.deepStrictEqual([...paired.deck_allocations].sort((a, b) => a.deck_id - b.deck_id), [
      { deck_id: 5, name: 'Paired, tokens', quantity: 2, checked_out: true },
      { deck_id: 6, name: 'Another deck', quantity: 1, checked_out: true },
      { deck_id: 7, name: 'Pulled tokens', quantity: 2, checked_out: false },
    ], 'both token faces coalesce per deck while pulled and reserved copies remain distinct');
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 108).deck_allocations, [], 'unallocated duplicate is not labeled');
    assert.ok(!res.body.some(row => row.entry_id === 104), 'other owner inventory stays private');
    assert.ok(res.body.every(row => row.deck_allocations.every(item => item.deck_id !== 8 && item.deck_id !== 9)),
      'other owner and Arena decks do not label physical inventory');
    await getCollection({ query: {}, user: { id: 2 } }, res);
    assert.deepStrictEqual(res.body.find(row => row.entry_id === 104).deck_allocations,
      [{ deck_id: 8, name: 'Private deck', quantity: 1, checked_out: true }]);
    await db.run("UPDATE collection SET list_type = 'graveyard' WHERE id = 107");
    assert.strictEqual((await checkedOutAllocation(1)).get(107), 3, 'archived reservations retain their exact source');
    for (const listType of ['arena', 'wishlist', 'graveyard']) {
      await getCollection({ query: { list_type: listType }, user: { id: 1 } }, res);
      assert.ok(res.body.length > 0);
      for (const row of res.body) {
        assert.deepStrictEqual(row.deck_allocations, [], `${listType} does not display allocations`);
        assert.strictEqual(row.checked_out_qty, 0);
        assert.strictEqual(row.in_deck_qty, 0);
        assert.strictEqual(row.deck_names, null);
      }
    }
    console.log('Historical checkout allocation SQLite regression passed');
  } finally {
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
