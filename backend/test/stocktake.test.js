const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-stocktake-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'stocktake-test-only';
const db = require('../src/db');
let server;

async function main() {
  await db.initDb();
  await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-stocktake')");
  for (const user of [1, 2]) await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", [`stocktake-${user}`, user]);
  await db.run("UPDATE users SET api_key = 'stocktake-readonly' WHERE id = 1");
  const location = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Sample stocktake', 'Box', 1)")).lastID;
  const compartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)', [location])).lastID;
  const ids = [];
  for (let i = 0; i < 4; i++) {
    await db.run('INSERT INTO card_cache (id, name, game, set_id, number) VALUES (?, ?, ?, ?, ?)', [`stock-${i}`, `Sample ${i}`, 'mtg', 'test', String(i)]);
    ids.push((await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position, missing)
      VALUES (?, 1, ?, ?, ?, ?, ?)`, [`stock-${i}`, i + 1, location, compartment, (i + 1) * 1000, i === 0 ? 1 : 0])).lastID);
  }
  const deck = (await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Reserved sample', 1, 1)")).lastID;
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'stock-2', 1)", [deck]);
  await db.run("INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, 'stock-2', ?, 1)", [deck, ids[2]]);
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', require('../src/middleware/auth').authenticateToken);
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/importExport'));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (method, route, body, token = 'stocktake-1') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const endpoint = `/locations/${location}/stocktake`;
  const state = () => Promise.all(['collection', 'locations', 'compartments', 'decks', 'deck_cards', 'deck_card_allocations'].map(table => db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
  const before = await state();
  let snapshot = (await request('GET', endpoint)).body;
  assert.strictEqual(snapshot.entries.find(row => row.entry_id === ids[2]).reserved_quantity, 1);
  assert.deepStrictEqual(await state(), before, 'opening and abandoning a snapshot never mutates persisted state');
  const decisions = [{ entry_id: ids[0], status: 'verified' }, { entry_id: ids[1], status: 'missing', missing_quantity: 2 }];
  let payload = { revision: snapshot.revision, decisions };
  assert.strictEqual((await request('GET', endpoint, undefined, 'stocktake-2')).status, 404);
  assert.strictEqual((await request('POST', endpoint, payload, 'stocktake-2')).status, 404);
  assert.strictEqual((await request('POST', endpoint, payload, 'stocktake-readonly')).status, 403);
  assert.strictEqual((await request('POST', endpoint, payload, 'invalid')).status, 401);
  for (const status of ['verified', 'missing']) {
    assert.strictEqual((await request('POST', endpoint, { ...payload, decisions: [...decisions, { entry_id: ids[2], status, ...(status === 'missing' ? { missing_quantity: 1 } : {}) }] })).status, 409);
    assert.deepStrictEqual(await state(), before, 'a reserved row rejects the entire application');
  }
  for (const bad of [[], [decisions[0], decisions[0]], [{ entry_id: ids[0], status: 'other' }]]) {
    assert.strictEqual((await request('POST', endpoint, { ...payload, decisions: bad })).status, 400);
  }
  for (const change of [
    () => db.run('UPDATE collection SET position = position + 1000 WHERE id = ?', [ids[1]]),
    () => db.run('UPDATE collection SET quantity = quantity + 1 WHERE id = ?', [ids[1]]),
    () => db.run('UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE id = ?', [ids[1]]),
    () => db.run('UPDATE deck_card_allocations SET quantity = 2 WHERE deck_id = ?', [deck]),
  ]) {
    snapshot = (await request('GET', endpoint)).body;
    await change();
    const changed = await state();
    assert.strictEqual((await request('POST', endpoint, { revision: snapshot.revision, decisions })).status, 409);
    assert.deepStrictEqual(await state(), changed, 'stale rejection cannot partially apply');
  }
  await db.run('UPDATE collection SET location_id = ?, compartment_id = ? WHERE id = ?', [location, compartment, ids[1]]);
  decisions[1].missing_quantity = 3;
  snapshot = (await request('GET', endpoint)).body;
  payload = { revision: snapshot.revision, decisions };
  const mixedBefore = await state();
  const applied = await request('POST', endpoint, payload);
  assert.strictEqual(applied.status, 200);
  const mixedAfter = await state();
  assert.deepStrictEqual(mixedAfter[0], mixedBefore[0].map(row => ({ ...row, missing: row.id === ids[0] ? 0 : row.id === ids[1] ? 1 : row.missing })));
  assert.deepStrictEqual(mixedAfter[1], mixedBefore[1].map(row => row.id === location ? { ...row, last_checked_at: applied.body.last_checked_at } : row));
  assert.deepStrictEqual(mixedAfter.slice(2), mixedBefore.slice(2), 'layout, quantities, reservations and deck state remain intact');
  assert.ok(Number.isFinite(Date.parse(applied.body.last_checked_at)));
  assert.strictEqual((await request('POST', endpoint, payload)).status, 409, 'replaying a completed review is stale');
  const backup = (await request('GET', '/export?format=backup')).body;
  assert.strictEqual(backup.locations.find(row => row.id === location).last_checked_at, applied.body.last_checked_at);
  const restored = await request('POST', '/import', { format: 'backup', data: backup }, 'stocktake-2');
  assert.strictEqual(restored.status, 200);
  assert.strictEqual((await db.get("SELECT last_checked_at FROM locations WHERE name = 'Sample stocktake' AND user_id = 2")).last_checked_at, applied.body.last_checked_at);
  const legacy = structuredClone(backup);
  legacy.locations.forEach(row => delete row.last_checked_at);
  assert.strictEqual((await request('POST', '/import', { format: 'backup', data: legacy }, 'stocktake-2')).status, 200);
  assert.strictEqual((await db.get("SELECT last_checked_at FROM locations WHERE name = 'Sample stocktake' AND user_id = 2")).last_checked_at, null);
  for (const [missing, stacking] of [[0, 0], [1, 0], [0, 1]]) {
    const partialLocation = (await db.run("INSERT INTO locations (name, type, user_id, allow_stacking) VALUES (?, 'Box', 1, ?)", [`Partial ${missing}-${stacking}`, stacking])).lastID;
    const partialCompartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 6)', [partialLocation])).lastID;
    const source = (await db.run(`INSERT INTO collection (
      card_id, user_id, quantity, condition, printing, language, purchase_price,
      favorite, is_trade, list_type, game, added_at, notes, grader, grade,
      market_value, market_value_source, market_value_at, missing, location_id, compartment_id, position
    ) VALUES ('stock-1', 1, 5, 'Lightly Played', 'Holofoil', 'Japanese', 12.34,
      1, 1, 'collection', 'mtg', '2024-02-03 04:05:06', 'Sample copy metadata', 'PSA', 9,
      45.67, 'manual', '2024-03-04 05:06:07', ?, ?, ?, 2000)`, [missing, partialLocation, partialCompartment])).lastID;
    const untouched = (await db.run(`INSERT INTO collection
      (card_id, user_id, quantity, missing, location_id, compartment_id, position)
      VALUES ('stock-3', 1, 1, 1, ?, ?, 7000)`, [partialLocation, partialCompartment])).lastID;
    const selectedDeck = (await db.run("INSERT INTO decks (name, user_id) VALUES ('Selected partial source', 1)")).lastID;
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'stock-1', 4, ?)", [selectedDeck, source]);
    const partialEndpoint = `/locations/${partialLocation}/stocktake`;
    const partialSnapshot = (await request('GET', partialEndpoint)).body;
    const partialBefore = await state();
    for (const missingQuantity of [undefined, null, -1, 0, 1.5, 6, '2', Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await request('POST', partialEndpoint, {
        revision: partialSnapshot.revision,
        decisions: [{ entry_id: untouched, status: 'verified' }, { entry_id: source, status: 'missing', missing_quantity: missingQuantity }],
      });
      assert.strictEqual(invalid.status, 400);
      assert.deepStrictEqual(await state(), partialBefore, 'invalid missing count cannot change any rows or last-checked timestamp');
    }
    const partialPayload = { revision: partialSnapshot.revision, decisions: [{ entry_id: source, status: 'missing', missing_quantity: 2 }] };
    const partialApplied = await request('POST', partialEndpoint, partialPayload);
    assert.strictEqual(partialApplied.status, 200);
    const partialAfter = await state();
    const original = partialBefore[0].find(row => row.id === source);
    const split = partialAfter[0].find(row => row.location_id === partialLocation && row.id !== source && row.id !== untouched);
    assert.deepStrictEqual(split, { ...original, id: split.id, quantity: 2, missing: 1, position: stacking ? 2000 : 5000 });
    assert.deepStrictEqual(partialAfter[0], [...partialBefore[0].map(row => row.id === source ? { ...row, quantity: 3, missing: 0 } : row), split],
      'splitting preserves every metadata field, other entries, account ownership and found source identity');
    assert.strictEqual(partialAfter[0].filter(row => row.location_id === partialLocation && row.card_id === 'stock-1').reduce((sum, row) => sum + row.quantity, 0), 5);
    assert.deepStrictEqual(partialAfter[1], partialBefore[1].map(row => row.id === partialLocation ? { ...row, last_checked_at: partialApplied.body.last_checked_at } : row));
    assert.deepStrictEqual(partialAfter.slice(2), partialBefore.slice(2), 'splitting never changes compartments, decks, sources or reservations');
    const plan = await require('../src/utils/collectionHelpers').deckLocations(await db.get('SELECT * FROM decks WHERE id = ?', [selectedDeck]), 1);
    assert.strictEqual(plan[0].source_entry_id, source);
    assert.strictEqual(plan[0].found, 3, 'selected deck source can still supply precisely the found copies');
    assert.strictEqual(plan[0].missing, 1, 'missing split copies cannot supply a deck');
    assert.strictEqual((await request('POST', partialEndpoint, partialPayload)).status, 409);
    assert.deepStrictEqual(await state(), partialAfter, 'stale split replay never creates extra copies');
  }
  const certifiedBefore = await db.get('SELECT * FROM collection WHERE id = ?', [ids[1]]);
  await db.run("UPDATE collection SET grader = 'PSA', cert_number = 'SAMPLE-LEGACY-CERT' WHERE id = ?", [ids[1]]);
  const certifiedState = await state();
  const certifiedSnapshot = (await request('GET', endpoint)).body;
  assert.strictEqual((await request('POST', endpoint, {
    revision: certifiedSnapshot.revision,
    decisions: [{ entry_id: ids[0], status: 'missing', missing_quantity: 1 }, { entry_id: ids[1], status: 'missing', missing_quantity: 1 }],
  })).status, 400, 'legacy certified stacks cannot duplicate their unique certificate');
  assert.deepStrictEqual(await state(), certifiedState, 'a certificate conflict rejects the entire operation');
  assert.strictEqual((await request('POST', endpoint, {
    revision: certifiedSnapshot.revision,
    decisions: [{ entry_id: ids[1], status: 'verified' }],
  })).status, 200);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [ids[1]]),
    { ...certifiedBefore, grader: 'PSA', cert_number: 'SAMPLE-LEGACY-CERT', missing: 0 }, 'verified finds the entire certified stack without splitting');
  const wholeSnapshot = (await request('GET', endpoint)).body;
  assert.strictEqual((await request('POST', endpoint, {
    revision: wholeSnapshot.revision,
    decisions: [{ entry_id: ids[1], status: 'missing', missing_quantity: certifiedBefore.quantity }],
  })).status, 200);
  assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [ids[1]]),
    { ...certifiedBefore, grader: 'PSA', cert_number: 'SAMPLE-LEGACY-CERT', missing: 1 }, 'whole missing preserves certified metadata and identity');
  console.log('PASS stocktake: cancellation, authorization, reservations, stale/moved entries, atomic decisions, partial missing/found counts, validation, metadata, positions, deck source safety, certified stacks, backup/legacy restore');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
