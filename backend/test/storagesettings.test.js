// Storage container configuration: capacity summaries, bulk capacity edits, and
// freezing a sorted layout into manual positions.
//
// Replaces test/e2e/storage_settings.test.js, which asserted the same capacity
// behaviours but spawned the whole server as a child process, seeded a session row
// by hand, and then 401'd on it — so it had been failing for as long as anyone had
// been running the e2e suite, and reported the failure as "locs.find is not a
// function". These are route-level behaviours, not full-stack ones: mounting the
// real router in THIS process with a stub req.user tests the same handlers and the
// same SQL, cannot 401, and needs no port, no mock and no child.
//
// It has to go through the router rather than re-running the queries here. The bug
// F9-TC1 guards is IN the SQL — joining compartments to collection fanned each
// compartment row out once per card and inflated total_capacity by the card count
// (see the comment on GET /locations) — and a test that copies the query only
// asserts against its own copy.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `manafolio-storagesettings-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const express = require('express');
const db = require('../src/db');

let server;

// Close the handles and let the event loop drain — no process.exit anywhere.
//
// Forcing an exit while the listening socket and the sqlite handle were still open
// aborted the process on Windows every time, with a libuv assertion from
// src/win/async.c ("!(handle->flags & UV_HANDLE_CLOSING)") raised
// AFTER all three assertions had already printed PASS. The suite then reported a
// green test as a failure, which is the worst kind of red. Closing both first and
// THEN exiting only made it intermittent; not exiting at all makes it correct, and
// node still exits 0 on its own once nothing is left pending.
async function cleanup() {
  if (server && server.listening) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => { try { db.dbConnection.close(() => resolve()); } catch { resolve(); } });
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

