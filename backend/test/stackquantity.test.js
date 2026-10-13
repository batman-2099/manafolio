// Real SQLite/HTTP regression: quantity and metadata belong to one stored entry.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-entryquantity-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const { checkedOutSources } = require('../src/utils/collectionHelpers');
const cardApi = require('../src/utils/cardApi');
const express = require('express');
let server;

async function main() {
  await db.initDb();
  const { lastID: user } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('quantity', 'unused', 'quantity-share')");
  const { lastID: otherUser } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('other', 'unused', 'other-share')");
  await db.run("INSERT INTO card_cache (id, name) VALUES ('c-A', 'Card A'), ('c-localized', 'Localized A')");
  const { lastID: location } = await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Box', 'Box', ?)", [user]);
  const { lastID: compartment } = await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 400)', [location]);
  const { lastID: otherLocation } = await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Other box', 'Box', ?)", [user]);
  const { lastID: otherCompartment } = await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 400)', [otherLocation]);
  async function add({ quantity = 1, placed = true, printing = 'Normal', owner = user, list = 'collection', missing = 1 } = {}) {
    const { lastID } = await db.run(`INSERT INTO collection (card_id, user_id, quantity, printing, purchase_price, location_id, compartment_id, position, notes, added_at, missing, list_type)
      VALUES ('c-A', ?, ?, ?, 2, ?, ?, 4000, 'Keep this metadata', '2020-01-02 03:04:05', ?, ?)`,
    [owner, quantity, printing, placed ? location : null, placed ? compartment : null, missing, list]);
    return lastID;
  }
  const row = id => db.get('SELECT * FROM collection WHERE id = ?', [id]);
  const snapshot = () => db.all('SELECT * FROM collection ORDER BY id');
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
  const update = (id, body) => request(`/collection/${id}`, 'PUT', body);
  const edited = await add();
  await add({ quantity: 4, placed: false });
  const elsewhere = await add({ quantity: 4 });
  await db.run('UPDATE collection SET location_id = ?, compartment_id = ? WHERE id = ?', [otherLocation, otherCompartment, elsewhere]);
  await add({ printing: 'Holofoil' });
  const foreign = await add({ owner: otherUser, placed: false });
  await add({ list: 'arena', placed: false });
  await add({ list: 'graveyard', placed: false });
  const untouched = (await snapshot()).filter(entry => entry.id !== edited);
  const original = await row(edited);
  assert.strictEqual((await update(edited, { quantity: 2 })).status, 200);
  assert.deepStrictEqual(await row(edited), { ...original, quantity: 2 });
  assert.deepStrictEqual((await snapshot()).filter(entry => entry.id !== edited), untouched, 'other containers, unassigned copies, finishes, owners and inventories are byte-equivalent');
  const afterGrowth = await snapshot();
  assert.strictEqual((await update(edited, { quantity: 2, location_id: location, compartment_id: compartment })).status, 200);
  assert.deepStrictEqual(await snapshot(), afterGrowth, 'saving the same absolute quantity is idempotent');
  assert.strictEqual((await update(edited, { quantity: 1, printing: 'Holofoil', condition: 'Lightly Played', purchase_price: 5, notes: 'Only this entry' })).status, 200);
  assert.deepStrictEqual(await row(edited), { ...original, quantity: 1, printing: 'Holofoil', condition: 'Lightly Played', purchase_price: 5, notes: 'Only this entry' });
  assert.deepStrictEqual((await snapshot()).filter(entry => entry.id !== edited), untouched, 'finish and quantity edits must not trim the destination stack');
  assert.strictEqual((await update(foreign, { quantity: 9, notes: 'Forbidden' })).status, 404);
  assert.strictEqual((await update(999999, { quantity: 9 })).status, 404);
  assert.deepStrictEqual((await snapshot()).filter(entry => entry.id !== edited), untouched);

  const stacked = await add({ quantity: 4 });
  const before = await row(stacked);
  await db.initDb();
  assert.deepStrictEqual(await row(stacked), before, 'startup retains legacy quantity and metadata');
  assert.strictEqual((await update(stacked, { quantity: '2' })).status, 200);
  assert.deepStrictEqual(await row(stacked), { ...before, quantity: 2 });
  const slab = await add({ placed: false });
  await db.run("UPDATE collection SET grader = 'PSA', grade = 9, cert_number = 'quantity-cert' WHERE id = ?", [slab]);
  const slabBefore = await row(slab);
  assert.strictEqual((await update(slab, { quantity: 2, notes: 'Must roll back' })).status, 400);
  assert.deepStrictEqual(await row(slab), slabBefore);
  assert.strictEqual((await update(stacked, { grader: 'PSA', grade: 9, cert_number: 'new-cert' })).status, 400);
  assert.deepStrictEqual(await row(stacked), { ...before, quantity: 2 }, 'certifying a multi-copy entry also rolls back');
  assert.strictEqual((await update(slab, { grader: 'Raw', quantity: 2 })).status, 200);
  assert.deepStrictEqual(await row(slab), { ...slabBefore, quantity: 2, grader: 'Raw', grade: null, cert_number: null });

  await db.run(`CREATE TRIGGER reject_quantity_growth BEFORE UPDATE OF quantity ON collection
    WHEN NEW.quantity > OLD.quantity BEGIN SELECT RAISE(ABORT, 'injected quantity failure'); END`);
  const beforeFailure = await snapshot();
  assert.strictEqual((await update(stacked, { quantity: 3, notes: 'Must roll back', printing: 'Holofoil' })).status, 500);
  assert.deepStrictEqual(await snapshot(), beforeFailure);
  await db.run('DROP TRIGGER reject_quantity_growth');

  for (const legacy of [false, true]) {
    const cardId = `reserved-${legacy}`;
    await db.run('INSERT INTO card_cache (id, name) VALUES (?, ?)', [cardId, cardId]);
    const reserved = await add({ quantity: 4, missing: 0 });
    const sibling = await add({ quantity: 3, missing: 0, placed: false });
    await db.run('UPDATE collection SET card_id = ? WHERE id IN (?, ?)', [cardId, reserved, sibling]);
    const { lastID: deck } = await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Reserved', ?, 1)", [user]);
    await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, ?, 3, ?)', [deck, cardId, reserved]);
    if (!legacy) await db.run('INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, 3)', [deck, cardId, reserved]);
    const sources = await checkedOutSources(user);
    assert.strictEqual(sources.find(source => source.deck_id === deck).entry_id, reserved);
    const allBefore = await snapshot();
    for (const body of [{ quantity: 2, notes: 'Rejected' }, { list_type: 'arena' }, { list_type: 'wishlist' }, { list_type: 'graveyard' }]) {
      assert.strictEqual((await update(reserved, body)).status, 409);
      assert.deepStrictEqual(await snapshot(), allBefore, 'reservation violations roll back every collection field');
    }
    const localize = cardApi.printingInLanguage;
    cardApi.printingInLanguage = async () => ({ id: 'c-localized' });
    try {
      assert.strictEqual((await update(reserved, { language: 'Japanese', quantity: 3 })).status, 409);
      assert.deepStrictEqual(await snapshot(), allBefore, 'localized identity cannot strand an allocation');
    } finally { cardApi.printingInLanguage = localize; }
    assert.strictEqual((await update(reserved, { quantity: 3, missing: true, notes: 'Still checked out' })).status, 200);
    assert.strictEqual((await row(reserved)).missing, 1, 'Missing remains permitted for checked-out copies');
    assert.strictEqual((await row(reserved)).quantity, 3);
    assert.deepStrictEqual(await row(sibling), allBefore.find(entry => entry.id === sibling));
    assert.deepStrictEqual(await checkedOutSources(user), sources, 'legacy reservations are frozen rather than silently reallocated');
    assert.strictEqual((await update(reserved, { quantity: 2 })).status, 409, 'Missing copies retain their reservation floor');
  }

  await db.run("INSERT INTO card_cache (id, name) VALUES ('legacy-growth', 'Legacy growth')");
  const legacyLead = await add({ missing: 0 });
  const legacyTail = await add({ quantity: 2, missing: 0 });
  await db.run("UPDATE collection SET card_id = 'legacy-growth' WHERE id IN (?, ?)", [legacyLead, legacyTail]);
  const { lastID: legacyDeck } = await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Legacy growth', ?, 1)", [user]);
  await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'legacy-growth', 3, ?)", [legacyDeck, legacyLead]);
  const growthSources = await checkedOutSources(user);
  const tailBefore = await row(legacyTail);
  assert.strictEqual((await update(legacyLead, { quantity: 4 })).status, 200);
  assert.deepStrictEqual(await row(legacyTail), tailBefore);
  assert.deepStrictEqual(await checkedOutSources(user), growthSources, 'growing an earlier legacy source must not steal later reservations');

  const archived = await add({ list: 'graveyard', placed: false });
  assert.strictEqual((await update(archived, { quantity: 5, notes: 'Archive edit' })).status, 200);
  assert.strictEqual((await row(archived)).quantity, 5, 'Graveyard entry quantity is still editable');
  await db.run("INSERT INTO card_cache (id, name, game, language) VALUES ('mtg-atomic-add', 'Atomic add', 'mtg', 'English')");
  await db.run(`CREATE TRIGGER reject_second_copy BEFORE INSERT ON collection
    WHEN NEW.card_id = 'mtg-atomic-add' AND EXISTS (SELECT 1 FROM collection WHERE card_id = NEW.card_id)
    BEGIN SELECT RAISE(ABORT, 'injected second copy failure'); END`);
  assert.strictEqual((await request('/collection', 'POST', { card_id: 'mtg-atomic-add', quantity: 2 })).status, 500);
  assert.strictEqual((await db.get("SELECT COUNT(*) AS n FROM collection WHERE card_id = 'mtg-atomic-add'")).n, 0);
  await db.run('DROP TRIGGER reject_second_copy');
  const boundaryBefore = await snapshot();
  for (const quantity of ['2junk', '', 1.5, 0, -1, null, true, Number.MAX_SAFE_INTEGER + 1]) {
    assert.strictEqual((await request('/collection', 'POST', { card_id: 'mtg-atomic-add', quantity })).status, 400);
    assert.strictEqual((await update(stacked, { quantity, notes: 'Rejected' })).status, 400);
    assert.strictEqual((await request('/collection/bulk-add', 'POST', { card_ids: ['mtg-atomic-add'], quantity })).status, 400);
  }
  assert.deepStrictEqual(await snapshot(), boundaryBefore);
  assert.strictEqual((await update(stacked, { quantity: Number.MAX_SAFE_INTEGER })).status, 200);
  assert.strictEqual((await row(stacked)).quantity, Number.MAX_SAFE_INTEGER);
  assert.strictEqual((await update(stacked, { quantity: 1 })).status, 200);
  assert.strictEqual((await request('/collection', 'POST', { card_id: 'mtg-atomic-add', quantity: '2' })).status, 200);
  assert.strictEqual((await db.get("SELECT SUM(quantity) AS n FROM collection WHERE card_id = 'mtg-atomic-add'")).n, 2);
  console.log('stackquantity.test.js passed (entry-only quantity contract)');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
