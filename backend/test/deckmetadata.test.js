const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-deck-metadata-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');
const storageRouter = require('../src/routes/storage');
const { composition } = require('../src/utils/deckRevisions');
const updateDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.put).route.stack[0].handle;

async function request(router, method, route, id, body, userId = 1, params = {}) {
  const handler = router.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack[0].handle;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  await handler({ params: { id, ...params }, body, query: {}, user: { id: userId } }, res);
  return res;
}

async function testContainerLinks(deckId) {
  await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other')");
  const location = async (name, inventory = 'collection', user = 1, game = 'mtg') => (await db.run(
    'INSERT INTO locations (name, type, inventory_type, user_id, game) VALUES (?, ?, ?, ?, ?)',
    [name, 'Box', inventory, user, game]
  )).lastID;
  const box = await location('Linked box');
  const archived = await location('Archived box', 'graveyard');
  const foreign = await location('Foreign box', 'collection', 2);
  const wrongGame = await location('Other game', 'collection', 1, 'pokemon');
  const anyGame = await location('Any game', 'collection', 1, 'any');
  const link = (container_id, id = deckId, user = 1) => request(deckRouter, 'patch', '/:id/container-link', id, { container_id }, user);
  const savedLink = async (id = deckId) => (await db.get('SELECT container_id FROM decks WHERE id = ?', [id])).container_id;
  const details = async (id = deckId) => (await request(deckRouter, 'get', '/:id', id)).body;
  const metadata = inventory_type => request(deckRouter, 'put', '/:id', deckId, { name: 'Linked deck', inventory_type });
  const editor = async inventory_type => request(deckRouter, 'put', '/:id/editor', deckId, {
    ...await details(), inventory_type, cards: [], commander_card_id: null
  });
  const state = async () => {
    const result = {};
    for (const table of ['collection', 'locations', 'compartments', 'deck_cards', 'deck_card_allocations', 'deck_revisions']) {
      result[table] = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
    }
    return result;
  };
  assert.ok((await db.all('PRAGMA foreign_key_list(decks)')).some(key =>
    key.from === 'container_id' && key.table === 'locations' && key.to === 'id' && key.on_delete === 'SET NULL'));
  assert.strictEqual((await details()).container_id, null);
  assert.strictEqual((await details()).container_name, null);

  // Linking a locked, full container is metadata only, including for a checked-out deck.
  await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [box]);
  const compartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 1)', [box])).lastID;
  await db.run("INSERT INTO card_cache (id, name, game) VALUES ('link-copy', 'Link copy', 'mtg')");
  const entry = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position)
    VALUES ('link-copy', 1, 1, ?, ?, 1000)`, [box, compartment])).lastID;
  const reserved = (await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Reserved', 1, 1)")).lastID;
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'link-copy', 1, ?)", [reserved, entry]);
  await db.run("INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, 'link-copy', ?, 1)", [reserved, entry]);
  const before = await state();
  assert.deepStrictEqual((await link(box)).body, { container_id: box, container_name: 'Linked box' });
  assert.strictEqual((await link(box, reserved)).statusCode, 200, 'multiple decks can link the same container');
  assert.strictEqual(await savedLink(), box);
  assert.strictEqual((await details()).container_name, 'Linked box');
  const list = await request(deckRouter, 'get', '/');
  assert.strictEqual(list.body.find(deck => deck.id === deckId).container_id, box);
  assert.strictEqual(list.body.find(deck => deck.id === deckId).container_name, 'Linked box');
  assert.deepStrictEqual(await state(), before, 'links must not move copies, alter definitions, reservations, or history');
  assert.strictEqual((await metadata('collection')).statusCode, 200);
  assert.strictEqual(await savedLink(), box, 'same-inventory metadata saves retain links');
  const duplicate = await request(deckRouter, 'post', '/:id/duplicate', deckId);
  assert.strictEqual(duplicate.statusCode, 201);
  assert.strictEqual(await savedLink(duplicate.body.id), null, 'duplicates do not inherit links');
  assert.deepStrictEqual((await link(null)).body, { container_id: null, container_name: null });
  assert.strictEqual(await savedLink(), null);
  assert.strictEqual((await link(anyGame)).statusCode, 200);
  assert.strictEqual((await link(box)).statusCode, 200);

  const rejectedBefore = await state();
  for (const value of [undefined, 0, -1, 1.5, '1', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual((await link(value)).statusCode, 400);
  }
  for (const body of [null, [], {}, { container_id: box, name: 'extra' }]) {
    assert.strictEqual((await request(deckRouter, 'patch', '/:id/container-link', deckId, body)).statusCode, 400);
  }
  for (const [container, id, user, status] of [
    [foreign, deckId, 1, 404], [box, deckId, 2, 404], [null, deckId, 2, 404],
    [999999, deckId, 1, 404], [box, 999999, 1, 404], [box, 'bad', 1, 400],
    [archived, deckId, 1, 400], [wrongGame, deckId, 1, 400]
  ]) assert.strictEqual((await link(container, id, user)).statusCode, status);
  assert.strictEqual(await savedLink(), box);
  assert.deepStrictEqual(await state(), rejectedBefore);

  assert.strictEqual((await metadata('arena')).statusCode, 200);
  assert.strictEqual(await savedLink(), null, 'metadata inventory changes clear links');
  assert.strictEqual((await link(box)).statusCode, 400, 'Arena cannot link containers');
  assert.strictEqual((await link(null)).statusCode, 200);
  assert.strictEqual((await metadata('graveyard')).statusCode, 200);
  assert.strictEqual((await link(archived)).statusCode, 200);
  assert.strictEqual((await link(box)).statusCode, 400);
  assert.strictEqual((await editor('collection')).statusCode, 200);
  assert.strictEqual(await savedLink(), null, 'editor inventory changes clear links');
  assert.strictEqual((await link(box)).statusCode, 200);
  assert.strictEqual((await editor('collection')).statusCode, 200);
  assert.strictEqual(await savedLink(), box, 'same-inventory editor saves retain links');
  const revision = await db.get("SELECT id, snapshot FROM deck_revisions WHERE deck_id = ? AND kind = 'baseline' ORDER BY id LIMIT 1", [deckId]);
  assert.strictEqual(JSON.parse(revision.snapshot).inventory_type, 'graveyard');
  assert.strictEqual((await request(deckRouter, 'post', '/:id/revisions/:revisionId/restore', deckId, {}, 1, { revisionId: revision.id })).statusCode, 200);
  assert.strictEqual(await savedLink(), null, 'history restore clears incompatible links');
  assert.strictEqual(Object.hasOwn(composition(await details(), []), 'container_id'), false);
  assert.ok((await db.all('SELECT snapshot FROM deck_revisions')).every(row => !row.snapshot.includes('container_id')));

  // Container inventory transfers clear links in both directions, with rollback on failure.
  assert.strictEqual((await link(archived)).statusCode, 200);
  await db.run(`CREATE TRIGGER reject_container_unlink BEFORE UPDATE OF container_id ON decks
    WHEN OLD.id = ${deckId} AND NEW.container_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'deliberate unlink failure'); END`);
  try {
    assert.strictEqual((await request(storageRouter, 'post', '/locations/:id/transfer', archived, { inventory_type: 'collection' })).statusCode, 500);
  } finally {
    await db.run('DROP TRIGGER reject_container_unlink');
  }
  assert.strictEqual(await savedLink(), archived);
  assert.strictEqual((await db.get('SELECT inventory_type FROM locations WHERE id = ?', [archived])).inventory_type, 'graveyard');
  assert.strictEqual((await request(storageRouter, 'post', '/locations/:id/transfer', archived, { inventory_type: 'collection' })).statusCode, 200);
  assert.strictEqual(await savedLink(), null);
  assert.strictEqual((await metadata('collection')).statusCode, 200);
  assert.strictEqual((await link(archived)).statusCode, 200);
  assert.strictEqual((await request(storageRouter, 'post', '/locations/:id/transfer', archived, { inventory_type: 'graveyard' })).statusCode, 200);
  assert.strictEqual(await savedLink(), null);
  assert.strictEqual((await link(anyGame)).statusCode, 200);
  assert.strictEqual((await request(storageRouter, 'put', '/locations/:id', anyGame, { name: 'Renamed box', game: 'mtg' })).statusCode, 200);
  assert.strictEqual((await details()).container_name, 'Renamed box');
  assert.strictEqual(await savedLink(), anyGame, 'compatible game changes retain links');
  assert.strictEqual((await request(storageRouter, 'delete', '/locations/:id', anyGame)).statusCode, 200);
  assert.strictEqual(await savedLink(), null, 'container deletion clears the foreign key');
  assert.strictEqual((await details()).container_name, null);
}

async function testDeckMetadataUpdate() {
  try {
    await db.initDb();
    const created = await db.run(`
      INSERT INTO decks (name, description, game, format, category, accent_color, target_size, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, ['Old Deck', 'Old description', 'mtg', 'Commander / EDH', 'Casual', '#eab308', 100, 1]);
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await updateDeck({
      params: { id: created.lastID },
      body: { name: 'Updated Deck', description: 'Updated description', format: 'Modern', category: 'Tournament', accent_color: '#3b82f6', target_size: 60 },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(await db.get(`
      SELECT name, description, game, format, category, accent_color, target_size
      FROM decks WHERE id = ?
    `, [created.lastID]), {
      name: 'Updated Deck', description: 'Updated description', game: 'mtg', format: 'Modern',
      category: 'Tournament', accent_color: '#3b82f6', target_size: 60
    });
    await testContainerLinks(created.lastID);
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testDeckMetadataUpdate()
  .then(() => console.log('Deck metadata update self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
