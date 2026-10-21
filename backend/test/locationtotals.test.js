const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-location-totals-${process.pid}.db`);
process.env.DEFAULT_ADMIN_PASSWORD = 'test-password';
const db = require('../src/db');
let server;

(async () => {
  try {
    await db.initDb();
    await db.run('DELETE FROM locations');
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'totals-other', 'test', 'totals-other')");
    const location = async (type, stacking = 0, user = 1, inventory = 'collection') => {
      const { lastID: id } = await db.run(
        'INSERT INTO locations (name, type, allow_stacking, user_id, inventory_type) VALUES (?, ?, ?, ?, ?)',
        [type, type, stacking, user, inventory]
      );
      const { lastID: compartment } = await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 60)', [id]);
      return { id, compartment, user, inventory };
    };
    for (const [id, supertype, subtypes, setName, game = 'mtg'] of [
      ['spell', 'Creature', 'Human', 'Test'],
      ['super-token', 'Token', null, 'Test'],
      ['sub-token', 'Creature', '["Token", "Goblin"]', 'Test'],
      ['set-tokens', 'Creature', null, 'Test tOkEnS'],
      ['set-token', null, null, 'TOKEN — Test'],
      ['unknown', null, null, null],
      ['not-token', 'Creature', null, 'Tokenizer'],
      ['other-game', 'Token', null, 'Tokens', 'unsupported'],
    ]) await db.run(
      'INSERT INTO card_cache (id, name, game, supertype, subtypes, set_name) VALUES (?, ?, ?, ?, ?, ?)',
      [id, id, game, supertype, subtypes, setName]
    );
    const store = (box, card, quantity, { user = box.user, inventory = box.inventory, compartment = box.compartment,
      reverse = null, printing = 'Normal', language = 'English' } = {}) => db.run(
      `INSERT INTO collection (card_id, quantity, user_id, location_id, compartment_id, list_type, reverse_card_id, printing, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [card, quantity, user, box.id, compartment, inventory, reverse, printing, language]
    );
    const deck = await location('Deck Box');
    const normal = await location('Box');
    for (const box of [deck, normal]) {
      for (const [card, quantity] of [['spell', 60], ['super-token', 2], ['sub-token', 3], ['set-tokens', 4], ['set-token', 5]]) {
        await store(box, card, quantity);
      }
    }
    const tokens = await location('Deck Box');
    await store(tokens, 'set-tokens', 70);
    const empty = await location('Deck Box');
    const metadata = await location('Deck Box');
    await store(metadata, 'unknown', 2);
    await store(metadata, 'not-token', 3);
    await store(metadata, 'other-game', 4);
    await db.run('PRAGMA foreign_keys = OFF');
    await store(metadata, 'uncached', 1);
    await db.run('PRAGMA foreign_keys = ON');
    const stacked = await location('Deck Box', 1);
    const { lastID: secondPocket } = await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 2, 1)', [stacked.id]);
    await store(stacked, 'spell', 8);
    await store(stacked, 'spell', 5);
    await store(stacked, 'spell', 4, { compartment: secondPocket });
    await store(stacked, 'spell', 1, { language: 'French' });
    await store(stacked, 'spell', 1, { printing: 'Holofoil' });
    await store(stacked, 'super-token', 2, { reverse: 'sub-token' });
    await store(stacked, 'super-token', 3, { reverse: 'sub-token' });
    await store(stacked, 'super-token', 4, { reverse: 'set-token' });
    await store(stacked, 'super-token', 2);
    await db.run('UPDATE compartments SET capacity = 3 WHERE id = ?', [stacked.compartment]);
    const scoped = await location('Deck Box');
    await store(scoped, 'spell', 60, { inventory: null });
    await store(scoped, 'super-token', 2);
    await store(scoped, 'spell', 90, { user: 2 });
    for (const inventory of ['graveyard', 'wishlist', 'arena']) await store(scoped, 'spell', 90, { inventory });
    await store(scoped, 'spell', 90, { compartment: null });
    const archived = await location('Deck Box', 0, 1, 'graveyard');
    await store(archived, 'spell', 6);
    await store(archived, 'set-token', 2);
    await store(archived, 'spell', 90, { inventory: 'collection' });
    const foreign = await location('Deck Box', 0, 2);
    await store(foreign, 'spell', 9);
    await store(foreign, 'sub-token', 3);
    await store(foreign, 'spell', 90, { user: 1 });
    const over = await location('Deck Box');
    await store(over, 'spell', 61);
    await store(over, 'super-token', 2);

    const app = express();
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/api', require('../src/routes/storage'));
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const summaries = async (inventory = 'collection', user = 1) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/locations?inventory_type=${inventory}`, {
        headers: { 'x-test-user': String(user) },
      });
      assert.equal(response.status, 200);
      return (await response.json()).map(row => [row.id, row.total_cards, row.occupied_slots]).sort((a, b) => a[0] - b[0]);
    };
    assert.deepEqual(await summaries(), [
      [deck.id, 60, 74], [normal.id, 74, 74], [tokens.id, 0, 70], [empty.id, 0, 0],
      [metadata.id, 10, 10], [stacked.id, 4, 7], [scoped.id, 60, 62], [over.id, 61, 63],
    ], 'only Deck Box display totals exclude tokens; occupancy retains copies, separate pockets and reverse/finish/language stacks');
    assert.deepEqual(await summaries('graveyard'), [[archived.id, 6, 8]], 'archived totals retain inventory scope');
    assert.deepEqual(await summaries('collection', 2), [[foreign.id, 9, 12]], 'totals retain owner scope');
    const compartments = async (box, user = box.user) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/locations/${box.id}/compartments`, {
        headers: { 'x-test-user': String(user) },
      });
      assert.equal(response.status, 200);
      return (await response.json()).map(row => [row.id, row.capacity_count, row.count, row.free]);
    };
    assert.deepEqual(await compartments(tokens), [[tokens.compartment, 0, 70, -10]], 'tokens alone never exceed Deck Box capacity but still physically occupy it');
    assert.deepEqual(await compartments(deck), [[deck.compartment, 60, 74, -14]], 'mixed Deck Box at capacity excludes every token classification');
    assert.deepEqual(await compartments(over), [[over.compartment, 61, 63, -3]], 'non-token cards can still exceed Deck Box capacity');
    assert.deepEqual(await compartments(normal), [[normal.compartment, 74, 74, -14]], 'normal boxes include tokens in capacity');
    assert.deepEqual(await compartments(empty), [[empty.compartment, 0, 0, 60]], 'empty Deck Box capacity remains zero');
    assert.deepEqual(await compartments(metadata), [[metadata.compartment, 10, 10, 50]], 'unknown metadata and non-Magic cards still count toward capacity');
    assert.deepEqual(await compartments(stacked), [[stacked.compartment, 3, 6, -3], [secondPocket, 1, 1, 0]], 'capacity preserves separate pockets and language/finish stacks while physical occupancy retains token reverse-face stacks');
    assert.deepEqual(await compartments(scoped), [[scoped.compartment, 60, 62, -2]], 'capacity retains owner, legacy inventory and compartment scope');
    assert.deepEqual(await compartments(archived), [[archived.compartment, 6, 8, 52]], 'capacity retains graveyard inventory scope');
    assert.deepEqual(await compartments(foreign), [[foreign.compartment, 9, 12, 48]], 'capacity retains second account scope');
    const forbidden = await fetch(`http://127.0.0.1:${server.address().port}/api/locations/${foreign.id}/compartments`);
    assert.equal(forbidden.status, 404, 'compartments remain inaccessible to another owner');
    await db.run('UPDATE locations SET type = ? WHERE id = ?', ['Box', stacked.id]);
    assert.deepEqual((await summaries()).find(row => row[0] === stacked.id), [stacked.id, 7, 7], 'normal stacked containers still count every occupied pocket');
    assert.deepEqual(await compartments(stacked), [[stacked.compartment, 6, 6, -3], [secondPocket, 1, 1, 0]], 'normal stacked containers include tokens in capacity');
    console.log('Location and compartment totals: Deck Box token capacity, physical occupancy, stacking and account/inventory scope passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