// The router expects authenticateToken to have run. In the app that is one gate in
// server.js; here it is one line, which is the whole reason this file needs no
// session, no token and no login.
function startApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId, role: 'admin' }; next(); });
  app.use('/api', require('../src/routes/storage'));
  return new Promise(resolve => {
    server = http.createServer(app).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function main() {
  await db.initDb();

  const user = await db.run(
    `INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)`,
    ['storage-test', db.hashPassword('x'), 'admin', `share-${process.pid}`]
  );
  const userId = user.lastID;
  const base = await startApp(userId);

  // Two compartments, capacity 400 each. All three cards go into the FIRST one —
  // that asymmetry is the point: it is what a fanned-out join multiplies by.
  const loc = await db.run(
    `INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, user_id) VALUES (?, ?, ?, ?, ?, ?)`,
    ['Cfg Box', 'Box', 'name-asc', 'normals_first', 'any', userId]
  );
  const r1 = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [loc.lastID, 1, 400]);
  await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [loc.lastID, 2, 400]);

  // Named C, B, A but inserted in that order, so "sorted" and "inserted" differ and
  // the name-asc bake below has something to actually reorder.
  for (let i = 0; i < 3; i++) {
    await db.run(
      `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
       VALUES (?, ?, 'Creature', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 1)`,
      [`c${i}`, `Card ${'CBA'[i]}`]
    );
    await db.run(
      `INSERT INTO collection (card_id, quantity, condition, printing, language, location_id, compartment_id, position, user_id)
       VALUES (?, 1, 'Near Mint', 'Normal', 'English', ?, ?, ?, ?)`,
      [`c${i}`, loc.lastID, r1.lastID, (i + 1) * 1000, userId]
    );
  }

  // 1. Capacity is the sum over compartments, not multiplied by the card count.
  const locs = await (await fetch(`${base}/api/locations`)).json();
  const box = locs.find(l => l.id === loc.lastID);
  assert.ok(box, 'the location must come back from GET /locations');
  assert.strictEqual(box.total_capacity, 800, `total_capacity must be 2*400, got ${box.total_capacity}`);
  assert.strictEqual(box.total_cards, 3, `total_cards must be 3, got ${box.total_cards}`);
  assert.strictEqual(box.compartment_count, 2, `compartment_count must be 2, got ${box.compartment_count}`);
  console.log('PASS: total_capacity sums compartments once, not once per card');

  // 2. ?updateAll=true applies a capacity to every compartment in the container.
  const patch = await fetch(`${base}/api/compartments/${r1.lastID}?updateAll=true`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capacity: 42 }),
  });
  assert.strictEqual(patch.status, 200, 'flat PATCH /compartments/:id must exist');
  const caps = (await db.all(`SELECT capacity FROM compartments WHERE location_id = ? ORDER BY idx`, [loc.lastID])).map(c => c.capacity);
  assert.deepStrictEqual(caps, [42, 42], `updateAll must set both rows, got ${caps}`);
  console.log('PASS: ?updateAll=true sets capacity on every compartment');

  // 3. Expanding a full container adds a row with the configured capacity, so
  // the filing UI can ask for exactly enough new rows before retrying placement.
  const expansion = await fetch(`${base}/api/locations/${loc.lastID}/compartments`, { method: 'POST' });
  assert.strictEqual(expansion.status, 201, 'POST /locations/:id/compartments must add capacity');
  const addedRow = await expansion.json();
  assert.strictEqual(addedRow.capacity, 42, 'a new row must inherit the configured capacity');
  console.log('PASS: expansion adds a same-capacity row');

  // 4. Switching a sorted container to Custom freezes the CURRENT sorted order into
  //    dense positions, rather than leaving the stale ones that would render
  //    jumbled the moment sorting stops being applied.
  const put = await fetch(`${base}/api/locations/${loc.lastID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sort_order: 'custom' }),
  });
  assert.strictEqual(put.status, 200, 'PUT /locations/:id must accept sort_order custom');
  const rows = await db.all(
    `SELECT cc.name, c.position FROM collection c JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.compartment_id = ? ORDER BY c.position ASC`, [r1.lastID]
  );
  assert.deepStrictEqual(rows.map(r => r.name), ['Card A', 'Card B', 'Card C'], `name-asc order must be baked in, got ${rows.map(r => r.name)}`);
  assert.deepStrictEqual(rows.map(r => r.position), [1000, 2000, 3000], `positions must densify, got ${rows.map(r => r.position)}`);
  console.log('PASS: switching to Custom bakes the sorted order into dense positions');

  // Upgrading an existing container must keep its identity, capacity, and placements.
  assert.strictEqual((await db.get('SELECT sleeved FROM locations WHERE id = ?', [loc.lastID])).sleeved, 0);
  await db.run('ALTER TABLE locations DROP COLUMN sleeved');
  const oldLocation = await db.get('SELECT * FROM locations WHERE id = ?', [loc.lastID]);
  const compartmentsBefore = await db.all('SELECT * FROM compartments WHERE location_id = ? ORDER BY id', [loc.lastID]);
  const cardsBefore = await db.all('SELECT * FROM collection ORDER BY id');
  await db.initDb();
  assert.deepStrictEqual(await db.get('SELECT * FROM locations WHERE id = ?', [loc.lastID]), { ...oldLocation, sleeved: 0 });
  assert.deepStrictEqual(await db.all('SELECT * FROM compartments WHERE location_id = ? ORDER BY id', [loc.lastID]), compartmentsBefore);
  assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), cardsBefore);

  const save = (url, method, body) => fetch(`${base}/api${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const detail = async id => (await fetch(`${base}/api/locations/${id}`)).json();
  for (const sleeved of [undefined, 0, 1, 2, 3]) {
    const created = await save('/locations', 'POST', { name: `Sleeves ${sleeved}`, type: 'Box', sleeved });
    assert.strictEqual(created.status, 200);
    assert.strictEqual((await detail((await created.json()).id)).sleeved, sleeved ?? 0);
  }
  for (const sleeved of [1, 2, 0, 3]) {
    assert.strictEqual((await save(`/locations/${loc.lastID}`, 'PUT', { sleeved })).status, 200);
    assert.strictEqual((await detail(loc.lastID)).sleeved, sleeved);
  }
  assert.strictEqual((await save(`/locations/${loc.lastID}`, 'PUT', { name: 'Renamed sleeve box' })).status, 200);
  assert.strictEqual((await detail(loc.lastID)).sleeved, 3, 'unrelated edits preserve sleeves');
  const savedLocations = await db.all('SELECT * FROM locations ORDER BY id');
  for (const sleeved of [null, '1', true, 1.5, -1, 4]) {
    assert.strictEqual((await save('/locations', 'POST', { name: 'Invalid sleeves', type: 'Box', sleeved })).status, 400);
    assert.strictEqual((await save(`/locations/${loc.lastID}`, 'PUT', { sleeved, name: 'Must not rename' })).status, 400);
    assert.deepStrictEqual(await db.all('SELECT * FROM locations ORDER BY id'), savedLocations);
  }
  for (const sleeved of [null, 0.5, -1, 4]) {
    await assert.rejects(db.run('UPDATE locations SET sleeved = ? WHERE id = ?', [sleeved, loc.lastID]), /SQLITE_CONSTRAINT/);
  }
  const otherUser = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('sleeve-other', 'unused', 'sleeve-other-token')");
  const otherLocation = await db.run("INSERT INTO locations (name, type, user_id, sleeved) VALUES ('Private sleeves', 'Box', ?, 2)", [otherUser.lastID]);
  assert.strictEqual((await save(`/locations/${otherLocation.lastID}`, 'PUT', { sleeved: 0 })).status, 404);
  assert.strictEqual((await fetch(`${base}/api/locations/${otherLocation.lastID}`)).status, 404);
  assert.strictEqual((await db.get('SELECT sleeved FROM locations WHERE id = ?', [otherLocation.lastID])).sleeved, 2);
  const sleeveLocations = await (await fetch(`${base}/api/locations`)).json();
  assert.strictEqual(sleeveLocations.find(row => row.id === loc.lastID).sleeved, 3);
  assert.ok(!sleeveLocations.some(row => row.id === otherLocation.lastID));
  await db.initDb();
  assert.strictEqual((await detail(loc.lastID)).sleeved, 3, 'initialization preserves saved sleeves');
  assert.deepStrictEqual(await db.all('SELECT * FROM compartments WHERE location_id = ? ORDER BY id', [loc.lastID]), compartmentsBefore);
  assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), cardsBefore);
  console.log('PASS: container sleeves migrate, validate, persist, and leave storage unchanged');
}

main()
  .then(() => cleanup())
  .catch(async err => {
    console.error('FAIL:', err.stack || err.message);
    await cleanup();
    process.exitCode = 1;
  });
