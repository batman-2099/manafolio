const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-deck-availability-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');
const collectionRouter = require('../src/routes/collection');
const getCollection = collectionRouter.stack.find(layer => layer.route?.path === '/collection' && layer.route.methods.get).route.stack[0].handle;
const updateCollection = collectionRouter.stack.find(layer => layer.route?.path === '/collection/:id' && layer.route.methods.put).route.stack[0].handle;
const getDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.get).route.stack[0].handle;
const updatePulled = deckRouter.stack.find(layer => layer.route?.path === '/:id/cards/:card_id/pulled' && layer.route.methods.put).route.stack[0].handle;

async function testCheckedOutCardsAreUnavailable() {
  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('goblin', 'Goblin', 'mtg')`);
    await db.run(`INSERT INTO collection (card_id, quantity, game, user_id) VALUES ('goblin', 2, 'mtg', 1)`);
    const testing = await db.run(`INSERT INTO decks (name, game, user_id) VALUES ('Testing', 'mtg', 1)`);
    const stampede = await db.run(`INSERT INTO decks (name, game, checked_out, user_id) VALUES ('Goblin Stampede', 'mtg', 1, 1)`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 1)`, [testing.lastID]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 2)`, [stampede.lastID]);

    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await getDeck({ params: { id: testing.lastID }, user: { id: 1 } }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.cards[0].owned_qty, 2);
    assert.deepStrictEqual(res.body.cards[0].locked_qty, 2);
    assert.strictEqual(res.body.cards[0].locked_decks, 'Goblin Stampede');
    const collectionRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await getCollection({ query: {}, user: { id: 1 } }, collectionRes);
    assert.strictEqual(collectionRes.statusCode, 200);
    assert.strictEqual(collectionRes.body[0].deck_names, 'Goblin Stampede', 'collection cards must identify only checked-out decks containing their printing');
    const missingRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await updateCollection({ params: { id: 1 }, body: { missing: true }, user: { id: 1 } }, missingRes);
    assert.strictEqual(missingRes.statusCode, 200);
    await getCollection({ query: {}, user: { id: 1 } }, collectionRes);
    assert.strictEqual(collectionRes.body[0].missing, 1, 'a missing copy must remain marked in the collection');
    const pulledRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await updatePulled({ params: { id: testing.lastID, card_id: 'goblin' }, body: { pulled: true }, user: { id: 1 } }, pulledRes);
    assert.strictEqual(pulledRes.statusCode, 200);
    await getDeck({ params: { id: testing.lastID }, user: { id: 1 } }, res);
    assert.strictEqual(res.body.cards[0].checked_out, 1, 'pulled status must survive a deck reload');
    assert.strictEqual(res.body.cards[0].quantity > res.body.cards[0].owned_qty - res.body.cards[0].locked_qty, true,
      'Testing must mark cards in checked-out Goblin Stampede unavailable');

    await db.run(`INSERT INTO collection (card_id, quantity, game, user_id, list_type) VALUES ('goblin', 1, 'mtg', 1, 'arena')`);
    const arena = await db.run(`INSERT INTO decks (name, game, user_id, inventory_type) VALUES ('Arena Goblins', 'mtg', 1, 'arena')`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 1)`, [arena.lastID]);
    await getDeck({ params: { id: arena.lastID }, user: { id: 1 } }, res);
    assert.strictEqual(res.body.cards[0].owned_qty, 1, 'Arena ownership excludes physical copies');
    assert.strictEqual(res.body.cards[0].locked_qty, 0, 'physical checkout cannot reserve Arena copies');
    assert.strictEqual(res.body.cards[0].locked_decks, null, 'Arena warnings cannot name physical decks');
    assert.strictEqual(res.body.cards[0].quantity > res.body.cards[0].owned_qty - res.body.cards[0].locked_qty, false);
    await db.run(`DELETE FROM collection WHERE list_type = 'arena'`);
    await getDeck({ params: { id: arena.lastID }, user: { id: 1 } }, res);
    assert.strictEqual(res.body.cards[0].owned_qty, 0, 'physical copies cannot cover an Arena shortage');
    assert.strictEqual(res.body.cards[0].quantity > res.body.cards[0].owned_qty - res.body.cards[0].locked_qty, true);
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testCheckedOutCardsAreUnavailable()
  .then(() => console.log('Deck checkout availability self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
