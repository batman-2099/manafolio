// Exercise actual HTTP handlers and SQLite transactions, including failed writes.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-inventory-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const express = require('express');
const { splitPrice } = require('../src/utils/splitPrice');
let server;

async function main() {
  await db.initDb();
  const { lastID: user } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('inventory', 'unused', 'inventory-share')");
  const { lastID: other } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('other', 'unused', 'other-share')");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: user }; next(); });
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/collection'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const request = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  async function location(owner, name) {
    const { lastID: id } = await db.run("INSERT INTO locations (name, type, sort_order, user_id) VALUES (?, 'Binder', 'custom', ?)", [name, owner]);
    const compartments = [];
    for (const idx of [1, 2]) compartments.push((await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, 9)', [id, idx])).lastID);
    return { id, compartments };
  }
  const a = await location(user, 'A');
  const b = await location(user, 'B');
  const foreign = await location(other, 'Foreign');
  for (const comp of [a.compartments[0], b.compartments[0], foreign.compartments[0]]) {
    await db.run("INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'original')", [comp]);
  }
  await db.run("INSERT INTO card_cache (id, name, price_trend) VALUES ('a', 'Card A', 2), ('b', 'Card B', 8), ('zero', 'Unknown', 0)");
  async function entry(card, quantity, comp = a.compartments[0], loc = a.id, owner = user) {
    return (await db.run(`INSERT INTO collection (card_id, user_id, quantity, purchase_price, location_id, compartment_id, position, notes)
      VALUES (?, ?, ?, 7, ?, ?, 1000, 'Original notes')`, [card, owner, quantity, loc, comp])).lastID;
  }
  const misplaced = await entry('a', 1, b.compartments[0], b.id);
  const foreignEntry = await entry('a', 1, foreign.compartments[0], foreign.id, other);
  const assignments = await db.all('SELECT * FROM compartment_assignments ORDER BY compartment_id');
  const entries = await db.all('SELECT * FROM collection ORDER BY id');
  const compartments = await db.all('SELECT * FROM compartments ORDER BY id');
  for (const comp of [b.compartments[0], foreign.compartments[0], 999999]) {
    for (const method of ['PUT', 'DELETE']) {
      const result = await request(method, `/locations/${a.id}/compartments/${comp}`, { label: 'Bad change', assignedFilters: ['tampered'] });
      assert.strictEqual(result.status, 404, `${method} rejects a child outside the given parent`);
    }
  }
  assert.strictEqual((await request('PUT', `/compartments/${foreign.compartments[0]}/filters`, { filters: ['tampered'] })).status, 404);
  assert.strictEqual((await request('DELETE', `/compartments/${foreign.compartments[0]}`)).status, 404);
  assert.deepStrictEqual(await db.all('SELECT * FROM compartment_assignments ORDER BY compartment_id'), assignments);
  assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), entries);
  assert.deepStrictEqual(await db.all('SELECT * FROM compartments ORDER BY id'), compartments);
  assert.strictEqual((await request('PUT', `/locations/${a.id}/compartments/${a.compartments[0]}`, { label: 'Owned', assignedFilters: ['new'] })).status, 200);
  assert.strictEqual((await db.get('SELECT label FROM compartments WHERE id = ?', [a.compartments[0]])).label, 'Owned');
  assert.deepStrictEqual(await db.all('SELECT filter_value FROM compartment_assignments WHERE compartment_id = ?', [a.compartments[0]]), [{ filter_value: 'new' }]);

  const first = await entry('a', 4);
  const second = await entry('b', 1, a.compartments[1]);
  const { lastID: deck } = await db.run("INSERT INTO decks (user_id, name, checked_out) VALUES (?, 'Reserved', 1)", [user]);
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'a', 2, ?)", [deck, first]);
  await db.run("INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, 'a', ?, 2)", [deck, first]);
  const identities = await db.all('SELECT id, quantity, notes FROM collection ORDER BY id');
  const reservation = await db.all('SELECT * FROM deck_card_allocations');
  const split = (ids, total, method = 'equal') => request('POST', '/collection/bulk', { entry_ids: ids, action: 'purchase_split', value: { total, method } });
  assert.strictEqual((await split([first], 20)).status, 200);
  assert.strictEqual((await db.get('SELECT purchase_price FROM collection WHERE id = ?', [first])).purchase_price, 5);
  assert.strictEqual((await split([first, second, foreignEntry], 20)).status, 200);
  assert.deepStrictEqual((await db.all('SELECT purchase_price FROM collection WHERE id IN (?, ?) ORDER BY id', [first, second])).map(r => r.purchase_price), [4, 4]);
  assert.strictEqual((await db.get('SELECT purchase_price FROM collection WHERE id = ?', [foreignEntry])).purchase_price, 7);
  assert.strictEqual((await split([first, second], 20, 'weighted')).status, 200);
  assert.deepStrictEqual((await db.all('SELECT purchase_price FROM collection WHERE id IN (?, ?) ORDER BY id', [first, second])).map(r => r.purchase_price), [2.5, 10]);
  for (const method of ['equal', 'weighted']) {
    const tiny = splitPrice([1, 1, 1, 1], 0.02, method);
    assert.ok(tiny.every(n => n >= 0));
    assert.ok(Math.abs(tiny.reduce((sum, n) => sum + n, 0) - 0.02) < 1e-9);
    assert.strictEqual((await split([first, second], 0.02, method)).status, 200);
    const costs = await db.all('SELECT quantity, purchase_price FROM collection WHERE id IN (?, ?)', [first, second]);
    assert.ok(costs.every(r => r.purchase_price >= 0));
    assert.ok(Math.abs(costs.reduce((sum, r) => sum + r.quantity * r.purchase_price, 0) - 0.02) < 1e-9);
  }
  const unknown = await entry('zero', 3);
  const unknown2 = await entry('zero', 1);
  assert.strictEqual((await split([unknown, unknown2], 4, 'weighted')).status, 200);
  assert.deepStrictEqual((await db.all('SELECT purchase_price FROM collection WHERE id IN (?, ?) ORDER BY id', [unknown, unknown2])).map(r => r.purchase_price), [1, 1]);
  for (const amount of ['Infinity', 'NaN', -1]) assert.strictEqual((await split([first], amount)).status, 400);
  assert.deepStrictEqual(await db.all('SELECT id, quantity, notes FROM collection WHERE id NOT IN (?, ?) ORDER BY id', [unknown, unknown2]), identities);
  assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations'), reservation);
  assert.strictEqual((await db.get('SELECT source_entry_id FROM deck_cards WHERE deck_id = ?', [deck])).source_entry_id, first);

  const beforePrice = await db.all('SELECT id, purchase_price FROM collection ORDER BY id');
  await db.run(`CREATE TRIGGER reject_price BEFORE UPDATE OF purchase_price ON collection WHEN OLD.id = ${second} BEGIN SELECT RAISE(ABORT, 'injected second price failure'); END`);
  assert.strictEqual((await split([first, second], 100)).status, 500);
  assert.deepStrictEqual(await db.all('SELECT id, purchase_price FROM collection ORDER BY id'), beforePrice, 'a failed second price write rolls back the first');
  await db.run('DROP TRIGGER reject_price');

  const beforePlace = await db.all('SELECT id, location_id, compartment_id, position FROM collection ORDER BY id');
  await db.run(`CREATE TRIGGER reject_place BEFORE UPDATE OF compartment_id ON collection WHEN OLD.id = ${second} BEGIN SELECT RAISE(ABORT, 'injected second placement failure'); END`);
  const place = () => request('POST', `/collection/${first}/place`, { compartment_id: a.compartments[1], swap_with: second });
  assert.strictEqual((await place()).status, 500);
  assert.deepStrictEqual(await db.all('SELECT id, location_id, compartment_id, position FROM collection ORDER BY id'), beforePlace, 'a failed second swap write rolls back the first');
  await db.run('DROP TRIGGER reject_place');
  assert.strictEqual((await place()).status, 200);
  assert.strictEqual((await db.get('SELECT compartment_id FROM collection WHERE id = ?', [first])).compartment_id, a.compartments[1]);
  assert.strictEqual((await db.get('SELECT compartment_id FROM collection WHERE id = ?', [second])).compartment_id, a.compartments[0]);
  for (const route of [`/locations/${b.id}/compartments/${b.compartments[0]}`, `/compartments/${a.compartments[1]}`]) {
    assert.strictEqual((await request('DELETE', route)).status, 200);
  }
  assert.strictEqual((await db.get('SELECT compartment_id FROM collection WHERE id = ?', [misplaced])).compartment_id, null);
  assert.strictEqual((await db.get('SELECT compartment_id FROM collection WHERE id = ?', [first])).compartment_id, null);
  assert.strictEqual((await request('DELETE', `/compartments/${b.compartments[1]}`)).status, 400);
  console.log('inventorymutations.test.js passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
