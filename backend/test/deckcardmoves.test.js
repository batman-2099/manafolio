const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-deck-card-moves-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { moveDeckCardChanges } = require('../src/utils/deckCardMoves');
const { checkedOutSources } = require('../src/utils/collectionHelpers');

async function insert(table, values) {
  const keys = Object.keys(values);
  return (await db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(values))).lastID;
}
async function box(name, options = {}) {
  const location_id = await insert('locations', { name, type: 'Box', user_id: 1, sort_order: 'custom', ...options });
  const compartment_id = await insert('compartments', { location_id, idx: 1, capacity: 100 });
  return { location_id, compartment_id };
}
const card = (card_id, quantity = 1, source_entry_id = null) => ({ card_id, quantity, source_entry_id });
const copy = (card_id, quantity = 1, options = {}) => insert('collection', { card_id, quantity, user_id: 1, position: 1000, ...options });
const row = id => db.get('SELECT * FROM collection WHERE id = ?', [id]);
async function snapshot() {
  const state = {};
  for (const table of ['collection', 'decks', 'deck_cards', 'deck_card_allocations']) state[table] = await db.all(`SELECT * FROM ${table} ORDER BY rowid`);
  return state;
}
async function ownership() {
  const result = [];
  for (const entry of await db.all('SELECT * FROM collection')) {
    const { id, quantity, location_id, compartment_id, position, ...metadata } = entry;
    for (let i = 0; i < quantity; i++) result.push(JSON.stringify(metadata));
  }
  return result.sort();
}
async function fixture(before = [], inventory = 'collection') {
  await db.run('DELETE FROM deck_card_allocations');
  await db.run('DELETE FROM deck_cards');
  await db.run('DELETE FROM decks');
  await db.run('DELETE FROM collection');
  await db.run('DELETE FROM locations');
  const linked = await box('Linked', { inventory_type: inventory });
  const outside = await box('Outside', { inventory_type: inventory });
  const destination = await box('Destination', { inventory_type: inventory });
  const id = await insert('decks', { name: 'Original', user_id: 1, inventory_type: inventory, container_id: linked.location_id });
  for (const item of before) await insert('deck_cards', { ...item, deck_id: id });
  const deck = await db.get('SELECT * FROM decks WHERE id = ?', [id]);
  const beforeCards = await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [id]);
  const moves = { container_id: linked.location_id, before_cards: before.map(({ card_id, quantity }) => ({ card_id, quantity })), removed_location_id: null };
  const apply = (afterCards, changes = {}) => db.withTransaction(() => moveDeckCardChanges({ userId: 1, deck, beforeCards, afterCards, moves, ...changes }));
  return { linked, outside, destination, deck, beforeCards, moves, apply };
}
async function rejectsUnchanged(callback, status = 400) {
  const before = await snapshot();
  await assert.rejects(callback, error => error.status === status);
  assert.deepStrictEqual(await snapshot(), before);
}

