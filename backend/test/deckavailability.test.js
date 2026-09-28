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
const getDecks = deckRouter.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
const checkoutDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id/checkout' && layer.route.methods.put).route.stack[0].handle;
const getLocations = deckRouter.stack.find(layer => layer.route?.path === '/:id/locations' && layer.route.methods.get).route.stack[0].handle;
const getDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.get).route.stack[0].handle;
const updatePulled = deckRouter.stack.find(layer => layer.route?.path === '/:id/cards/:card_id/pulled' && layer.route.methods.put).route.stack[0].handle;

async function testDeckListMissingCards() {
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES
    ('list-card', 'List Card', 'mtg'), ('unusable', 'Unusable', 'mtg'), ('absent', 'Absent', 'mtg')`);
  await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other-owner', 'unused', 'other-owner-token')");
  const box = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Source Box', 'Box', 1)")).lastID;
  const compartment = (await db.run("INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)", [box])).lastID;
  const otherCompartment = (await db.run("INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 2, 100)", [box])).lastID;
  const lead = (await db.run(`INSERT INTO collection (card_id, quantity, user_id, location_id, compartment_id)
    VALUES ('list-card', 1, 1, ?, ?)`, [box, compartment])).lastID;
  const sibling = (await db.run(`INSERT INTO collection (card_id, quantity, user_id, location_id, compartment_id)
    VALUES ('list-card', 1, 1, ?, ?)`, [box, compartment])).lastID;
  await db.run(`INSERT INTO collection (card_id, quantity, user_id, location_id, compartment_id)
    VALUES ('list-card', 1, 1, ?, ?)`, [box, otherCompartment]);
  await db.run("INSERT INTO collection (card_id, quantity, user_id) VALUES ('list-card', 1, 1), ('unusable', 9, 2)");
  await db.run(`INSERT INTO collection (card_id, quantity, user_id, list_type, missing) VALUES
    ('unusable', 2, 1, 'arena', 0), ('unusable', 9, 1, 'wishlist', 0),
    ('unusable', 9, 1, 'graveyard', 0), ('unusable', 9, 1, 'collection', 1)`);
  async function deck(name, card, quantity, inventory = 'collection', source = null) {
    const id = (await db.run(`INSERT INTO decks (name, user_id, target_size, inventory_type)
      VALUES (?, 1, ?, ?)`, [name, quantity, inventory])).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id)
      VALUES (?, ?, ?, ?)`, [id, card, quantity, source]);
    return id;
  }
  const ready = await deck('Ready', 'list-card', 2, 'collection', lead);
  const automatic = await deck('Automatic', 'list-card', 2);
  const shortage = await deck('Shortage', 'list-card', 6);
  const restricted = await deck('Restricted', 'list-card', 3, 'collection', lead);
  const unusable = await deck('Unusable inventory', 'unusable', 2);
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'absent', 3)", [unusable]);
  const arenaReady = await deck('Arena ready', 'unusable', 2, 'arena');
  const arenaMissing = await deck('Arena missing', 'list-card', 1, 'arena');
  const empty = (await db.run("INSERT INTO decks (name, user_id) VALUES ('Empty', 1)")).lastID;
  function response() {
    return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  }
  async function listed() {
    const res = response();
    await getDecks({ query: {}, user: { id: 1 } }, res);
    assert.strictEqual(res.statusCode, 200);
    return new Map(res.body.map(row => [row.id, row]));
  }
  let rows = await listed();
  assert.strictEqual(rows.get(ready).missing_cards, 0, 'a full, usable deck is ready');
  assert.strictEqual(rows.get(shortage).total_cards, rows.get(shortage).target_size);
  assert.strictEqual(rows.get(shortage).missing_cards, 2, 'a full saved definition can lack multiple copies');
  assert.strictEqual(rows.get(restricted).missing_cards, 1, 'selected sources exclude other compartments and unassigned copies');
  assert.strictEqual(rows.get(unusable).missing_cards, 5, 'count missing copies across cards, excluding missing, wishlist, graveyard, Arena and other users');
  assert.strictEqual(rows.get(arenaReady).missing_cards, 0);
  assert.strictEqual(rows.get(arenaMissing).missing_cards, 1, 'physical inventory cannot satisfy Arena decks');
  assert.strictEqual(rows.get(empty).missing_cards, 0, 'empty definitions have no unavailable required copies');

  const checkoutRes = response();
  await checkoutDeck({ params: { id: ready }, user: { id: 1 } }, checkoutRes);
  assert.strictEqual(checkoutRes.statusCode, 200);
  const reservations = await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [ready]);
  rows = await listed();
  assert.strictEqual(rows.get(ready).missing_cards, 0, 'own healthy reservations remain available');
  assert.strictEqual(rows.get(automatic).missing_cards, 0, 'other decks can use unreserved copies');
  assert.strictEqual(rows.get(shortage).missing_cards, 4, 'other decks reservations are subtracted');
  assert.strictEqual(rows.get(restricted).missing_cards, 3, 'reserved selected sources cannot fall back elsewhere');
  assert.strictEqual(rows.get(arenaReady).missing_cards, 0, 'physical reservations do not affect Arena');

  await db.run("UPDATE collection SET list_type = 'graveyard', location_id = NULL, compartment_id = NULL WHERE id = ?", [lead]);
  rows = await listed();
  assert.strictEqual(rows.get(ready).checked_out, 1);
  assert.strictEqual(rows.get(ready).missing_cards, 1, 'an archived own reservation is missing even with free replacement copies');
  assert.strictEqual(rows.get(restricted).missing_cards, 3, 'an archived source lead cannot silently select another group');
  assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [ready]), reservations);
  const locationsRes = response();
  await getLocations({ params: { id: ready }, user: { id: 1 } }, locationsRes);
  assert.strictEqual(locationsRes.statusCode, 200);
  assert.strictEqual(locationsRes.body[0].found, 2, 'return guide still includes archived reserved copies');
  await db.run('UPDATE collection SET missing = 1 WHERE id = ?', [sibling]);
  assert.strictEqual((await listed()).get(ready).missing_cards, 2, 'missing own copies also cease to be usable');
  await db.run("UPDATE collection SET list_type = 'collection', location_id = ?, compartment_id = ? WHERE id = ?", [box, compartment, lead]);
  await db.run('UPDATE collection SET missing = 0 WHERE id = ?', [sibling]);
  assert.strictEqual((await listed()).get(ready).missing_cards, 0, 'restoring usable reservations clears the shortage');
}
async function testCheckedOutCardsAreUnavailable() {
  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('goblin', 'Goblin', 'mtg')`);
    await db.run(`INSERT INTO collection (card_id, quantity, game, user_id) VALUES ('goblin', 2, 'mtg', 1)`);
    const testing = await db.run(`INSERT INTO decks (name, game, user_id) VALUES ('Testing', 'mtg', 1)`);
    const stampede = await db.run(`INSERT INTO decks (name, game, checked_out, user_id) VALUES ('Goblin Stampede', 'mtg', 1, 1)`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 1)`, [testing.lastID]);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'goblin', 2)`, [stampede.lastID]);

    const listRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await getDecks({ query: {}, user: { id: 1 } }, listRes);
    assert.strictEqual(listRes.statusCode, 200);
    assert.strictEqual(listRes.body.find(deck => deck.id === stampede.lastID).missing_cards, 0, 'legacy own reservations remain usable');
    assert.strictEqual(listRes.body.find(deck => deck.id === testing.lastID).missing_cards, 1, 'legacy reservations block other decks');
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
    await testDeckListMissingCards();
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
