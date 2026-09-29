const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-deck-sources-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { checkedOutAllocation } = require('../src/utils/collectionHelpers');

async function main() {
  let server;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other')");
    await db.run("INSERT INTO card_cache (id, name, game, supertype) VALUES ('card', 'Card', 'mtg', 'Creature'), ('other', 'Other', 'mtg', 'Creature')");
    const box = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Chosen Box', 'Box', 1)")).lastID;
    const alternateBox = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Other Box', 'Box', 1)")).lastID;
    const compartment = (await db.run("INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)", [box])).lastID;
    const otherCompartment = (await db.run("INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 2, 100)", [box])).lastID;
    async function entry(location = box, section = compartment, options = {}) {
      return (await db.run(`INSERT INTO collection (card_id, quantity, user_id, location_id, compartment_id, list_type, missing, added_at)
        VALUES (?, 1, ?, ?, ?, ?, ?, ?)`, [options.card || 'card', options.user || 1, location, section,
        options.list || 'collection', options.missing || 0, options.date || '2026-01-01'])).lastID;
    }
    const lead = await entry();
    const sibling = await entry();
    await entry(box, otherCompartment);
    const automaticEntries = [await entry(alternateBox, null, { date: '2026-02-01' }), await entry(alternateBox, null, { date: '2026-02-01' })];
    await entry(null, null);
    const missing = await entry(box, compartment, { missing: 1 });
    const foreign = await entry(null, null, { user: 2 });
    const arenaEntry = await entry(null, null, { list: 'arena' });
    const nonphysical = [];
    for (const list of ['wishlist', 'graveyard']) nonphysical.push(await entry(null, null, { list }));
    const wrongCard = await entry(box, compartment, { card: 'other' });
    const createDeck = async (name, inventory = 'collection') => (await db.run(
      "INSERT INTO decks (name, user_id, inventory_type) VALUES (?, 1, ?)", [name, inventory])).lastID;
    const selected = await createDeck('Selected');
    const arena = await createDeck('Arena', 'arena');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/api/decks', require('../src/routes/decks'));
    app.use('/api', require('../src/routes/importExport'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function request(method, suffix, body, user = 1) {
      const response = await fetch(`${base}/${suffix}`, { method,
        headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    }
    const draft = source_entry_id => ({ name: 'Selected', description: '', format: 'Standard', category: 'Casual',
      accent_color: '#eab308', target_size: 60, inventory_type: 'collection', commander_card_id: null,
      cards: [{ card_id: 'card', quantity: 2, pulled: false, source_entry_id }] });
    const save = (id, source) => request('PUT', `decks/${id}/editor`, draft(source));
    const checkout = id => request('PUT', `decks/${id}/checkout`, {});
    const locations = async id => (await request('GET', `decks/${id}/locations`)).body[0].locations;
    const inventoryBefore = await db.all('SELECT * FROM collection ORDER BY id');

    const options = await request('GET', `decks/${selected}/cards/card/sources`);
    assert.strictEqual(options.status, 200, 'draft-added cards can choose sources before saving');
    assert.deepStrictEqual(options.body.sources.map(source => [source.location_id, source.compartment_id, source.available]).sort(),
      [[box, compartment, 2], [box, otherCompartment, 1], [alternateBox, null, 2], [null, null, 1]].sort());
    assert.strictEqual((await request('GET', `decks/${selected}/cards/card/sources`, undefined, 2)).status, 404);
    assert.strictEqual((await request('GET', `decks/${arena}/cards/card/sources`)).status, 400);
    for (const source of [foreign, arenaEntry, ...nonphysical, wrongCard, 999999, -1, '1', 0]) {
      assert.strictEqual((await save(selected, source)).status, 400, `invalid source ${source}`);
    }
    assert.strictEqual((await save(selected, missing)).status, 200, 'missing inventory remains a valid draft source');
    assert.strictEqual((await checkout(selected)).status, 400, 'missing selected copies cannot be checked out');
    assert.strictEqual((await save(selected, lead)).status, 200);
    assert.strictEqual((await request('GET', `decks/${selected}`)).body.cards[0].source_entry_id, lead);
    assert.strictEqual((await request('GET', `decks/${selected}/cards/card/sources`)).body.sources.find(source => source.compartment_id === compartment).entry_id, lead);
    assert.deepStrictEqual((await locations(selected)).map(row => row.entry_id), [lead, sibling], 'selected lead precedes siblings in the same compartment');
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), inventoryBefore, 'saving selects copies without moving them');
    const reader = new sqlite3.Database(process.env.DB_PATH, sqlite3.OPEN_READONLY);
    try {
      const row = await new Promise((resolve, reject) => reader.get('SELECT source_entry_id FROM deck_cards WHERE deck_id = ?', [selected], (error, value) => error ? reject(error) : resolve(value)));
      assert.strictEqual(row.source_entry_id, lead);
    } finally { await new Promise(resolve => reader.close(resolve)); }

    assert.strictEqual((await checkout(selected)).status, 200);
    const originalReturn = await locations(selected);
    assert.deepStrictEqual(await checkedOutAllocation(1), new Map([[lead, 1], [sibling, 1]]));
    assert.strictEqual((await save(selected, null)).status, 400, 'checked-out source changes are rejected');
    assert.strictEqual((await request('DELETE', `decks/${selected}/cards/card`)).status, 400);
    assert.strictEqual((await request('POST', `decks/${selected}/cards`, { card_id: 'card', quantity: 3 })).status, 400);
    const duplicate = (await request('POST', `decks/${selected}/duplicate`, {})).body.id;
    assert.strictEqual((await request('GET', `decks/${duplicate}`)).body.cards[0].source_entry_id, lead);
    const lockedDraft = { ...draft(lead), description: 'Edited while reserved elsewhere',
      cards: [{ ...draft(lead).cards[0], pulled: true }] };
    assert.strictEqual((await request('PUT', `decks/${duplicate}/editor`, lockedDraft)).status, 200);
    const lockedSaved = (await request('GET', `decks/${duplicate}`)).body;
    assert.strictEqual(lockedSaved.description, lockedDraft.description);
    assert.strictEqual(lockedSaved.cards[0].checked_out, 1);
    assert.strictEqual(lockedSaved.cards[0].source_entry_id, lead);
    assert.strictEqual((await checkout(duplicate)).status, 400, 'a selected location never falls back to free copies elsewhere');
    assert.deepStrictEqual((await request('GET', `decks/${duplicate}`)).body, lockedSaved);
    assert.deepStrictEqual(await checkedOutAllocation(1), new Map([[lead, 1], [sibling, 1]]), 'failed checkout leaves existing reservations untouched');
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [duplicate]), []);
    assert.strictEqual((await save(duplicate, null)).status, 200);
    assert.strictEqual((await checkout(duplicate)).status, 200);
    assert.deepStrictEqual((await locations(duplicate)).map(row => row.entry_id).sort(), automaticEntries.sort());
    const automaticReturn = await locations(duplicate);
    await entry(alternateBox, null, { date: '2026-09-01' });
    await db.initDb();
    assert.deepStrictEqual(await locations(selected), originalReturn);
    assert.deepStrictEqual(await locations(duplicate), automaticReturn, 'restart/new copies cannot change actual return sources');

    const backup = (await request('GET', 'export?format=backup')).body;
    assert.strictEqual((await request('POST', 'import', { format: 'backup', data: backup })).status, 200);
    const restored = await db.get("SELECT id FROM decks WHERE name = 'Selected' AND checked_out = 1 ORDER BY id LIMIT 1");
    const restoredCard = await db.get('SELECT source_entry_id FROM deck_cards WHERE deck_id = ?', [restored.id]);
    const restoredSource = await db.get('SELECT location_id, compartment_id FROM collection WHERE id = ?', [restoredCard.source_entry_id]);
    assert.strictEqual((await db.get('SELECT name FROM locations WHERE id = ?', [restoredSource.location_id])).name, 'Chosen Box');
    assert.deepStrictEqual((await locations(restored.id)).map(row => [row.location_name, row.take]), [['Chosen Box', 1], ['Chosen Box', 1]]);
    assert.strictEqual((await request('PUT', `decks/${restored.id}/return`, {})).status, 200);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM deck_card_allocations WHERE deck_id = ?', [restored.id])).count, 0);
    await db.run('UPDATE collection SET missing = 1 WHERE id = ?', [restoredCard.source_entry_id]);
    assert.strictEqual((await save(restored.id, restoredCard.source_entry_id)).status, 200, 'a saved missing source does not block a normal save');
    assert.strictEqual((await checkout(restored.id)).status, 400);
    await db.run('DELETE FROM collection WHERE id = ?', [restoredCard.source_entry_id]);
    assert.strictEqual((await save(restored.id, restoredCard.source_entry_id)).status, 200, 'a saved deleted source does not block a normal save');
    assert.strictEqual((await checkout(restored.id)).status, 400, 'deleted selected lead must not silently fall back');
    assert.strictEqual((await request('GET', `decks/${restored.id}`)).body.cards[0].source_entry_id, restoredCard.source_entry_id);
    const staleBackup = (await request('GET', 'export?format=backup')).body;
    assert.strictEqual((await request('POST', 'import', { format: 'backup', data: staleBackup })).status, 200);
    const stale = await db.get("SELECT id FROM decks WHERE name = 'Selected' AND checked_out = 0 ORDER BY id LIMIT 1");
    const tombstone = (await db.get('SELECT source_entry_id FROM deck_cards WHERE deck_id = ?', [stale.id])).source_entry_id;
    assert.ok(tombstone < 0, 'restore keeps a deleted source distinct from live collection entries');
    const staleDraft = { ...draft(tombstone), description: 'Keep unresolved source',
      cards: [{ ...draft(tombstone).cards[0], pulled: true }] };
    assert.strictEqual((await request('PUT', `decks/${stale.id}/editor`, staleDraft)).status, 200);
    const staleSaved = (await request('GET', `decks/${stale.id}`)).body;
    assert.strictEqual(staleSaved.description, staleDraft.description);
    assert.strictEqual(staleSaved.cards[0].checked_out, 1);
    assert.strictEqual(staleSaved.cards[0].source_entry_id, tombstone);
    assert.strictEqual((await save(stale.id, tombstone - 1)).status, 400, 'only the saved tombstone can be retained');
    assert.deepStrictEqual((await request('GET', `decks/${stale.id}`)).body, staleSaved);
    assert.strictEqual((await checkout(stale.id)).status, 400, 'restoring a stale source must not alias a different entry');
    assert.deepStrictEqual((await request('GET', `decks/${stale.id}`)).body, staleSaved);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [stale.id]), []);
    assert.strictEqual((await save(stale.id, null)).status, 200);
    assert.strictEqual((await checkout(stale.id)).status, 200, 'explicitly choosing Automatic clears the stale preference');
    console.log('Deck source persistence, grouped checkout and return HTTP regression passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
