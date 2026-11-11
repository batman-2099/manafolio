// Run: node test/storageprices.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-storage-prices-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const express = require('express');
const { rebalanceCompartmentByScheme } = require('../src/utils/compartmentSort');
let server;

async function main() {
  await db.initDb();
  const { lastID: user } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('storage-price', 'unused', 'storage-price')");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: user }; next(); });
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/stats'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  async function request(route, body) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }
  async function location(name, sort = 'name-asc', stacking = 0) {
    const { lastID: id } = await db.run('INSERT INTO locations (name, type, sort_order, allow_stacking, user_id) VALUES (?, ?, ?, ?, ?)', [name, 'Box', sort, stacking, user]);
    const { lastID: comp } = await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)', [id]);
    return { id, comp };
  }
  async function entry(card, loc, printing = 'Normal', value = null, quantity = 1, position = 1000) {
    return (await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position, printing, market_value, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2000-01-01 00:00:00')`, [card, user, quantity, loc?.id ?? null, loc?.comp ?? null, position, printing, value])).lastID;
  }
  const rows = loc => db.all('SELECT id, position FROM collection WHERE compartment_id = ? ORDER BY position, id', [loc.comp]);
  await db.run(`INSERT INTO card_cache (id, name, game, price_trend, price_normal, price_holofoil) VALUES
    ('alpha', 'Alpha', 'mtg', 2, 2, 20), ('zulu', 'Zulu', 'mtg', 10, 10, 100)`);
  const source = await location('Source');
  const target = await location('Target');
  const alpha = await entry('alpha', source, 'Normal', null, 2);
  const remaining = await entry('zulu', source, 'Normal', null, 1, 3000);
  const zulu = await entry('zulu', target);
  assert.strictEqual((await request(`/locations/${target.id}/apply-all`, { entry_ids: [alpha] })).body.filed, 1);
  assert.deepStrictEqual(await rows(target), [{ id: alpha, position: 1000 }, { id: zulu, position: 3000 }]);
  assert.deepStrictEqual(await rows(source), [{ id: remaining, position: 1000 }]);

  const stacks = await location('Stacks', 'name-asc', 1);
  const stackedA = await entry('alpha', stacks);
  const stackedB = await entry('alpha', null);
  const stackedZ = await entry('zulu', stacks);
  assert.strictEqual((await request(`/locations/${stacks.id}/apply-all`, { entry_ids: [stackedB] })).body.filed, 1);
  assert.deepStrictEqual(await rows(stacks), [{ id: stackedA, position: 1000 }, { id: stackedB, position: 1000 }, { id: stackedZ, position: 2000 }]);
  await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [source.comp]);
  assert.strictEqual((await request(`/locations/${target.id}/apply-all`, { entry_ids: [remaining] })).body.filed, 0);
  await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [target.id]);
  const loose = await entry('alpha', null);
  assert.strictEqual((await request(`/locations/${target.id}/apply-all`, { entry_ids: [loose] })).body.filed, 0);
  await db.run('UPDATE locations SET locked = 0 WHERE id = ?', [target.id]);
  await db.run(`CREATE TRIGGER reject_rebalance BEFORE UPDATE OF position ON collection
    WHEN OLD.id = ${zulu} BEGIN SELECT RAISE(ABORT, 'rebalance failed'); END`);
  const before = await db.all('SELECT * FROM collection ORDER BY id');
  assert.strictEqual((await request(`/locations/${target.id}/apply-all`, { entry_ids: [loose] })).status, 500);
  assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), before, 'rebalance failure rolls back the move');
  await db.run('DROP TRIGGER reject_rebalance');

  const priced = await location('Priced', 'price-desc');
  const normal = await entry('zulu', priced);
  const foil = await entry('alpha', priced, 'Holofoil');
  const manual = await entry('alpha', null, 'Normal', 200);
  const rec = await request(`/locations/${priced.id}/recommend-batch`, { entry_ids: [manual] });
  assert.strictEqual(rec.body[0].recommended.position, 1000, 'manual value wins during recommendation');
  assert.strictEqual((await request(`/locations/${priced.id}/apply-all`, { entry_ids: [manual] })).body.filed, 1);
  assert.deepStrictEqual(await rows(priced), [{ id: manual, position: 1000 }, { id: foil, position: 2000 }, { id: normal, position: 3000 }]);
  const mid = await entry('alpha', null, 'Normal', 30);
  const afterManual = await request(`/locations/${priced.id}/recommend-batch`, { entry_ids: [mid] });
  assert.strictEqual(afterManual.body[0].recommended.position, 2000, 'existing manual value remains ahead of incoming copies');
  await db.withTransaction(() => rebalanceCompartmentByScheme(db, priced.comp, 'price-desc'));
  assert.deepStrictEqual((await rows(priced)).map(r => r.id), [manual, foil, normal]);

  const beforeLocations = await db.all('SELECT * FROM locations ORDER BY id');
  await db.run("CREATE TRIGGER reject_location_insert BEFORE INSERT ON locations BEGIN SELECT RAISE(ABORT, 'unexpected insert'); END");
  for (const count of [10001, '10001', Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual((await request('/locations', { name: 'Oversized', type: 'Box', compartmentPlan: { count, capacity: 1 } })).status, 400);
  }
  assert.deepStrictEqual(await db.all('SELECT * FROM locations ORDER BY id'), beforeLocations);
  await db.run('DROP TRIGGER reject_location_insert');
  assert.strictEqual((await request('/locations', { name: 'Large capacity', type: 'Box', compartmentPlan: { count: 1, capacity: 10001 } })).status, 200);

  // Isolate timeline copies: normal history moves, foil/manual values stay flat.
  await db.run('DELETE FROM collection WHERE user_id = ?', [user]);
  await entry('alpha', null);
  await entry('alpha', null, 'Holofoil');
  await entry('alpha', null, 'Normal', 200);
  await db.run(`INSERT INTO price_history (card_id, price, recorded_at) VALUES
    ('alpha', 3, datetime('now', '-10 days')), ('alpha', 7, datetime('now', '-1 day'))`);
  const history = await request('/stats/history?period=7d');
  assert.strictEqual(history.status, 200);
  assert.strictEqual(history.body[0].value, 223);
  assert.strictEqual(history.body.at(-1).value, 227);
  console.log('storageprices.test.js: all assertions passed');
}

main().then(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); })
  .catch(error => { console.error(error); server?.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
