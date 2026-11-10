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
async function checkout(id, name, user = 1) {
  const response = await fetch(`${base}/api/decks/${id}/checkout`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
    ...(name === undefined ? {} : { body: JSON.stringify({ container_name: name }) })
  });
  return { status: response.status, body: await response.json() };
}
async function returnDeck(id) {
  const response = await fetch(`${base}/api/decks/${id}/return`, { method: 'PUT' });
  assert.strictEqual(response.status, 200);
  await response.json();
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
    const stack = await copy('stack', 3, { ...source, position: 4000, condition: 'Lightly Played', printing: 'Holofoil', foil_treatment: 'surge', language: 'Japanese', purchase_price: 12.5, favorite: 1, is_trade: 1, added_at: '2020-01-02 03:04:05', notes: 'Keep copy history', market_value: 42, market_value_source: 'manual', market_value_at: '2026-01-01' });
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

    for (const id of ['checkout-stack', 'checkout-front', 'checkout-back', 'checkout-slab', 'checkout-auto', 'checkout-blocked', 'checkout-good']) {
      await insert('card_cache', { id, name: id, game: 'mtg' });
    }
    const checkoutSource = await box('Checkout source');
    const checkoutStack = await copy('checkout-stack', 3, { ...checkoutSource, position: 1000, notes: 'preserve metadata', foil_treatment: 'surge' });
    const pairedStack = await copy('checkout-front', 3, { ...checkoutSource, position: 2000, reverse_card_id: 'checkout-back' });
    const checkoutSlab = await copy('checkout-slab', 1, { grader: 'PSA', grade: '10', cert_number: 'checkout-cert' });
    await copy('checkout-auto', 2);
    const checkoutDeck = await deck('Checkout with box', [
      ['checkout-stack', 2, checkoutStack], ['checkout-front', 1, pairedStack],
      ['checkout-back', 1, pairedStack], ['checkout-slab', 1], ['checkout-auto', 1]
    ]);
    const checkoutBefore = await snapshot();
    const checkoutOwned = await ownership();
    const checkoutReservations = (await checkedOutSources(1)).sort(byReservation);
    const boxedCheckout = await checkout(checkoutDeck, '  Checkout box  ');
    assert.deepStrictEqual(boxedCheckout, { status: 200, body: {
      message: 'Deck checked out successfully', container_id: boxedCheckout.body.container_id, container_name: 'Checkout box'
    } });
    const checkoutBoxId = boxedCheckout.body.container_id;
    assert.deepStrictEqual(await db.get('SELECT container_id, checked_out FROM decks WHERE id = ?', [checkoutDeck]),
      { container_id: checkoutBoxId, checked_out: 1 });
    assert.deepStrictEqual(await db.get('SELECT type, inventory_type, game, user_id FROM locations WHERE id = ?', [checkoutBoxId]),
      { type: 'Deck Box', inventory_type: 'collection', game: 'mtg', user_id: 1 });
    const checkoutRows = await db.all('SELECT * FROM collection WHERE location_id = ? ORDER BY position', [checkoutBoxId]);
    assert.strictEqual(checkoutRows.length, 6);
    assert.deepStrictEqual(checkoutRows.map(row => row.position), [1000, 2000, 3000, 4000, 5000, 6000]);
    assert.ok(checkoutRows.every(row => row.quantity === 1));
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [checkoutStack])).quantity, 1);
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [pairedStack])).quantity, 1);
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [checkoutSlab])).location_id, checkoutBoxId);
    const checkoutAllocations = await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ? ORDER BY card_id, entry_id', [checkoutDeck]);
    assert.strictEqual(checkoutAllocations.length, 6);
    assert.strictEqual(new Set(checkoutAllocations.map(row => row.entry_id)).size, 6, 'paired faces reserve distinct physical copies');
    assert.ok(checkoutAllocations.every(row => row.quantity === 1 && checkoutRows.some(copy => copy.id === row.entry_id
      && (copy.card_id === row.card_id || copy.reverse_card_id === row.card_id))));
    for (const cardId of ['checkout-stack', 'checkout-front', 'checkout-back']) {
      const anchor = await db.get('SELECT source_entry_id FROM deck_cards WHERE deck_id = ? AND card_id = ?', [checkoutDeck, cardId]);
      assert.ok(checkoutAllocations.some(row => row.card_id === cardId && row.entry_id === anchor.source_entry_id),
        'explicit source follows an actually moved and reserved row after splitting');
      assert.ok(![checkoutStack, pairedStack].includes(anchor.source_entry_id));
    }
    assert.deepStrictEqual(await ownership(), checkoutOwned);
    assert.deepStrictEqual((await checkedOutSources(1)).filter(row => row.deck_id !== checkoutDeck).sort(byReservation), checkoutReservations);
    const checkoutAfter = await snapshot();
    for (const table of ['decks', 'deck_cards', 'deck_card_allocations']) {
      assert.deepStrictEqual(checkoutAfter[table].filter(row => (table === 'decks' ? row.id : row.deck_id) !== checkoutDeck),
        checkoutBefore[table].filter(row => (table === 'decks' ? row.id : row.deck_id) !== checkoutDeck));
    }
    for (const row of checkoutBefore.collection.filter(row => !row.card_id.startsWith('checkout-'))) {
      assert.deepStrictEqual(checkoutAfter.collection.find(copy => copy.id === row.id), row);
    }
    assert.strictEqual((await checkout(checkoutDeck, 'Second box')).status, 409, 'repeated creation cannot replace a linked box');
    assert.deepStrictEqual(await snapshot(), checkoutAfter);
    assert.deepStrictEqual(await checkout(checkoutDeck), { status: 200, body: { message: 'Deck checked out successfully' } });
    assert.deepStrictEqual(await snapshot(), checkoutAfter, 'ordinary repeated checkout remains idempotent');
    await returnDeck(checkoutDeck);
    assert.deepStrictEqual(await db.get('SELECT container_id, checked_out FROM decks WHERE id = ?', [checkoutDeck]),
      { container_id: checkoutBoxId, checked_out: 0 });
    assert.deepStrictEqual(await db.all('SELECT * FROM collection WHERE location_id = ? ORDER BY position', [checkoutBoxId]), checkoutRows,
      'cancel/return keeps the saved container and movement');
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM deck_card_allocations WHERE deck_id = ?', [checkoutDeck])).count, 0);
    assert.strictEqual((await checkout(checkoutDeck)).status, 200, 'updated explicit source anchors support recheckout');
    const rechecked = await db.all(`SELECT a.* FROM deck_card_allocations a JOIN collection c ON c.id = a.entry_id
      WHERE a.deck_id = ? AND c.location_id = ?`, [checkoutDeck, checkoutBoxId]);
    assert.strictEqual(rechecked.reduce((total, row) => total + row.quantity, 0), 6);
    await returnDeck(checkoutDeck);
    const linkedBefore = await snapshot();
    assert.strictEqual((await checkout(checkoutDeck, 'Replace returned box')).status, 409);
    assert.deepStrictEqual(await snapshot(), linkedBefore);

    const normalSource = await copy('checkout-good', 1);
    const normalDeck = await deck('No box checkout', [['checkout-good', 1, normalSource]]);
    assert.deepStrictEqual(await checkout(normalDeck), { status: 200, body: { message: 'Deck checked out successfully' } });
    assert.strictEqual((await db.get('SELECT container_id FROM decks WHERE id = ?', [normalDeck])).container_id, null);
    const alreadyOut = await snapshot();
    assert.strictEqual((await checkout(normalDeck, 'Already out box')).status, 409);
    assert.deepStrictEqual(await snapshot(), alreadyOut);
    await returnDeck(normalDeck);

    // Every failed creation must roll back storage, linking, moves and reservation materialization.
    const rollbackGood = await copy('checkout-good', 3);
    for (const reason of ['shortage', 'locked location', 'locked compartment', 'missing', 'reserved', 'legacy reserved', 'slab stack', 'foreign user', 'explicit source']) {
      const blockedSource = await box(`Blocked ${reason}`, { locked: reason === 'locked location' ? 1 : 0 });
      if (reason === 'locked compartment') await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [blockedSource.compartment_id]);
      const blockedCopy = await copy('checkout-blocked', reason === 'slab stack' || reason === 'reserved' || reason === 'legacy reserved' ? 3 : 1, {
        ...blockedSource, missing: reason === 'missing' ? 1 : 0,
        user_id: reason === 'foreign user' ? 2 : 1,
        ...(reason === 'slab stack' ? { cert_number: 'unsplittable-cert' } : {})
      });
      if (reason === 'reserved' || reason === 'legacy reserved') {
        const reserving = await deck(`Reserving ${reason}`, [['checkout-blocked', 1, blockedCopy]], { checked_out: 1 });
        if (reason === 'reserved') await insert('deck_card_allocations', {
          deck_id: reserving, card_id: 'checkout-blocked', entry_id: blockedCopy, quantity: 1
        });
      }
      const outsideCopy = await copy('checkout-blocked', 5);
      const blockedDeck = await deck(`Cannot box ${reason}`, [
        ['checkout-good', 1, rollbackGood],
        ['checkout-blocked', reason === 'shortage' || reason === 'explicit source' ? 2 : 1, blockedCopy]
      ]);
      const blockedBefore = await snapshot();
      const rejected = await checkout(blockedDeck, `Rejected ${reason}`);
      assert.strictEqual(rejected.status, 400, reason);
      assert.ok(rejected.body.details.some(detail => detail.includes('checkout-blocked')), reason);
      assert.deepStrictEqual(await snapshot(), blockedBefore, `${reason} must not partially move, link, reserve or create a box`);
      assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [outsideCopy])).quantity, 5,
        'explicit sources cannot silently fall back to outside copies');
    }
    const reservedPairSource = await box('Reserved paired stack');
    const reservedPair = await copy('checkout-front', 3, { ...reservedPairSource, reverse_card_id: 'checkout-back' });
    const pairOwner = await deck('Reserve front face', [['checkout-front', 1, reservedPair]], { checked_out: 1 });
    await insert('deck_card_allocations', { deck_id: pairOwner, card_id: 'checkout-front', entry_id: reservedPair, quantity: 1 });
    const reverseDeck = await deck('Cannot move reserved reverse face', [['checkout-back', 1, reservedPair]]);
    const reservedPairBefore = await snapshot();
    assert.strictEqual((await checkout(reverseDeck, 'Reserved reverse box')).status, 400);
    assert.deepStrictEqual(await snapshot(), reservedPairBefore, 'a reservation on either face protects the entire paired stack');
    const shortageBefore = await snapshot();
    assert.strictEqual((await checkout(unavailableDeck, 'Automatic shortage box')).status, 400);
    assert.deepStrictEqual(await snapshot(), shortageBefore, 'automatic shortage also rolls back the new container');
    const validationBefore = await snapshot();
    for (const [id, name, user, status] of [
      [normalDeck, '', 1, 400], [normalDeck, '  ', 1, 400], [normalDeck, null, 1, 400],
      [normalDeck, ['box'], 1, 400], [normalDeck, 'x'.repeat(121), 1, 400],
      [normalDeck, 'Checkout box', 1, 400], [normalDeck, 'Private checkout', 2, 404],
      [foreignDeck, 'Private checkout', 1, 404], [999999, 'Missing checkout', 1, 404],
      [arena, 'Arena checkout', 1, 400], [archiveDeck, 'Archive checkout', 1, 400], [empty, 'Empty checkout', 1, 400]
    ]) assert.strictEqual((await checkout(id, name, user)).status, status);
    assert.deepStrictEqual(await snapshot(), validationBefore);

    const atomicDeck = await deck('Atomic checkout', [['checkout-good', 2, rollbackGood]]);
    for (const [stage, trigger] of [
      ['move', `BEFORE INSERT ON collection WHEN NEW.card_id = 'checkout-good'`],
      ['reservation', `BEFORE INSERT ON deck_card_allocations WHEN NEW.deck_id = ${atomicDeck}`],
      ['link', `BEFORE UPDATE OF container_id ON decks WHEN NEW.id = ${atomicDeck}`],
      ['checkout', `BEFORE UPDATE OF checked_out ON decks WHEN NEW.id = ${atomicDeck}`]
    ]) {
      const atomicBefore = await snapshot();
      await db.run(`CREATE TRIGGER fail_atomic_checkout ${trigger} BEGIN SELECT RAISE(ABORT, 'private ${stage} failure'); END`);
      let result;
      try {
        console.error = () => {};
        result = await checkout(atomicDeck, `Atomic ${stage} box`);
      } finally {
        console.error = originalError;
        await db.run('DROP TRIGGER fail_atomic_checkout');
      }
      assert.deepStrictEqual(result, { status: 500, body: { error: 'Failed to checkout deck' } });
      assert.deepStrictEqual(await snapshot(), atomicBefore, `${stage} failure rolls back every earlier step`);
    }
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
run().then(() => console.log('Deck container HTTP/SQLite self-check passed')).catch(error => { console.error(error); process.exitCode = 1; });
