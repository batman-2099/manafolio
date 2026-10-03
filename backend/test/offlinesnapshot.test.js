// Real SQLite and the production auth gate; all records below are synthetic.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const axios = require('axios');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-offlinesnapshot-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
let server;
let externalRequests = 0;
const originalAdapter = axios.defaults.adapter;
axios.defaults.adapter = async () => {
  externalRequests++;
  throw new Error('Offline snapshot must not contact providers');
};

async function main() {
  await db.initDb();
  async function account(username) {
    const { lastID } = await db.run(`INSERT INTO users
      (username, password_hash, share_token, api_key, psa_api_token)
      VALUES (?, 'private-password', ?, ?, 'private-provider-key')`,
    [username, `${username}-share`, `${username}-api-key`]);
    await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '2999-01-01 00:00:00')",
      [`${username}-session`, lastID]);
    return lastID;
  }
  const user = await account('offline-owner');
  const other = await account('offline-other');
  const empty = await account('offline-empty');
  await db.run(`INSERT INTO card_cache
    (id, name, printed_name, set_id, set_name, number, color_identity, image_url, price_trend)
    VALUES ('mtg-offline', 'Sample Card', 'Beispielkarte', 'mtg-tst', 'Sample Set', '007', '["U","R"]', 'https://private-art.invalid', 99)`);
  await db.run("INSERT INTO card_cache (id, name) VALUES ('mtg-legacy-offline', 'Legacy Sample')");
  const { lastID: unit } = await db.run("INSERT INTO storage_units (user_id, name) VALUES (?, 'Sample Shelf')", [user]);
  const { lastID: foreignUnit } = await db.run("INSERT INTO storage_units (user_id, name) VALUES (?, 'Other Private Shelf')", [other]);
  async function location(owner, storageUnit, name) {
    const { lastID: id } = await db.run("INSERT INTO locations (name, type, user_id, storage_unit_id) VALUES (?, 'Binder', ?, ?)",
      [name, owner, storageUnit]);
    const { lastID: compartment } = await db.run("INSERT INTO compartments (location_id, idx, label) VALUES (?, 2, ?)",
      [id, `${name} Page`]);
    return { id, compartment };
  }
  const ownLocation = await location(user, unit, 'Sample Binder');
  const foreignLocation = await location(other, foreignUnit, 'Other Private Binder');
  const crossUnitLocation = await location(user, foreignUnit, 'Own Container');
  async function entry({ owner = user, quantity = 1, list = 'collection', missing = 0, placed = ownLocation,
    card = 'mtg-offline', compartment = placed?.compartment } = {}) {
    const { lastID } = await db.run(`INSERT INTO collection
      (user_id, card_id, quantity, list_type, missing, location_id, compartment_id, position,
       printing, language, condition, notes, purchase_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, 3000, 'Holofoil', 'German', 'Lightly Played', 'private note', 42)`,
    [owner, card, quantity, list, missing, placed?.id ?? null, compartment ?? null]);
    return lastID;
  }
  const physical = await entry({ quantity: 4 });
  const secondPhysical = await entry({ quantity: 5 });
  const missing = await entry({ quantity: 3, missing: 1 });
  const unassigned = await entry({ quantity: 2, placed: null });
  const arena = await entry({ quantity: 8, list: 'arena' });
  const wishlist = await entry({ quantity: 9, list: 'wishlist' });
  const graveyard = await entry({ quantity: 10, list: 'graveyard' });
  const foreignEntry = await entry({ owner: other, placed: foreignLocation, quantity: 11 });
  // Legacy malformed ownership links must not disclose another account's storage.
  const crossLocation = await entry({ placed: foreignLocation });
  const crossCompartment = await entry({ compartment: foreignLocation.compartment });
  const crossUnit = await entry({ placed: crossUnitLocation });
  const legacy = await entry({ card: 'mtg-legacy-offline', quantity: 2, missing: 1 });
  async function deck({ owner = user, inventory = 'collection', checkedOut = 1, source = physical,
    quantity = 1, card = 'mtg-offline', allocate = true } = {}) {
    const { lastID } = await db.run(`INSERT INTO decks (user_id, name, inventory_type, checked_out, notes)
      VALUES (?, 'Private deck name', ?, ?, 'private deck note')`, [owner, inventory, checkedOut]);
    await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, ?, ?, ?)',
      [lastID, card, quantity, source]);
    if (allocate) await db.run('INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)',
      [lastID, card, source, quantity]);
  }
  await deck();
  await deck({ quantity: 2 });
  await deck({ source: secondPhysical });
  await deck({ source: legacy, card: 'mtg-legacy-offline', allocate: false });
  await deck({ owner: other, quantity: 20 });
  await deck({ inventory: 'arena', source: arena, quantity: 7 });
  await deck({ inventory: 'arena', quantity: 7 });
  await deck({ checkedOut: 0, quantity: 6 });

  const app = express();
  app.use('/api', require('../src/middleware/auth').authenticateToken);
  app.use('/api', require('../src/routes/collection'));
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const request = (token, query = '') => fetch(`http://127.0.0.1:${server.address().port}/api/collection/offline-snapshot${query}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.strictEqual((await request()).status, 401);
  assert.strictEqual((await request('invalid-token')).status, 401);
  const response = await request('offline-owner-session', `?user_id=${other}&list_type=graveyard&limit=1`);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('cache-control'), 'no-store');
  const snapshot = await response.json();
  assert.deepStrictEqual(Object.keys(snapshot).sort(), ['cards', 'saved_at', 'user_id', 'username', 'version']);
  assert.strictEqual(snapshot.version, 1);
  assert.strictEqual(snapshot.user_id, user);
  assert.strictEqual(snapshot.username, 'offline-owner');
  assert.strictEqual(new Date(snapshot.saved_at).toISOString(), snapshot.saved_at);
  const expectedIds = [physical, secondPhysical, missing, unassigned, arena, wishlist, crossLocation, crossCompartment, crossUnit, legacy];
  assert.deepStrictEqual(snapshot.cards.map(card => card.entry_id), expectedIds);
  const cards = new Map(snapshot.cards.map(card => [card.entry_id, card]));
  const fields = ['entry_id', 'card_id', 'name', 'printed_name', 'set_id', 'set_name', 'number', 'quantity', 'list_type',
    'printing', 'language', 'condition', 'color_identity', 'missing', 'location_id', 'location_name', 'storage_unit_name',
    'location_type', 'compartment_idx', 'compartment_label', 'position', 'reserved_quantity'].sort();
  for (const card of snapshot.cards) assert.deepStrictEqual(Object.keys(card).sort(), fields);
  assert.deepStrictEqual(cards.get(physical), {
    entry_id: physical, card_id: 'mtg-offline', name: 'Sample Card', printed_name: 'Beispielkarte',
    set_id: 'mtg-tst', set_name: 'Sample Set', number: '007', quantity: 4, list_type: 'collection',
    printing: 'Holofoil', language: 'German', condition: 'Lightly Played', color_identity: ['U', 'R'], missing: 0,
    location_id: ownLocation.id, location_name: 'Sample Binder', storage_unit_name: 'Sample Shelf', location_type: 'Binder',
    compartment_idx: 2, compartment_label: 'Sample Binder Page', position: 3000, reserved_quantity: 3
  });
  assert.strictEqual(cards.get(secondPhysical).reserved_quantity, 1);
  assert.strictEqual(cards.get(secondPhysical).quantity, 5);
  assert.strictEqual(cards.get(missing).missing, 1);
  assert.strictEqual(cards.get(missing).quantity, 3);
  assert.strictEqual(cards.get(missing).reserved_quantity, 0);
  assert.strictEqual(cards.get(legacy).reserved_quantity, 1, 'legacy checkout uses the existing exact source fallback');
  assert.deepStrictEqual(cards.get(legacy).color_identity, []);
  for (const id of [unassigned, arena, wishlist, crossLocation]) {
    for (const field of ['location_id', 'location_name', 'storage_unit_name', 'location_type', 'compartment_idx', 'compartment_label', 'position']) {
      assert.strictEqual(cards.get(id)[field], null, `${id}: ${field}`);
    }
    assert.strictEqual(cards.get(id).reserved_quantity, 0);
  }
  assert.strictEqual(cards.get(arena).quantity, 8);
  assert.strictEqual(cards.get(wishlist).quantity, 9);
  assert.strictEqual(cards.get(crossCompartment).compartment_idx, null);
  assert.strictEqual(cards.get(crossCompartment).compartment_label, null);
  assert.strictEqual(cards.get(crossUnit).storage_unit_name, null);
  assert.ok(!cards.has(graveyard) && !cards.has(foreignEntry));
  assert.ok(!JSON.stringify(snapshot).includes('private'));
  const otherSnapshot = await (await request('offline-other-session')).json();
  assert.strictEqual(otherSnapshot.user_id, other);
  assert.deepStrictEqual(otherSnapshot.cards.map(card => card.entry_id), [foreignEntry]);
  const emptySnapshot = await (await request('offline-empty-session')).json();
  assert.strictEqual(emptySnapshot.user_id, empty);
  assert.deepStrictEqual(emptySnapshot.cards, []);
  const apiSnapshot = await (await request('offline-owner-api-key')).json();
  assert.deepStrictEqual(apiSnapshot.cards, snapshot.cards, 'existing read-only API key gate is preserved');
  assert.strictEqual(externalRequests, 0);
  console.log('offlinesnapshot.test.js passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  axios.defaults.adapter = originalAdapter;
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
