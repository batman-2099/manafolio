const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-container-deck-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');
const create = deckRouter.stack.find(layer => layer.route?.path === '/from-container' && layer.route.methods.post).route.stack[0].handle;

async function request(body, userId = 1) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await create({ body, user: { id: userId } }, res);
  return res;
}

async function snapshot() {
  const state = {};
  for (const table of ['collection', 'locations', 'compartments', 'card_cache', 'decks', 'deck_cards']) {
    state[table] = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return state;
}

async function testContainerDeck() {
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')");
    const location = (await db.run("INSERT INTO locations (name, type, game, user_id, locked) VALUES ('Full box', 'Box', 'any', 1, 1)")).lastID;
    const compartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity, locked) VALUES (?, 1, 100, 1)', [location])).lastID;
    const foreign = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Private box', 'Box', 2)")).lastID;
    const empty = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('No physical cards', 'Box', 1)")).lastID;
    for (const [id, name, game] of [
      ['printing-a', 'Same card', 'mtg'], ['printing-b', 'Same card', 'mtg'],
      ['printing-c', 'Another card', 'mtg'], ['legacy-card', 'Legacy card', 'lorcana']
    ]) {
      await db.run('INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)', [id, name, game]);
    }
    const add = (card, quantity, options = {}) => db.run(`
      INSERT INTO collection (card_id, quantity, printing, location_id, compartment_id, position, list_type, missing, user_id, game)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [card, quantity, options.printing || 'Normal', options.location ?? location,
      options.location ? null : compartment, options.position || 0, options.list || 'collection',
      options.missing || 0, options.user || 1, options.game || 'mtg']);
    await add('printing-a', 1, { position: 1 });
    await add('printing-a', 1, { position: 2 });
    await add('printing-a', 4, { position: 3 });
    await add('printing-a', 3, { printing: 'Holofoil', position: 4 });
    await add('printing-a', 2, { missing: 1, position: 5 });
    await add('printing-b', 3, { position: 6 });
    await add('printing-c', 1, { position: 7 });
    await add('printing-a', 0);
    await add('printing-a', -2);
    await add('printing-a', 40, { list: 'arena' });
    await add('printing-a', 30, { list: 'wishlist' });
    await add('printing-a', 50, { user: 2 });
    await add('printing-a', 100, { location: foreign });
    await add('printing-a', 200, { game: 'lorcana' });
    await add('legacy-card', 300);
    await add('printing-a', 5, { location: empty, list: 'arena' });
    await add('printing-b', 5, { location: empty, list: 'wishlist' });
    const reserved = (await db.run("INSERT INTO decks (user_id, name, checked_out, checked_out_at) VALUES (1, 'In play', 1, '2026-09-23')")).lastID;
    await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (?, ?, 11, 1)', [reserved, 'printing-a']);
    const original = await snapshot();

    // Arbitrary-size physical imports remain editable drafts, even in singleton formats.
    // Stale UI selection/filter fields cannot narrow the persisted container contents.
    const result = await request({ location_id: location, name: '  Full box deck  ', format: 'Commander / EDH', card_ids: ['printing-c'], search: 'Another card' });
    assert.strictEqual(result.statusCode, 201);
    const deckId = result.body.id;
    const deck = await db.get('SELECT * FROM decks WHERE id = ?', [deckId]);
    assert.deepStrictEqual([deck.user_id, deck.name, deck.game, deck.format, deck.inventory_type, deck.target_size, deck.commander_card_id, deck.checked_out, deck.checked_out_at],
      [1, 'Full box deck', 'mtg', 'Commander / EDH', 'collection', 15, null, 0, null]);
    assert.deepStrictEqual(await db.all('SELECT card_id, quantity, checked_out FROM deck_cards WHERE deck_id = ? ORDER BY card_id', [deckId]), [
      { card_id: 'printing-a', quantity: 11, checked_out: 0 },
      { card_id: 'printing-b', quantity: 3, checked_out: 0 },
      { card_id: 'printing-c', quantity: 1, checked_out: 0 }
    ]);
    const afterCreate = await snapshot();
    assert.deepStrictEqual({ ...afterCreate,
      decks: afterCreate.decks.filter(row => row.id !== deckId),
      deck_cards: afterCreate.deck_cards.filter(row => row.deck_id !== deckId)
    }, original, 'creating a definition must not move, duplicate, reserve or alter existing cards/storage/decks');

    for (const body of [null, [], {},
      { location_id: '1', name: 'Deck' }, { location_id: 0, name: 'Deck' },
      { location_id: 1.5, name: 'Deck' }, { location_id: Number.MAX_SAFE_INTEGER + 1, name: 'Deck' },
      { location_id: location, name: '   ' }, { location_id: location, name: ['Deck'] },
      { location_id: location, name: 'x'.repeat(121) },
      { location_id: location, name: 'Deck', format: null },
      { location_id: location, name: 'Deck', format: 'Unknown' },
      { location_id: location, name: 'Deck', format: '__proto__' },
      { location_id: empty, name: 'Deck' }
    ]) {
      assert.strictEqual((await request(body)).statusCode, 400);
    }
    assert.strictEqual((await request({ location_id: foreign, name: 'Foreign' })).statusCode, 404);
    assert.strictEqual((await request({ location_id: location, name: 'Other user' }, 2)).statusCode, 404);
    assert.strictEqual((await request({ location_id: 999999, name: 'Absent' })).statusCode, 404);
    assert.deepStrictEqual(await snapshot(), afterCreate, 'rejected requests must leave no partial deck');

    // Fail after at least one card insert, proving both the parent and earlier card roll back.
    await db.run(`CREATE TRIGGER fail_container_deck_card BEFORE INSERT ON deck_cards
      WHEN (SELECT COUNT(*) FROM deck_cards WHERE deck_id = NEW.deck_id) > 0
      BEGIN SELECT RAISE(ABORT, 'private insertion failure'); END`);
    const originalError = console.error;
    let failure;
    try {
      console.error = () => {};
      failure = await request({ location_id: location, name: 'Must roll back', format: 'Standard' });
    } finally {
      console.error = originalError;
      await db.run('DROP TRIGGER fail_container_deck_card');
    }
    assert.strictEqual(failure.statusCode, 500);
    assert.deepStrictEqual(failure.body, { error: 'Failed to create deck from container' });
    assert.deepStrictEqual(await snapshot(), afterCreate, 'a failed insert must roll back the deck and every card');

    const casual = await request({ location_id: location, name: 'x'.repeat(120) });
    assert.strictEqual(casual.statusCode, 201);
    assert.deepStrictEqual(await db.get('SELECT format, target_size FROM decks WHERE id = ?', [casual.body.id]), { format: 'Casual', target_size: 15 });
  } finally {
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testContainerDeck()
  .then(() => console.log('Container deck self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
