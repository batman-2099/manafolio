const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-container-mana-${process.pid}.db`);
process.env.DEFAULT_ADMIN_PASSWORD = 'test-password';
const db = require('../src/db');
let server;

(async () => {
  try {
    await db.initDb();
    await db.run('DELETE FROM locations');
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other-mana-user', 'test', 'other-mana-token')");
    const location = async (name, user = 1, inventory = 'collection') => (await db.run(
      "INSERT INTO locations (name, type, user_id, inventory_type) VALUES (?, 'Box', ?, ?)", [name, user, inventory]
    )).lastID;
    const mixed = await location('Mixed');
    const colorless = await location('Colorless');
    const empty = await location('Empty');
    const unknown = await location('Unknown');
    const legacy = await location('Lorcana');
    const scoped = await location('Scoped');
    const archived = await location('Archived', 1, 'graveyard');
    const foreign = await location('Foreign', 2);
    const compartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)', [mixed])).lastID;
    const card = (id, identity, game = 'mtg') => db.run(
      'INSERT INTO card_cache (id, name, game, color_identity) VALUES (?, ?, ?, ?)', [id, id, game, identity]
    );
    for (const [id, identity, game] of [
      ['multi', '["G","U","W","U"]'], ['named', '["Red","Black"]'], ['artifact', '[]'],
      ['white', '["White"]'], ['blue', '["U"]'], ['black', '["B"]'], ['red', '["R"]'], ['green', '["G"]'],
      ['missing', null], ['invalid-json', '['], ['scalar', '"W"'], ['object', '{}'],
      ['invalid-array', '[null,{"toString":null},1]'], ['invalid-colors', '["Amber","unknown"]'],
      ['legacy-colors', '["White","Blue"]', 'lorcana'], ['legacy-empty', '[]', 'lorcana'],
    ]) await card(id, identity, game);
    const store = (id, loc, { user = 1, inventory = 'collection', quantity = 1, compartmentId = null, missing = 0 } = {}) => db.run(
      `INSERT INTO collection (card_id, user_id, location_id, compartment_id, list_type, quantity, missing)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, user, loc, compartmentId, inventory, quantity, missing]
    );
    await store('multi', mixed, { quantity: 3, compartmentId: compartment });
    await store('multi', mixed, { quantity: 2, compartmentId: compartment });
    await store('named', mixed);
    await store('artifact', mixed);
    await store('artifact', colorless);
    for (const id of ['missing', 'invalid-json', 'scalar', 'object', 'invalid-array', 'invalid-colors']) await store(id, unknown);
    await store('legacy-colors', legacy);
    await store('legacy-empty', legacy);
    await store('white', scoped, { inventory: null, missing: 1 });
    await store('blue', scoped, { user: 2 });
    await store('black', scoped, { inventory: 'graveyard' });
    await store('red', scoped, { inventory: 'arena' });
    await store('green', scoped, { inventory: 'wishlist' });
    await store('artifact', scoped, { quantity: 0 });
    await store('blue', scoped, { quantity: -1 });
    await store('legacy-colors', scoped);
    await store('legacy-empty', scoped);
    await store('red', archived, { inventory: 'graveyard' });
    await store('green', archived);
    await store('black', foreign, { user: 2 });
    await store('blue', foreign);
    await store('green', null);
    await db.run("UPDATE locations SET cover_card_id = 'blue', rule_type = 'compound', rule_config = ? WHERE id IN (?, ?)",
      ['[{"field":"color_identity","op":"includes","value":"Blue"}]', empty, scoped]);

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
      return response.json();
    };
    const locations = await summaries();
    const byId = new Map(locations.map(row => [row.id, row]));
    assert.deepEqual([...byId.keys()].sort((a, b) => a - b), [mixed, colorless, empty, unknown, legacy, scoped]);
    assert.deepEqual(byId.get(mixed).mana_symbols, ['W', 'U', 'B', 'R', 'G', 'C'], 'union uses canonical mana order, not copy count, image availability or identity order');
    assert.deepEqual(byId.get(colorless).mana_symbols, ['C']);
    assert.deepEqual(byId.get(empty).mana_symbols, [], 'cover and rules do not create contents');
    assert.deepEqual(byId.get(unknown).mana_symbols, [], 'missing, malformed and unknown identities are not colorless');
    assert.deepEqual(byId.get(legacy).mana_symbols, [], 'Lorcana never supplies MTG mana symbols');
    assert.deepEqual(byId.get(scoped).mana_symbols, ['W'], 'only positive stored copies from the same owner and inventory contribute; missing status retains storage membership');
    assert.equal(byId.get(mixed).total_cards, 5, 'slot occupancy continues to use compartment contents');
    assert.equal(byId.get(mixed).total_capacity, 9);
    assert.equal(byId.get(mixed).compartment_count, 1);
    assert.deepEqual((await summaries('graveyard')).map(row => [row.id, row.mana_symbols]), [[archived, ['R']]]);
    assert.deepEqual((await summaries('collection', 2)).map(row => [row.id, row.mana_symbols]), [[foreign, ['B']]]);

    await db.run('UPDATE locations SET allow_stacking = 1 WHERE id = ?', [mixed]);
    const stacked = (await summaries()).find(row => row.id === mixed);
    assert.equal(stacked.total_cards, 1, 'stacked copies retain one occupied slot');
    assert.deepEqual(stacked.mana_symbols, ['W', 'U', 'B', 'R', 'G', 'C']);
    await db.run("UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE card_id = 'multi'");
    assert.deepEqual((await summaries()).find(row => row.id === mixed).mana_symbols, ['B', 'R', 'C'], 'moving copies out removes their colors');
    console.log('Container mana HTTP summaries: canonical union, unknown/game boundaries, account/inventory scope, stacking and moves passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
