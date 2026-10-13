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
      VALUES (?, 1, ?, ?, ?, ?, ?)`, [`stock-${i}`, i + 1, location, compartment, (i + 1) * 10000, i === 0 ? 1 : 0])).lastID);
  }
  const foreignEntry = (await db.run("INSERT INTO collection (card_id, user_id) VALUES ('stock-0', 2)")).lastID;
  const deck = (await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Reserved sample', 1, 1)")).lastID;
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'stock-2', 1)", [deck]);
  await db.run("INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, 'stock-2', ?, 1)", [deck, ids[2]]);
  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', require('../src/middleware/auth').authenticateToken);
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/importExport'));
  app.use('/api/decks', require('../src/routes/decks'));
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (method, route, body, token = 'stocktake-1') => {
    const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const state = () => Promise.all(['collection', 'locations', 'compartments', 'decks', 'deck_cards', 'deck_card_allocations'].map(table => db.all(`SELECT * FROM ${table} ORDER BY rowid`)));
  const endpoint = `/locations/${location}/stocktake`;
  const oldVerifiedAt = '2024-01-02T03:04:05.000Z';
  const initialSnapshot = (await request('GET', endpoint)).body;
  assert.ok(initialSnapshot.entries.every(row => row.last_verified_at === null), 'new entries have no fabricated verification date');
  assert.ok(initialSnapshot.entries.every(row => row.compartment_id === compartment));
  await db.run('UPDATE collection SET last_verified_at = ? WHERE user_id = 1 AND id IN (?, ?)', [oldVerifiedAt, ids[1], ids[3]]);
  const before = await state();
  let snapshot = (await request('GET', endpoint)).body;
  assert.strictEqual(snapshot.entries.find(row => row.entry_id === ids[2]).reserved_quantity, 1);
  assert.deepStrictEqual(await state(), before, 'opening and abandoning a snapshot never mutates persisted state');
  let payload = { revision: snapshot.revision, entry_id: ids[0], copy_index: 0, status: 'verified' };
  assert.strictEqual((await request('GET', endpoint, undefined, 'stocktake-2')).status, 404);
  assert.strictEqual((await request('POST', endpoint, payload, 'stocktake-2')).status, 404);
  assert.strictEqual((await request('POST', endpoint, payload, 'stocktake-readonly')).status, 403);
  assert.strictEqual((await request('POST', endpoint, payload, 'invalid')).status, 401);
  const invalidPayloads = [
    {}, { revision: snapshot.revision, decisions: [{ entry_id: ids[0], status: 'verified' }] },
    { ...payload, decisions: [] }, { ...payload, revision: 'bad' },
    ...[undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, foreignEntry, 999999].map(entry_id => ({ ...payload, entry_id })),
    ...[undefined, null, -1, 1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1].map(copy_index => ({ ...payload, copy_index })),
    ...[undefined, null, 'other', true].map(status => ({ ...payload, status })),
  ];
  for (const invalid of invalidPayloads) {
    assert.strictEqual((await request('POST', endpoint, invalid)).status, 400, JSON.stringify(invalid));
    assert.deepStrictEqual(await state(), before, 'invalid requests do not change any account');
  }
  for (const change of [
    () => db.run('UPDATE collection SET position = position + 1000 WHERE id = ?', [ids[1]]),
    () => db.run('UPDATE collection SET quantity = quantity + 1 WHERE id = ?', [ids[1]]),
    () => db.run('UPDATE collection SET location_id = NULL, compartment_id = NULL WHERE id = ?', [ids[1]]),
    () => db.run('UPDATE deck_card_allocations SET quantity = 2 WHERE deck_id = ?', [deck]),
    () => db.run('UPDATE collection SET last_verified_at = ? WHERE id = ?', ['2024-06-07T08:09:10.000Z', ids[0]]),
    () => db.run("UPDATE compartments SET label = 'Changed' WHERE id = ?", [compartment]),
    () => db.run("UPDATE locations SET name = 'Changed stocktake' WHERE id = ?", [location]),
  ]) {
    snapshot = (await request('GET', endpoint)).body;
    await change();
    const changed = await state();
    assert.strictEqual((await request('POST', endpoint, { ...payload, revision: snapshot.revision })).status, 409);
    assert.deepStrictEqual(await state(), changed, 'stale rejection cannot partially apply');
  }
  await db.run("UPDATE locations SET name = 'Sample stocktake' WHERE id = ?", [location]);
  await db.run('UPDATE collection SET location_id = ?, compartment_id = ? WHERE id = ?', [location, compartment, ids[1]]);
  snapshot = (await request('GET', endpoint)).body;
  payload = { ...payload, revision: snapshot.revision };
  const singleBefore = await state();
  const applied = await request('POST', endpoint, payload);
  assert.strictEqual(applied.status, 200);
  assert.strictEqual(applied.body.updated_entry_id, ids[0]);
  assert.notStrictEqual(applied.body.revision, snapshot.revision);
  const singleAfter = await state();
  assert.deepStrictEqual(singleAfter[0], singleBefore[0].map(row => row.id === ids[0]
    ? { ...row, missing: 0, last_verified_at: applied.body.location.last_checked_at } : row), 'one click immediately verifies only its physical copy');
  assert.deepStrictEqual(singleAfter[1], singleBefore[1].map(row => row.id === location ? { ...row, last_checked_at: applied.body.location.last_checked_at } : row));
  assert.deepStrictEqual(singleAfter.slice(2), singleBefore.slice(2));
  const reopened = (await request('GET', endpoint)).body;
  const { updated_entry_id, ...returnedSnapshot } = applied.body;
  assert.deepStrictEqual(returnedSnapshot, reopened, 'POST returns a fresh committed snapshot, not its input revision');
  assert.deepStrictEqual(await state(), singleAfter, 'reopening has no persistence side effects');
  assert.strictEqual((await request('POST', endpoint, payload)).status, 409, 'replaying an immediately saved click is stale');

  const backup = (await request('GET', '/export?format=backup')).body;
  assert.strictEqual(backup.locations.find(row => row.id === location).last_checked_at, applied.body.location.last_checked_at);
  assert.deepStrictEqual(backup.collection.map(row => row.last_verified_at), singleAfter[0].filter(row => row.user_id === 1).map(row => row.last_verified_at));
  const restored = await request('POST', '/import', { format: 'backup', data: backup }, 'stocktake-2');
  assert.strictEqual(restored.status, 200);
  const restoredLocation = await db.get("SELECT * FROM locations WHERE name = 'Sample stocktake' AND user_id = 2");
  assert.strictEqual(restoredLocation.last_checked_at, applied.body.location.last_checked_at);
  const restoredSnapshot = (await request('GET', `/locations/${restoredLocation.id}/stocktake`, undefined, 'stocktake-2')).body;
  assert.deepStrictEqual(restoredSnapshot.entries.map(row => [row.card_id, row.last_verified_at]),
    reopened.entries.map(row => [row.card_id, row.last_verified_at]), 'backup roundtrip preserves per-entry dates');
  for (const date of ['', 'not-a-date', '2024-01-02', '2024-01-02T03:04:05Z', '2024-13-02T03:04:05.000Z', 123, {}]) {
    const invalidBackup = structuredClone(backup);
    invalidBackup.collection[0].last_verified_at = date;
    const beforeInvalidRestore = await state();
    const invalidRestore = await request('POST', '/import', { format: 'backup', data: invalidBackup }, 'stocktake-2');
    assert.strictEqual(invalidRestore.status, 400);
    assert.match(invalidRestore.body.error, /verification date/);
    assert.deepStrictEqual(await state(), beforeInvalidRestore, 'invalid dates reject before replacing account data');
  }
  const legacy = structuredClone(backup);
  legacy.locations.forEach(row => delete row.last_checked_at);
  legacy.collection.forEach(row => delete row.last_verified_at);
  assert.strictEqual((await request('POST', '/import', { format: 'backup', data: legacy }, 'stocktake-2')).status, 200);
  assert.strictEqual((await db.get("SELECT last_checked_at FROM locations WHERE name = 'Sample stocktake' AND user_id = 2")).last_checked_at, null);
  assert.ok((await db.all('SELECT last_verified_at FROM collection WHERE user_id = 2')).every(row => row.last_verified_at === null),
    'legacy backups restore absent per-entry dates as unknown');

  for (const missing of [0, 1]) for (const stacking of [0, 1]) for (const copyIndex of [0, 2, 4]) for (const status of ['verified', 'missing']) {
    const previousVerifiedAt = stacking ? null : oldVerifiedAt;
    const splitLocation = (await db.run("INSERT INTO locations (name, type, user_id, allow_stacking) VALUES (?, 'Box', 1, ?)", [`Split ${missing}-${stacking}-${copyIndex}-${status}`, stacking])).lastID;
    const splitCompartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 6)', [splitLocation])).lastID;
    const source = (await db.run(`INSERT INTO collection (
      card_id, user_id, quantity, condition, printing, language, purchase_price,
      favorite, is_trade, list_type, game, added_at, notes, grader, grade,
      market_value, market_value_source, market_value_at, missing, location_id, compartment_id, position, last_verified_at
    ) VALUES ('stock-1', 1, 5, 'Lightly Played', 'Holofoil', 'Japanese', 12.34,
      1, 1, 'collection', 'mtg', '2024-02-03 04:05:06', 'Sample copy metadata', 'PSA', 9,
      45.67, 'manual', '2024-03-04 05:06:07', ?, ?, ?, 2000, ?)`, [missing, splitLocation, splitCompartment, previousVerifiedAt])).lastID;
    await db.run(`INSERT INTO collection (card_id, user_id, quantity, missing, location_id, compartment_id, position)
      VALUES ('stock-3', 1, 1, 1, ?, ?, 7000)`, [splitLocation, splitCompartment]);
    const selectedDeck = (await db.run("INSERT INTO decks (name, user_id) VALUES ('Selected split source', 1)")).lastID;
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'stock-1', 5, ?)", [selectedDeck, source]);
    const splitEndpoint = `/locations/${splitLocation}/stocktake`;
    const splitSnapshot = (await request('GET', splitEndpoint)).body;
    const splitBefore = await state();
    const splitPayload = { revision: splitSnapshot.revision, entry_id: source, copy_index: copyIndex, status };
    if (copyIndex === 2) {
      await db.run(`CREATE TRIGGER reject_stocktake BEFORE UPDATE OF last_checked_at ON locations
        BEGIN SELECT RAISE(ABORT, 'injected stocktake failure'); END`);
      assert.strictEqual((await request('POST', splitEndpoint, splitPayload)).status, 500);
      assert.deepStrictEqual(await state(), splitBefore, 'a late failure rolls back all splits, status, dates and source identities');
      await db.run('DROP TRIGGER reject_stocktake');
    }
    const splitApplied = await request('POST', splitEndpoint, splitPayload);
    assert.strictEqual(splitApplied.status, 200);
    assert.notStrictEqual(splitApplied.body.revision, splitSnapshot.revision);
    const splitAfter = await state();
    const original = splitBefore[0].find(row => row.id === source);
    const parts = splitAfter[0].filter(row => row.location_id === splitLocation && row.card_id === 'stock-1');
    const selected = parts.find(row => row.id === splitApplied.body.updated_entry_id);
    assert.ok(selected, 'the response identifies the clicked single-copy row');
    assert.deepStrictEqual(selected, { ...original, id: selected.id, quantity: 1,
      position: stacking ? 2000 : 2000 + copyIndex * 1000,
      missing: status === 'missing' ? 1 : 0,
      last_verified_at: status === 'verified' ? splitApplied.body.location.last_checked_at : previousVerifiedAt });
    const untouchedParts = parts.filter(row => row.id !== selected.id);
    const expectedParts = [
      { quantity: copyIndex, position: 2000 },
      { quantity: 4 - copyIndex, position: stacking ? 2000 : 2000 + (copyIndex + 1) * 1000 },
    ].filter(row => row.quantity > 0);
    assert.deepStrictEqual(untouchedParts.map(row => ({ quantity: row.quantity, position: row.position })).sort((a, b) => a.position - b.position || a.quantity - b.quantity),
      expectedParts.sort((a, b) => a.position - b.position || a.quantity - b.quantity), 'first, middle and last splits keep their physical slots');
    for (const row of untouchedParts) assert.deepStrictEqual(row, { ...original, id: row.id, quantity: row.quantity, position: row.position }, 'unselected copies retain all status, date and metadata');
    assert.strictEqual(parts.reduce((sum, row) => sum + row.quantity, 0), 5);
    assert.deepStrictEqual(splitAfter[0].filter(row => !parts.includes(row)), splitBefore[0].filter(row => row.id !== source), 'other rows and accounts are unchanged');
    assert.deepStrictEqual(splitAfter[1], splitBefore[1].map(row => row.id === splitLocation ? { ...row, last_checked_at: splitApplied.body.location.last_checked_at } : row));
    assert.deepStrictEqual(splitAfter.slice(2), splitBefore.slice(2), 'splitting leaves layout, decks, selected sources and reservations unchanged');
    const { updated_entry_id: selectedId, ...freshSnapshot } = splitApplied.body;
    assert.deepStrictEqual((await request('GET', splitEndpoint)).body, freshSnapshot);
    const plan = await require('../src/utils/collectionHelpers').deckLocations(await db.get('SELECT * FROM decks WHERE id = ?', [selectedDeck]), 1);
    const found = (missing ? 0 : 4) + (status === 'verified' ? 1 : 0);
    assert.strictEqual(plan[0].source_entry_id, source);
    assert.strictEqual(plan[0].found, found, 'selected source still sees every found split copy');
    assert.strictEqual(plan[0].missing, 5 - found);
    assert.strictEqual((await request('POST', splitEndpoint, splitPayload)).status, 409);
    assert.deepStrictEqual(await state(), splitAfter, 'replay cannot create extra copies');
    const reverse = await request('POST', splitEndpoint, { revision: freshSnapshot.revision, entry_id: selectedId, copy_index: 0, status: status === 'verified' ? 'missing' : 'verified' });
    assert.strictEqual(reverse.status, 200);
    assert.strictEqual(reverse.body.updated_entry_id, selectedId);
    assert.deepStrictEqual((await state())[0], splitAfter[0].map(row => row.id === selectedId ? {
      ...row, missing: status === 'verified' ? 1 : 0,
      last_verified_at: status === 'verified' ? selected.last_verified_at : reverse.body.location.last_checked_at,
    } : row), 'reversing the same tile changes only that copy; Missing never erases actual verification');
    const reversedPlan = await require('../src/utils/collectionHelpers').deckLocations(await db.get('SELECT * FROM decks WHERE id = ?', [selectedDeck]), 1);
    assert.strictEqual(reversedPlan[0].found, (missing ? 0 : 4) + (status === 'missing' ? 1 : 0));
  }

  const sourceLocation = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Source continuity', 'Box', 1)")).lastID;
  const sourceCompartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 5)', [sourceLocation])).lastID;
  const lead = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, missing, location_id, compartment_id, position)
    VALUES ('stock-0', 1, 3, 1, ?, ?, 1000)`, [sourceLocation, sourceCompartment])).lastID;
  const sourceDeck = (await db.run("INSERT INTO decks (name, user_id) VALUES ('Continuous source', 1)")).lastID;
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'stock-0', 3, ?)", [sourceDeck, lead]);
  const sourceEndpoint = `/locations/${sourceLocation}/stocktake`;
  let sourceSnapshot = (await request('GET', sourceEndpoint)).body;
  const firstFound = await request('POST', sourceEndpoint, { revision: sourceSnapshot.revision, entry_id: lead, copy_index: 0, status: 'verified' });
  assert.strictEqual(firstFound.status, 200);
  const remaining = firstFound.body.entries.find(row => row.quantity === 2);
  const secondFound = await request('POST', sourceEndpoint, { revision: firstFound.body.revision, entry_id: remaining.entry_id, copy_index: 0, status: 'verified' });
  assert.strictEqual(secondFound.status, 200);
  // Existing source groups include variants; the fallback must retain that contract.
  await db.run("UPDATE collection SET printing = 'Holofoil', language = 'Japanese' WHERE id = ?", [secondFound.body.updated_entry_id]);
  sourceSnapshot = (await request('GET', sourceEndpoint)).body;
  const missingLead = { revision: sourceSnapshot.revision, entry_id: lead, copy_index: 0, status: 'missing' };
  const sourceBefore = await state();
  await db.run(`CREATE TRIGGER reject_stocktake BEFORE UPDATE OF last_checked_at ON locations
    BEGIN SELECT RAISE(ABORT, 'injected source rollback'); END`);
  assert.strictEqual((await request('POST', sourceEndpoint, missingLead)).status, 500);
  assert.deepStrictEqual(await state(), sourceBefore, 'source reassignment rolls back with the copy status and timestamp');
  await db.run('DROP TRIGGER reject_stocktake');
  const sourceSaved = await request('POST', sourceEndpoint, missingLead);
  assert.strictEqual(sourceSaved.status, 200);
  assert.strictEqual(sourceSaved.body.updated_entry_id, lead, 'source reassignment must not confuse the clicked identity');
  const sourcePlan = await require('../src/utils/collectionHelpers').deckLocations(await db.get('SELECT * FROM decks WHERE id = ?', [sourceDeck]), 1);
  assert.strictEqual(sourcePlan[0].source_entry_id, secondFound.body.updated_entry_id);
  assert.strictEqual(sourcePlan[0].found, 1, 'marking the old source Missing must not hide another found copy in its group');
  assert.strictEqual(sourcePlan[0].missing, 2);

  for (const legacy of [false, true]) for (const quantity of [1, 5]) for (const copyIndex of quantity === 1 ? [0] : [0, 2, 4]) for (const status of ['verified', 'missing']) {
    const reservedLocation = (await db.run("INSERT INTO locations (name, type, user_id, allow_stacking) VALUES ('Reserved stocktake', 'Box', 1, 0)")).lastID;
    const reservedCompartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 20)', [reservedLocation])).lastID;
    const source = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, missing, location_id, compartment_id, position, last_verified_at)
      VALUES ('stock-0', 1, ?, ?, ?, ?, 1000, ?)`, [quantity, status === 'verified' ? 1 : 0, reservedLocation, reservedCompartment, oldVerifiedAt])).lastID;
    const otherSource = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id, position)
      VALUES ('stock-0', 1, 2, ?, ?, 10000)`, [reservedLocation, reservedCompartment])).lastID;
    const reservedDecks = [];
    const originalAllocations = [];
    for (const [index, needed] of (quantity === 1 ? [3] : [2, 4]).entries()) {
      const reservedDeck = (await db.run(`INSERT INTO decks (name, user_id, checked_out, checked_out_at)
        VALUES ('Reserved split deck', 1, 1, '2024-05-06 07:08:09')`)).lastID;
      reservedDecks.push(reservedDeck);
      await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id, checked_out) VALUES (?, 'stock-0', ?, ?, 1)", [reservedDeck, needed, source]);
      const take = quantity === 1 ? 1 : legacy && index === 1 ? 3 : 2;
      originalAllocations.push({ deck_id: reservedDeck, card_id: 'stock-0', entry_id: source, quantity: take });
      if (quantity === 1 || index === 1) originalAllocations.push({ deck_id: reservedDeck, card_id: 'stock-0', entry_id: otherSource, quantity: needed - take });
    }
    if (!legacy) for (const allocation of originalAllocations) {
      await db.run('INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)',
        [allocation.deck_id, allocation.card_id, allocation.entry_id, allocation.quantity]);
    }
    const reservedEndpoint = `/locations/${reservedLocation}/stocktake`;
    const reservedBefore = await state();
    const reservedSnapshot = (await request('GET', reservedEndpoint)).body;
    assert.strictEqual(reservedSnapshot.entries.find(row => row.entry_id === source).reserved_quantity, quantity === 1 ? 1 : legacy ? 5 : 4);
    assert.deepStrictEqual(await state(), reservedBefore, 'reading legacy reservations does not materialize them');
    const reservedPayload = { revision: reservedSnapshot.revision, entry_id: source, copy_index: copyIndex, status };
    await db.run(`CREATE TRIGGER reject_stocktake BEFORE UPDATE OF last_checked_at ON locations
      BEGIN SELECT RAISE(ABORT, 'injected reserved stocktake failure'); END`);
    assert.strictEqual((await request('POST', reservedEndpoint, reservedPayload)).status, 500);
    assert.deepStrictEqual(await state(), reservedBefore, 'late failure rolls back splits, allocation redistribution and legacy materialization');
    await db.run('DROP TRIGGER reject_stocktake');
    const reservedSaved = await request('POST', reservedEndpoint, reservedPayload);
    assert.strictEqual(reservedSaved.status, 200, `${legacy ? 'legacy' : 'persisted'} reserved copy can be ${status}`);
    const reservedAfter = await state();
    const parts = reservedAfter[0].filter(row => row.location_id === reservedLocation && row.id !== otherSource).sort((a, b) => a.position - b.position);
    const selected = parts.find(row => row.id === reservedSaved.body.updated_entry_id);
    assert.strictEqual(selected.quantity, 1);
    assert.strictEqual(selected.position, 1000 + copyIndex * 1000);
    assert.strictEqual(selected.missing, status === 'missing' ? 1 : 0);
    assert.strictEqual(selected.last_verified_at, status === 'verified' ? reservedSaved.body.location.last_checked_at : oldVerifiedAt);
    assert.strictEqual(parts.reduce((sum, row) => sum + row.quantity, 0), quantity);
    assert.deepStrictEqual(reservedAfter[3], reservedBefore[3], 'stocktake never checks in or otherwise changes decks');
    assert.deepStrictEqual(reservedAfter[4], reservedBefore[4], 'deck contents, pull flags and selected sources remain unchanged');
    assert.deepStrictEqual(reservedAfter[0].filter(row => !parts.includes(row)), reservedBefore[0].filter(row => row.id !== source));
    const allocations = reservedAfter[5].filter(row => reservedDecks.includes(row.deck_id));
    const expected = originalAllocations.filter(row => row.entry_id === otherSource);
    let offset = 0;
    for (const allocation of originalAllocations.filter(row => row.entry_id === source)) {
      for (const part of parts) {
        const start = (part.position - 1000) / 1000;
        const take = Math.min(offset + allocation.quantity, start + part.quantity) - Math.max(offset, start);
        if (take > 0) expected.push({ ...allocation, entry_id: part.id, quantity: take });
      }
      offset += allocation.quantity;
    }
    const allocationOrder = (a, b) => a.deck_id - b.deck_id || a.entry_id - b.entry_id;
    assert.deepStrictEqual(allocations.sort(allocationOrder), expected.sort(allocationOrder),
      'each deck keeps its allocated copy ranges, including every other legacy source');
    for (const part of parts) {
      const reserved = allocations.filter(row => row.entry_id === part.id).reduce((sum, row) => sum + row.quantity, 0);
      assert.ok(reserved <= part.quantity, 'split rows cannot reserve more copies than they contain');
      assert.strictEqual(reservedSaved.body.entries.find(row => row.entry_id === part.id).reserved_quantity, reserved);
    }
    assert.strictEqual((await request('POST', reservedEndpoint, reservedPayload)).status, 409);
    assert.deepStrictEqual(await state(), reservedAfter, 'stale clicks cannot redistribute reservations again');
    for (const reservedDeck of reservedDecks) {
      const plan = await request('GET', `/decks/${reservedDeck}/locations`);
      assert.strictEqual(plan.status, 200);
      assert.strictEqual(plan.body[0].missing, 0, 'return list retains reserved copies even after Missing');
      assert.strictEqual(plan.body[0].found, originalAllocations.filter(row => row.deck_id === reservedDeck).reduce((sum, row) => sum + row.quantity, 0));
      assert.deepStrictEqual(plan.body[0].locations.map(row => ({
        entry_id: row.entry_id, quantity: row.take, location_id: row.location_id, compartment_id: row.compartment_id, position: row.position,
      })).sort((a, b) => a.entry_id - b.entry_id), allocations.filter(row => row.deck_id === reservedDeck).map(row => {
        const entry = reservedAfter[0].find(entry => entry.id === row.entry_id);
        return { entry_id: entry.id, quantity: row.quantity, location_id: reservedLocation, compartment_id: reservedCompartment, position: entry.position };
      }).sort((a, b) => a.entry_id - b.entry_id), 'return list uses the actual split rows and original storage slots');
      assert.strictEqual((await request('PUT', `/decks/${reservedDeck}/return`)).status, 200);
      assert.strictEqual((await db.get('SELECT checked_out FROM decks WHERE id = ?', [reservedDeck])).checked_out, 0);
      assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [reservedDeck]), []);
      assert.deepStrictEqual((await state())[0], reservedAfter[0], 'explicit check-in leaves placement, quantity and stocktake evidence intact');
    }
  }

  await db.run("UPDATE collection SET grader = 'PSA', cert_number = 'SAMPLE-LEGACY-CERT' WHERE id = ?", [ids[1]]);
  const certifiedState = await state();
  const certifiedSnapshot = (await request('GET', endpoint)).body;
  for (const status of ['verified', 'missing']) {
    const rejected = await request('POST', endpoint, { revision: certifiedSnapshot.revision, entry_id: ids[1], copy_index: 0, status });
    assert.strictEqual(rejected.status, 400, 'certified stacks cannot duplicate their unique certificate for either status');
    assert.match(rejected.body.error, /certified copy cannot be split/);
    assert.deepStrictEqual(await state(), certifiedState);
  }
  await db.run("UPDATE collection SET grader = 'PSA', cert_number = 'SAMPLE-SINGLE-CERT' WHERE id = ?", [ids[0]]);
  for (const status of ['missing', 'verified', 'missing']) {
    const current = (await request('GET', endpoint)).body;
    const original = await db.get('SELECT * FROM collection WHERE id = ?', [ids[0]]);
    const saved = await request('POST', endpoint, { revision: current.revision, entry_id: ids[0], copy_index: 0, status });
    assert.strictEqual(saved.status, 200, 'certified single copies do not need splitting');
    assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [ids[0]]), { ...original,
      missing: status === 'missing' ? 1 : 0, last_verified_at: status === 'verified' ? saved.body.location.last_checked_at : original.last_verified_at });
  }
  // A future timestamp also exercises repeated identical clicks with a non-advancing clock.
  await db.run("UPDATE locations SET last_checked_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [location]);
  const repeatSnapshot = (await request('GET', endpoint)).body;
  const repeatPayload = { revision: repeatSnapshot.revision, entry_id: ids[0], copy_index: 0, status: 'missing' };
  const repeated = await request('POST', endpoint, repeatPayload);
  assert.strictEqual(repeated.status, 200);
  assert.strictEqual(repeated.body.location.last_checked_at, '2099-01-01T00:00:00.001Z');
  assert.notStrictEqual(repeated.body.revision, repeatSnapshot.revision);
  assert.strictEqual((await request('POST', endpoint, repeatPayload)).status, 409);


  const archivedLocation = (await db.run("INSERT INTO locations (name, type, user_id, inventory_type) VALUES ('Archived stocktake', 'Box', 1, 'graveyard')")).lastID;
  const archivedEntry = (await db.run("INSERT INTO collection (card_id, user_id, list_type, location_id, quantity) VALUES ('stock-0', 1, 'graveyard', ?, 2)", [archivedLocation])).lastID;
  const archivedEndpoint = `/locations/${archivedLocation}/stocktake`;
  const archivedSnapshot = (await request('GET', archivedEndpoint)).body;
  const archivedSaved = await request('POST', archivedEndpoint, { revision: archivedSnapshot.revision, entry_id: archivedEntry, copy_index: 1, status: 'verified' });
  assert.strictEqual(archivedSaved.status, 200);
  assert.ok((await db.all('SELECT list_type FROM collection WHERE location_id = ?', [archivedLocation])).every(row => row.list_type === 'graveyard'));
  await db.run("UPDATE collection SET list_type = 'collection' WHERE id = ?", [archivedEntry]);
  const mismatched = await state();
  assert.strictEqual((await request('GET', archivedEndpoint)).status, 409);
  assert.strictEqual((await request('POST', archivedEndpoint, { revision: archivedSaved.body.revision, entry_id: archivedEntry, copy_index: 0, status: 'missing' })).status, 409);
  assert.deepStrictEqual(await state(), mismatched, 'inventory mismatch rejects without moving or converting copies');
  console.log('PASS stocktake: immediate single-copy saves, fresh snapshots, split slots/stacks, unchanged metadata, reverse status, verification dates, authorization, reservations, stale/replay, validation, atomic rollback, deck sources, certified copies, inventories, backup/legacy restore');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
