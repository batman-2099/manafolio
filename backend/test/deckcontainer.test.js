const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-deck-container-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { checkedOutSources } = require('../src/utils/collectionHelpers');
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
app.use('/api/decks', require('../src/routes/decks'));
let server;
let base;
async function request(id, name, user = 1) {
  const response = await fetch(`${base}/api/decks/${id}/container`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
    body: JSON.stringify({ name })
  });
  return { status: response.status, body: await response.json() };
}
async function insert(table, values) {
  const keys = Object.keys(values);
  return (await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(values))).lastID;
}
const copy = (card, quantity, options = {}) => insert('collection', { card_id: card, quantity, user_id: 1, game: 'mtg', ...options });
async function deck(name, cards, options = {}) {
  const id = await insert('decks', { name, user_id: 1, ...options });
  for (const [card, quantity, source = null] of cards) await insert('deck_cards', { deck_id: id, card_id: card, quantity, source_entry_id: source });
  return id;
}
async function box(name, options = {}) {
  const location = await insert('locations', { name, type: 'Box', user_id: 1, ...options });
  const compartment = await insert('compartments', { location_id: location, idx: 1, capacity: 100 });
  return { location_id: location, compartment_id: compartment };
}
async function snapshot() {
  const result = {};
  for (const table of ['collection', 'locations', 'compartments', 'decks', 'deck_cards', 'deck_card_allocations']) {
    result[table] = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  }
  return result;
}
async function ownership() {
  // Expanding stacks compares all copy metadata, while ignoring storage and row identity.
  const copies = [];
  for (const row of await db.all('SELECT * FROM collection')) {
    const { id, quantity, location_id, compartment_id, position, ...metadata } = row;
    for (let i = 0; i < quantity; i++) copies.push(JSON.stringify(metadata));
  }
  return copies.sort();
}
async function run() {
  try {
    await db.initDb();
    await insert('users', { id: 2, username: 'other', password_hash: 'unused', share_token: 'other' });
    for (const id of ['stack', 'slab', 'preferred', 'partial', 'own', 'absent', 'alternate', 'archive', 'archived-reservation', 'rollback']) {
      await insert('card_cache', { id, name: id === 'alternate' ? 'absent' : id, game: 'mtg' });
    }
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const source = await box('Source');
    const stack = await copy('stack', 3, { ...source, position: 4000, condition: 'Lightly Played', printing: 'Holofoil', language: 'Japanese', purchase_price: 12.5, favorite: 1, is_trade: 1, added_at: '2020-01-02 03:04:05', notes: 'Keep copy history', market_value: 42, market_value_source: 'manual', market_value_at: '2026-01-01' });
    const slab = await copy('slab', 1, { grader: 'PSA', grade: '10', cert_number: 'unique-cert', notes: 'Certified single' });
    const success = await deck('Saved definition', [['stack', 2], ['slab', 1]]);
    const before = await snapshot();
    const owned = await ownership();
    const created = await request(success, '  Filed deck  ');
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(created.body, { id: created.body.id, name: 'Filed deck', inventory_type: 'collection', requested: 3, count: 3, missing: 0,
      items: [{ card_id: 'slab', name: 'slab', requested: 1, moved: 1, missing: 0 }, { card_id: 'stack', name: 'stack', requested: 2, moved: 2, missing: 0 }] });
    assert.deepStrictEqual(await ownership(), owned, 'filing preserves all owned copies and metadata');
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [stack])).quantity, 1);
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [slab])).location_id, created.body.id, 'whole single copies retain identity');
    assert.deepStrictEqual(await db.all('SELECT quantity, position FROM collection WHERE location_id = ? ORDER BY position', [created.body.id]), [{ quantity: 1, position: 1000 }, { quantity: 1, position: 2000 }, { quantity: 1, position: 3000 }]);
    assert.deepStrictEqual(await db.get('SELECT type, inventory_type, sort_order, user_id FROM locations WHERE id = ?', [created.body.id]), { type: 'Deck Box', inventory_type: 'collection', sort_order: 'custom', user_id: 1 });
    assert.ok((await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [created.body.id])).capacity >= 3);
    for (const table of ['decks', 'deck_cards', 'deck_card_allocations']) assert.deepStrictEqual((await snapshot())[table], before[table]);

    const preferredSource = await box('Preferred');
    const lead = await copy('preferred', 1, preferredSource);
    const sibling = await copy('preferred', 1, preferredSource);
    const outside = await copy('preferred', 4);
    const preferred = await deck('Restricted source', [['preferred', 3, lead]]);
    const preferredResult = await request(preferred, 'Preferred deck');
    assert.deepStrictEqual([preferredResult.status, preferredResult.body.count, preferredResult.body.missing], [201, 2, 1]);
    assert.deepStrictEqual(await db.all('SELECT id FROM collection WHERE location_id = ? ORDER BY id', [preferredResult.body.id]), [{ id: lead }, { id: sibling }]);
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [outside])).quantity, 4);

    const lockedLocation = await box('Locked location', { locked: 1 });
    const lockedCompartment = await box('Locked compartment');
    await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [lockedCompartment.compartment_id]);
    const foreign = await box('Foreign location', { user_id: 2 });
    const graveyard = await box('Graveyard', { inventory_type: 'graveyard' });
    const legacyStack = await copy('partial', 5, source);
    const legacyDeck = await deck('Legacy reservation', [['partial', 1, legacyStack]], { checked_out: 1, checked_out_at: '2026-09-01' });
    await copy('partial', 1);
    await copy('partial', 3, lockedLocation);
    await copy('partial', 3, lockedCompartment);
    await copy('partial', 3, { missing: 1 });
    await copy('partial', 3, { user_id: 2 });
    await copy('partial', 3, foreign);
    await copy('partial', 3, { ...graveyard, list_type: 'collection' });
    await copy('partial', 3, { list_type: 'arena' });
    await copy('partial', 3, { list_type: 'wishlist' });
    await copy('partial', 3, { list_type: 'graveyard' });
    await copy('partial', 2, { cert_number: 'legacy-cert' });
    await copy('partial', 3, { game: 'unsupported' });
    await copy('alternate', 3);
    const ownCopy = await copy('own', 1);
    await copy('own', 1);
    const partial = await deck('Checked out saved deck', [['partial', 8], ['own', 2], ['absent', 2]], { checked_out: 1, checked_out_at: '2026-09-02' });
    await insert('deck_card_allocations', { deck_id: partial, card_id: 'own', entry_id: ownCopy, quantity: 1 });
    // Exact allocations keep this checked-out deck from reserving additional free copies.
    await insert('deck_card_allocations', { deck_id: partial, card_id: 'partial', entry_id: legacyStack, quantity: 1 });
    const reservedBefore = await checkedOutSources(1);
    const partialBefore = await snapshot();
    const partialOwned = await ownership();
    const partialResult = await request(partial, 'Partial filing');
    assert.deepStrictEqual([partialResult.status, partialResult.body.requested, partialResult.body.count, partialResult.body.missing], [201, 12, 2, 10]);
    assert.deepStrictEqual(partialResult.body.items, [
      { card_id: 'absent', name: 'absent', requested: 2, moved: 0, missing: 2 },
      { card_id: 'own', name: 'own', requested: 2, moved: 1, missing: 1 },
      { card_id: 'partial', name: 'partial', requested: 8, moved: 1, missing: 7 }
    ]);
    assert.deepStrictEqual(await ownership(), partialOwned);
    const byReservation = (a, b) => a.deck_id - b.deck_id || a.card_id.localeCompare(b.card_id) || a.entry_id - b.entry_id;
    assert.deepStrictEqual((await checkedOutSources(1)).sort(byReservation), reservedBefore.sort(byReservation), 'including legacy allocation and this deck reservations');
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [legacyStack])).quantity, 5, 'reserved portions of legacy stacks must not be split');
    const partialAfter = await snapshot();
    for (const table of ['decks', 'deck_cards']) assert.deepStrictEqual(partialAfter[table], partialBefore[table]);
    assert.deepStrictEqual(partialAfter.deck_card_allocations.filter(row => row.deck_id !== legacyDeck), partialBefore.deck_card_allocations);
    assert.deepStrictEqual(partialAfter.deck_card_allocations.filter(row => row.deck_id === legacyDeck),
      [{ deck_id: legacyDeck, card_id: 'partial', entry_id: legacyStack, quantity: 1 }]);
    for (const row of partialBefore.collection.filter(row => ['partial', 'own', 'absent', 'alternate'].includes(row.card_id))) {
      const after = partialAfter.collection.find(candidate => candidate.id === row.id);
      if (after.location_id !== partialResult.body.id) assert.deepStrictEqual(after, row);
    }

    await insert('card_cache', { id: 'legacy-order', name: 'Legacy order', game: 'mtg' });
    const legacyReserved = await copy('legacy-order', 1, { added_at: '2020-01-02' });
    const legacyFree = await copy('legacy-order', 1, { added_at: '2020-01-01' });
    const orderLegacyDeck = await deck('Unassigned legacy checkout', [['legacy-order', 1]], { checked_out: 1 });
    const orderDeck = await deck('File unreserved copy', [['legacy-order', 2]]);
    const orderSources = (await checkedOutSources(1)).sort(byReservation);
    const orderResult = await request(orderDeck, 'Legacy order filing');
    assert.deepStrictEqual([orderResult.status, orderResult.body.count, orderResult.body.missing], [201, 1, 1]);
    assert.deepStrictEqual((await checkedOutSources(1)).sort(byReservation), orderSources,
      'filing a formerly unassigned copy must not change dynamic legacy checkout identities');
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [legacyReserved])).location_id, null);
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [legacyFree])).location_id, orderResult.body.id);
    assert.deepStrictEqual(await db.get('SELECT entry_id, quantity FROM deck_card_allocations WHERE deck_id = ?', [orderLegacyDeck]),
      { entry_id: legacyReserved, quantity: 1 });

    const archived = await copy('archive', 2, { ...graveyard, list_type: 'graveyard' });
    const physicalArchive = await copy('archive', 4);
    const archiveReserved = await copy('archived-reservation', 1, { ...graveyard, list_type: 'graveyard' });
    const archivedCheckout = await deck('Archived checked out copy', [['archived-reservation', 1]], { checked_out: 1 });
    await insert('deck_card_allocations', { deck_id: archivedCheckout, card_id: 'archived-reservation', entry_id: archiveReserved, quantity: 1 });
    const archiveDeck = await deck('Archive deck', [['archive', 3], ['archived-reservation', 1]], { inventory_type: 'graveyard' });
    const archiveOwned = await ownership();
    const archiveResult = await request(archiveDeck, 'Filed deck');
    assert.deepStrictEqual([archiveResult.status, archiveResult.body.inventory_type, archiveResult.body.count, archiveResult.body.missing], [201, 'graveyard', 2, 2]);
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [archived])).location_id, archiveResult.body.id);
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [physicalArchive])).quantity, 4);
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [archiveReserved])).location_id, graveyard.location_id);
    assert.deepStrictEqual(await ownership(), archiveOwned);
    assert.strictEqual((await db.get('SELECT inventory_type FROM locations WHERE id = ?', [archiveResult.body.id])).inventory_type, 'graveyard');

    const unavailableDeck = await deck('No owned copies', [['absent', 75]]);
    const unavailableOwned = await ownership();
    const unavailableResult = await request(unavailableDeck, 'Empty filing');
    assert.deepStrictEqual([unavailableResult.status, unavailableResult.body.requested, unavailableResult.body.count, unavailableResult.body.missing], [201, 75, 0, 75]);
    assert.ok((await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [unavailableResult.body.id])).capacity >= 75,
      'capacity must hold the saved definition, not just available copies');
    assert.deepStrictEqual(await ownership(), unavailableOwned, 'missing copies are never created');

    const arena = await deck('Arena', [['archive', 1]], { inventory_type: 'arena' });
    const empty = await deck('Empty', []);
    const foreignDeck = await deck('Foreign deck', [['archive', 1]], { user_id: 2 });
    const rejectedBefore = await snapshot();
    for (const [id, name, user, expected] of [
      [arena, 'Arena box', 1, 400], [empty, 'Empty box', 1, 400],
      [success, '', 1, 400], [success, ['Wrong type'], 1, 400], [success, 'x'.repeat(121), 1, 400],
      [success, 'Filed deck', 1, 400], [archiveDeck, 'Filed deck', 1, 400],
      [success, 'Private', 2, 404], [foreignDeck, 'Private', 1, 404], [999999, 'Missing', 1, 404], ['bad', 'Invalid', 1, 400]
    ]) assert.strictEqual((await request(id, name, user)).status, expected);
    assert.deepStrictEqual(await snapshot(), rejectedBefore, 'rejected requests must not write');
    const otherUserCopy = await copy('archive', 1, { user_id: 2 });
    const otherUserResult = await request(foreignDeck, 'Filed deck', 2);
    assert.strictEqual(otherUserResult.status, 201, 'same name in another account is allowed');
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [otherUserCopy])).location_id, otherUserResult.body.id);

    await copy('rollback', 3, source);
    const rollbackDeck = await deck('Rollback', [['rollback', 2]]);
    const rollbackBefore = await snapshot();
    await db.run(`CREATE TRIGGER fail_deck_container BEFORE INSERT ON collection
      WHEN NEW.card_id = 'rollback' AND NEW.location_id != ${source.location_id}
      BEGIN SELECT RAISE(ABORT, 'private insertion failure'); END`);
    const originalError = console.error;
    let failed;
    try {
      console.error = () => {};
      failed = await request(rollbackDeck, 'Must roll back');
    } finally {
      console.error = originalError;
      await db.run('DROP TRIGGER fail_deck_container');
    }
    assert.deepStrictEqual(failed, { status: 500, body: { error: 'Failed to create container from deck' } });
    assert.deepStrictEqual(await snapshot(), rollbackBefore, 'new storage and prior quantity decrement must all roll back');
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
run().then(() => console.log('Deck container HTTP/SQLite self-check passed')).catch(error => { console.error(error); process.exitCode = 1; });
