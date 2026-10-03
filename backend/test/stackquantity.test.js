// Real SQLite regression for absolute stack quantity edits.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-stackquantity-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const { setStackQuantity } = require('../src/utils/collectionHelpers');
const express = require('express');
let server;

async function main() {
  await db.initDb();
  const { lastID: user } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('quantity', 'unused', 'quantity-share')");
  const { lastID: otherUser } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('other', 'unused', 'other-share')");
  await db.run("INSERT INTO card_cache (id, name) VALUES ('c-A', 'Card A')");
  const { lastID: location } = await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Box', 'Box', ?)", [user]);
  const { lastID: compartment } = await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 400)', [location]);
  async function add({ quantity = 1, placed = true, printing = 'Normal', owner = user } = {}) {
    const { lastID } = await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, purchase_price, location_id, compartment_id, position, notes, added_at, missing)
      VALUES ('c-A', ?, ?, ?, 2, ?, ?, 4000, 'Keep this metadata', '2020-01-02 03:04:05', 1)`,
    [owner, quantity, printing, placed ? location : null, placed ? compartment : null]);
    return lastID;
  }
  const copies = async () => (await db.get("SELECT SUM(quantity) AS n FROM collection WHERE user_id = ? AND printing = 'Normal'", [user])).n;
  const edited = await add();
  const unplaced = await add({ placed: false });
  const foil = await add({ printing: 'Holofoil' });
  const foreign = await add({ owner: otherUser, placed: false });
  assert.strictEqual(await setStackQuantity(db, user, edited, 1), -1);
  assert.strictEqual(await copies(), 1);
  assert.strictEqual(await db.get('SELECT id FROM collection WHERE id = ?', [unplaced]), undefined);
  assert.ok(await db.get('SELECT id FROM collection WHERE id = ?', [foil]));
  assert.ok(await db.get('SELECT id FROM collection WHERE id = ?', [foreign]));
  assert.strictEqual(await setStackQuantity(db, user, edited, 1), 0);
  assert.strictEqual(await setStackQuantity(db, user, edited, 3), 2);
  const grown = await db.all("SELECT quantity, compartment_id, position FROM collection WHERE user_id = ? AND printing = 'Normal'", [user]);
  assert.strictEqual(await copies(), 3);
  assert.ok(grown.every(r => r.quantity === 1 && r.compartment_id === compartment));
  assert.strictEqual(new Set(grown.map(r => r.position)).size, 3);

  await db.run('DELETE FROM collection WHERE user_id = ?', [user]);
  const stacked = await add({ quantity: 4 });
  const before = await db.get('SELECT * FROM collection WHERE id = ?', [stacked]);
  await db.initDb();
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [stacked]), before, 'database initialization retains quantity and all metadata');
  assert.strictEqual(await setStackQuantity(db, user, stacked, 2), -2);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [stacked]), { ...before, quantity: 2 });

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: user }; next(); });
  app.use('/api', require('../src/routes/collection'));
  server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const request = (url, method, body) => fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const slab = await add({ placed: false });
  await db.run("UPDATE collection SET grader = 'PSA', grade = 9, cert_number = 'quantity-cert' WHERE id = ?", [slab]);
  const slabBefore = await db.get('SELECT * FROM collection WHERE id = ?', [slab]);
  assert.strictEqual((await request(`/collection/${stacked}`, 'PUT', { quantity: 1 })).status, 200);
  assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [stacked])).quantity, 1);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [slab]), slabBefore);
  assert.strictEqual((await request(`/collection/${slab}`, 'PUT', { quantity: 2, notes: 'Must roll back' })).status, 400);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [slab]), slabBefore);
  const uncertified = await add({ quantity: 2, placed: false });
  const lowerGrade = await add({ placed: false });
  await db.run("UPDATE collection SET grader = 'PSA', grade = 9 WHERE id = ?", [uncertified]);
  await db.run("UPDATE collection SET grader = 'PSA', grade = 8 WHERE id = ?", [lowerGrade]);
  const lowerBefore = await db.get('SELECT * FROM collection WHERE id = ?', [lowerGrade]);
  assert.strictEqual((await request(`/collection/${uncertified}`, 'PUT', { quantity: 1 })).status, 200);
  assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [uncertified])).quantity, 1);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [lowerGrade]), lowerBefore);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [slab]), slabBefore);
  assert.strictEqual((await request(`/collection/${uncertified}`, 'PUT', { quantity: 2 })).status, 200);
  assert.deepStrictEqual(await db.all("SELECT grader, grade, notes, missing FROM collection WHERE grader = 'PSA' AND grade = 9 AND cert_number IS NULL ORDER BY id"),
    Array.from({ length: 2 }, () => ({ grader: 'PSA', grade: 9, notes: 'Keep this metadata', missing: 1 })));

  await db.run(`CREATE TRIGGER reject_quantity_growth BEFORE INSERT ON collection
    WHEN NEW.card_id = 'c-A' BEGIN SELECT RAISE(ABORT, 'injected quantity failure'); END`);
  const entryBefore = await db.get('SELECT * FROM collection WHERE id = ?', [stacked]);
  assert.strictEqual((await request(`/collection/${stacked}`, 'PUT', { quantity: 2, notes: 'Must roll back' })).status, 500);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [stacked]), entryBefore);
  await db.run('DROP TRIGGER reject_quantity_growth');

  await db.run("INSERT INTO card_cache (id, name, game, language) VALUES ('mtg-atomic-add', 'Atomic add', 'mtg', 'English')");
  await db.run(`CREATE TRIGGER reject_second_copy BEFORE INSERT ON collection
    WHEN NEW.card_id = 'mtg-atomic-add' AND EXISTS (SELECT 1 FROM collection WHERE card_id = NEW.card_id)
    BEGIN SELECT RAISE(ABORT, 'injected second copy failure'); END`);
  assert.strictEqual((await request('/collection', 'POST', { card_id: 'mtg-atomic-add', quantity: 2 })).status, 500);
  assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM collection WHERE card_id = 'mtg-atomic-add'")).n, 0);
  await db.run('DROP TRIGGER reject_second_copy');
  for (const quantity of ['2junk', 1.5, 0, -1, null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual((await request('/collection', 'POST', { card_id: 'mtg-atomic-add', quantity })).status, 400);
    assert.strictEqual((await request(`/collection/${stacked}`, 'PUT', { quantity })).status, 400);
    assert.strictEqual((await request('/collection/bulk-add', 'POST', { card_ids: ['mtg-atomic-add'], quantity })).status, 400);
  }
  assert.strictEqual((await request('/collection', 'POST', { card_id: 'mtg-atomic-add', quantity: '2' })).status, 200);
  assert.strictEqual((await db.get("SELECT SUM(quantity) AS n FROM collection WHERE card_id = 'mtg-atomic-add'")).n, 2);
  console.log('stackquantity.test.js passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
