// Real SQLite regression for absolute stack quantity edits.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-stackquantity-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const { setStackQuantity } = require('../src/utils/collectionHelpers');

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
  console.log('stackquantity.test.js passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