async function main() {
  try {
    await db.initDb();
    await insert('users', { id: 2, username: 'other-card-moves', password_hash: 'test', share_token: 'other-card-moves-token' });
    for (const id of ['a', 'b', 'c', 'front', 'back']) {
      await insert('card_cache', { id, name: id, game: 'mtg', set_name: 'Test Set', set_id: 'tst', types: '[]', supertype: id === 'front' || id === 'back' ? 'Token' : 'Creature' });
    }

    // Quantity decreases split metadata-preserving copies; increases prefer
    // eligible spare linked copies before bringing in an outside stack.
    let f = await fixture([card('a', 3), card('b', 1)]);
    const original = await copy('a', 4, { ...f.linked, notes: 'Keep notes', favorite: 1, purchase_price: 4.25, printing: 'Holofoil', foil_treatment: 'foil', last_verified_at: '2026-11-01' });
    await copy('b', 2, f.linked);
    const outside = await copy('b', 3, { ...f.outside, language: 'German', condition: 'Lightly Played' });
    const owned = await ownership();
    const desired = [card('a', 1), card('b', 4)];
    const desiredSnapshot = JSON.stringify(desired);
    await f.apply(desired);
    assert.equal(JSON.stringify(desired), desiredSnapshot, 'caller cards are not mutated');
    assert.equal((await row(original)).quantity, 2, 'retained and unrelated copies stay in original stack');
    assert.equal((await row(outside)).quantity, 1);
    assert.deepStrictEqual(await db.all("SELECT quantity, compartment_id, position FROM collection WHERE card_id = 'a' AND location_id IS NULL"), [
      { quantity: 1, compartment_id: null, position: 0 }, { quantity: 1, compartment_id: null, position: 0 },
    ]);
    assert.equal((await db.get("SELECT SUM(quantity) AS n FROM collection WHERE card_id = 'b' AND location_id = ?", [f.linked.location_id])).n, 4);
    assert.deepStrictEqual(await ownership(), owned);

    // Explicit outside groups remain binding, including a split source anchor.
    f = await fixture();
    const selected = await copy('a', 3, { ...f.outside, notes: 'Selected stack' });
    await copy('a', 1, f.linked);
    let saved = await f.apply([card('a', 2, selected)]);
    assert.notEqual(saved[0].source_entry_id, selected);
    assert.equal((await row(saved[0].source_entry_id)).location_id, f.linked.location_id);
    assert.equal((await row(selected)).quantity, 1);
    assert.equal((await db.get('SELECT SUM(quantity) AS n FROM collection WHERE location_id = ?', [f.linked.location_id])).n, 3);
    f = await fixture();
    const insufficientSelected = await copy('a', 1, f.outside);
    await copy('a', 3, f.linked);
    await rejectsUnchanged(() => f.apply([card('a', 2, insufficientSelected)]));
    f = await fixture();
    const slab = await copy('a', 1, { ...f.outside, cert_number: 'single-slab', grader: 'PSA', grade: '10' });
    saved = await f.apply([card('a', 1, slab)]);
    assert.equal(saved[0].source_entry_id, slab);
    assert.equal((await row(slab)).cert_number, 'single-slab');
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM collection WHERE cert_number = 'single-slab'")).n, 1);

    // An existing linked anchor does not prevent an increase from using outside copies.
    f = await fixture([card('a')]);
    const anchor = await copy('a', 1, f.linked);
    await copy('a', 2, f.outside);
    saved = await f.apply([card('a', 3, anchor)]);
    assert.equal(saved[0].source_entry_id, anchor, 'surviving linked preferences remain stable');
    assert.equal((await row(saved[0].source_entry_id)).location_id, f.linked.location_id);
    assert.equal((await row(anchor)).location_id, f.linked.location_id);
    // A single preference cannot represent copies spread across compartments.
    for (const anchoredInside of [false, true]) {
      f = await fixture(anchoredInside ? [card('a')] : []);
      await db.run('UPDATE compartments SET capacity = 1 WHERE id = ?', [f.linked.compartment_id]);
      await insert('compartments', { location_id: f.linked.location_id, idx: 2, capacity: 1 });
      const splitAnchor = anchoredInside
        ? await copy('a', 1, f.linked) : await copy('a', 2, f.outside);
      if (anchoredInside) await copy('a', 1, f.outside);
      saved = await f.apply([card('a', 2, splitAnchor)]);
      assert.equal(saved[0].source_entry_id, null, 'split linked groups become Automatic');
      const placed = await db.all("SELECT compartment_id, quantity FROM collection WHERE card_id = 'a' AND location_id = ?", [f.linked.location_id]);
      assert.equal(new Set(placed.map(entry => entry.compartment_id)).size, 2);
      assert.equal(placed.reduce((sum, entry) => sum + entry.quantity, 0), 2);
    }

    // Preserve retained physical identities across paired-face changes.
    f = await fixture([card('front')]);
    const retainedPair = await copy('front', 1, { ...f.linked, reverse_card_id: 'back' });
    await rejectsUnchanged(() => f.apply([card('front'), card('back')]));
    assert.equal((await row(retainedPair)).location_id, f.linked.location_id);
    f = await fixture([card('front'), card('back')]);
    const pair = await copy('front', 1, { ...f.linked, reverse_card_id: 'back' });
    const standalone = await copy('front', 1, f.linked);
    await f.apply([card('front')], { moves: { ...f.moves, removed_location_id: f.destination.location_id } });
    assert.equal((await row(pair)).location_id, f.destination.location_id, 'planner reassigns retained front to standalone copy');
    assert.equal((await row(standalone)).location_id, f.linked.location_id);
    f = await fixture([card('front')]);
    await copy('front', 1, { ...f.linked, reverse_card_id: 'back' });
    await rejectsUnchanged(() => f.apply([card('back')]), 400);

    // Source location, compartment locks, missing copies, malformed slabs and
    // foreign ownership never become eligible just because a delta needs them.
    for (const restriction of ['location', 'compartment', 'missing', 'slab', 'foreign', 'inventory']) {
      f = await fixture();
      const options = { ...f.outside };
      if (restriction === 'location') await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [f.outside.location_id]);
      if (restriction === 'compartment') await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [f.outside.compartment_id]);
      if (restriction === 'missing') options.missing = 1;
      if (restriction === 'slab') options.cert_number = 'unique-slab';
      if (restriction === 'foreign') options.user_id = 2;
      if (restriction === 'inventory') options.list_type = 'graveyard';
      await copy('a', restriction === 'slab' ? 2 : 1, options);
      await rejectsUnchanged(() => f.apply([card('a')]));
    }
    f = await fixture([card('a')]);
    await copy('a', 1, f.linked);
    await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [f.linked.compartment_id]);
    await rejectsUnchanged(() => f.apply([]));

    // Legacy reservations are frozen; whole reserved stacks stay untouched.
    f = await fixture();
    const reserved = await copy('a', 3, f.outside);
    const otherDeck = await insert('decks', { name: 'Checked out', user_id: 1, checked_out: 1 });
    await insert('deck_cards', { deck_id: otherDeck, card_id: 'a', quantity: 1, source_entry_id: reserved });
    await rejectsUnchanged(() => f.apply([card('a')]));
    const free = await copy('a');
    const reservationBefore = await checkedOutSources(1);
    const reservedBefore = await row(reserved);
    await f.apply([card('a')]);
    assert.deepStrictEqual(await row(reserved), reservedBefore);
    assert.deepStrictEqual(await checkedOutSources(1), reservationBefore);
    assert.equal((await row(free)).location_id, f.linked.location_id);

    // Placement chooses the next usable compartment, obeys capacity and rules,
    // and leaves valid stacking duplicates in their shared pocket.
    f = await fixture();
    await db.run('UPDATE compartments SET capacity = 1 WHERE id = ?', [f.linked.compartment_id]);
    await copy('b', 1, f.linked);
    const nextCompartment = await insert('compartments', { location_id: f.linked.location_id, idx: 2, capacity: 1 });
    const incoming = await copy('a', 2, f.outside);
    await f.apply([card('a')]);
    assert.equal((await db.get("SELECT compartment_id FROM collection WHERE card_id = 'a' AND location_id = ?", [f.linked.location_id])).compartment_id, nextCompartment);
    await rejectsUnchanged(() => f.apply([card('a', 3)]));
    assert.equal((await row(incoming)).quantity, 1);
    f = await fixture();
    await db.run('UPDATE locations SET allow_stacking = 1 WHERE id = ?', [f.linked.location_id]);
    await db.run('UPDATE compartments SET capacity = 1 WHERE id = ?', [f.linked.compartment_id]);
    await copy('a', 1, f.linked);
    await copy('a', 2, f.outside);
    await f.apply([card('a', 3)]);
    assert.deepStrictEqual((await db.all('SELECT position FROM collection WHERE location_id = ?', [f.linked.location_id])).map(entry => entry.position), [1000, 1000, 1000]);
    for (const restriction of ['location', 'compartment', 'rules', 'foreign', 'inventory', 'game']) {
      f = await fixture([card('a')]);
      await copy('a', 1, f.linked);
      if (restriction === 'location') await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [f.destination.location_id]);
      if (restriction === 'compartment') await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [f.destination.compartment_id]);
      if (restriction === 'rules') await db.run('UPDATE compartments SET rule_config = ? WHERE id = ?', [JSON.stringify({ rules: [{ action: 'include', field: 'set_name', operator: 'equals', value: 'Other Set' }] }), f.destination.compartment_id]);
      if (restriction === 'foreign') await db.run('UPDATE locations SET user_id = 2 WHERE id = ?', [f.destination.location_id]);
      if (restriction === 'inventory') await db.run("UPDATE locations SET inventory_type = 'graveyard' WHERE id = ?", [f.destination.location_id]);
      if (restriction === 'game') await db.run("UPDATE locations SET game = 'pokemon' WHERE id = ?", [f.destination.location_id]);
      await rejectsUnchanged(() => f.apply([], { moves: { ...f.moves, removed_location_id: f.destination.location_id } }));
    }
    f = await fixture();
    await copy('a', 1, f.outside);
    await db.run('UPDATE locations SET rule_type = ?, rule_config = ? WHERE id = ?', [
      'compound', JSON.stringify({ rules: [{ action: 'include', field: 'set_name', operator: 'equals', value: 'Other Set' }] }), f.linked.location_id,
    ]);
    await rejectsUnchanged(() => f.apply([card('a')]));
    f = await fixture();
    await copy('a', 1, f.outside);
    await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [f.destination.location_id]);
    await rejectsUnchanged(() => f.apply([card('a')], { moves: { ...f.moves, removed_location_id: f.destination.location_id } }));

    // Baseline comparisons are exact and order-independent, even after the AI
    // caller has deleted its old rows within the surrounding transaction.
    f = await fixture([card('a'), card('b')]);
    await copy('a', 1, f.linked);
    await copy('b', 1, f.linked);
    for (const moves of [
      { ...f.moves, container_id: f.outside.location_id },
      { ...f.moves, before_cards: [card('a', 2), card('b')] },
      { ...f.moves, before_cards: [card('a')] },
    ]) await rejectsUnchanged(() => f.apply([], { moves }), 409);
    for (const moves of [null, {}, { ...f.moves, removed_location_id: undefined },
      { ...f.moves, before_cards: [card('a'), card('a')] }, { ...f.moves, removed_location_id: f.linked.location_id }]) {
      await rejectsUnchanged(() => f.apply([], { moves }));
    }
    const noMoves = await snapshot();
    await f.apply([], { moves: undefined });
    assert.deepStrictEqual(await snapshot(), noMoves);
    await db.withTransaction(async () => {
      await db.run('DELETE FROM deck_cards WHERE deck_id = ?', [f.deck.id]);
      await moveDeckCardChanges({ userId: 1, deck: f.deck, beforeCards: f.beforeCards, afterCards: [], moves: { ...f.moves, before_cards: [...f.moves.before_cards].reverse() } });
    });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM collection WHERE location_id IS NULL')).n, 2);

    // A later placement failure rolls back earlier removals and deck mutations.
    f = await fixture([card('a', 2)]);
    await copy('a', 2, f.linked);
    await copy('b', 2, f.outside);
    await db.run('UPDATE compartments SET rule_config = ? WHERE id = ?', [
      JSON.stringify({ rules: [{ action: 'include', field: 'name', operator: 'equals', value: 'a' }] }), f.linked.compartment_id,
    ]);
    await rejectsUnchanged(() => db.withTransaction(async () => {
      await db.run("UPDATE decks SET name = 'Must roll back' WHERE id = ?", [f.deck.id]);
      await moveDeckCardChanges({ userId: 1, deck: f.deck, beforeCards: f.beforeCards, afterCards: [card('b', 2)], moves: f.moves });
    }));
    // A later caller failure also rolls back a fully successful movement.
    await rejectsUnchanged(() => db.withTransaction(async () => {
      await moveDeckCardChanges({ userId: 1, deck: f.deck, beforeCards: f.beforeCards, afterCards: [], moves: f.moves });
      throw Object.assign(new Error('Later save failed'), { status: 503 });
    }), 503);

    // Graveyard uses its own inventory, no physical source preferences, and
    // cannot steal a physically reserved copy that was subsequently archived.
    f = await fixture([card('a')], 'graveyard');
    await copy('a', 1, { ...f.linked, list_type: 'graveyard' });
    const archived = await copy('b', 2, { ...f.outside, list_type: 'graveyard' });
    const physical = await copy('b', 5);
    saved = await f.apply([card('b', 1, physical)]);
    assert.equal(saved[0].source_entry_id, null);
    assert.equal((await row(archived)).quantity, 1);
    assert.equal((await row(physical)).quantity, 5);
    f = await fixture([], 'graveyard');
    const reservedArchive = await copy('a', 1, { ...f.outside, list_type: 'graveyard' });
    const checkout = await insert('decks', { name: 'Reserved archive', user_id: 1, checked_out: 1 });
    await insert('deck_cards', { deck_id: checkout, card_id: 'a', quantity: 1 });
    await insert('deck_card_allocations', { deck_id: checkout, card_id: 'a', entry_id: reservedArchive, quantity: 1 });
    await rejectsUnchanged(() => f.apply([card('a')]));
    console.log('Deck card movement SQLite regressions passed');
  } finally {
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
