const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-deck-editor-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const deckRouter = require('../src/routes/decks');

async function testEditor() {
  let server;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')");
    await db.run(`INSERT INTO card_cache (id, name, game, supertype, subtypes) VALUES
      ('first', 'First', 'mtg', 'Creature', '[]'), ('alternate', 'First', 'mtg', 'Creature', '[]'),
      ('removed', 'Removed', 'mtg', 'Creature', '[]'), ('added', 'Added', 'mtg', 'Creature', '[]'),
      ('foreign', 'Foreign', 'mtg', 'Creature', '[]'), ('land', 'Forest', 'mtg', 'Land', '["Basic","Land"]'),
      ('wrong-game', 'Wrong game', 'unsupported', 'Creature', '[]')`);
    await db.run(`INSERT INTO collection (card_id, quantity, game, user_id, list_type) VALUES
      ('first', 3, 'mtg', 1, 'collection'), ('alternate', 4, 'mtg', 1, 'collection'),
      ('removed', 1, 'mtg', 1, 'collection'), ('added', 2, 'mtg', 1, 'collection'),
      ('land', 20, 'mtg', 1, 'collection'), ('foreign', 4, 'mtg', 2, 'collection'),
      ('first', 1, 'mtg', 1, 'arena'), ('added', 1, 'mtg', 1, 'arena')`);
    const id = (await db.run(`INSERT INTO decks
      (name, description, game, format, category, accent_color, target_size, user_id, commander_card_id, wins, losses)
      VALUES ('Before', 'Before', 'mtg', 'Commander', 'Casual', '#eab308', 100, 1, 'first', 2, 3)`)).lastID;
    const foreignDeck = (await db.run("INSERT INTO decks (name, game, user_id) VALUES ('Foreign deck', 'mtg', 2)")).lastID;
    const legacyDeck = (await db.run("INSERT INTO decks (name, game, user_id) VALUES ('Legacy', 'unsupported', 1)")).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'first', 1), (?, 'removed', 1), (?, 'foreign', 1)`, [id, id, foreignDeck]);
    const inventory = await db.all('SELECT * FROM collection ORDER BY id');
    const foreignBefore = await db.get('SELECT * FROM decks WHERE id = ?', [foreignDeck]);
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/api/decks', deckRouter);
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/decks`;
    async function request(method, suffix, body, user = 1) {
      const response = await fetch(`${base}/${suffix}`, {
        method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json() };
    }
    const reload = async () => {
      const response = await request('GET', id);
      assert.strictEqual(response.status, 200);
      return response.body;
    };
    const save = (body, deckId = id, user = 1) => request('PUT', `${deckId}/editor`, body, user);
    assert.strictEqual((await reload()).notes, '', 'new decks start with empty private notes');
    const draft = {
      name: '  After  ', description: 'Saved draft', notes: '  Sideboard plans\nKeep two answers — 私的  ', format: 'Commander / EDH', category: 'Competitive',
      accent_color: '#3b82f6', target_size: 100, inventory_type: 'collection', commander_card_id: 'added',
      cards: [{ card_id: 'first', quantity: 3, pulled: false }, { card_id: 'added', quantity: 1, pulled: true }]
    };
    assert.strictEqual((await save(draft)).status, 200);
    let saved = await reload();
    for (const key of ['description', 'notes', 'format', 'category', 'accent_color', 'target_size', 'inventory_type', 'commander_card_id']) {
      assert.strictEqual(saved[key], draft[key]);
    }
    assert.strictEqual(saved.name, 'After');
    assert.strictEqual(saved.wins, 2);
    assert.strictEqual(saved.losses, 3);
    assert.deepStrictEqual(saved.cards.map(card => [card.id, card.quantity, card.checked_out]).sort(), [['added', 1, 1], ['first', 3, 0]]);
    // An independent connection sees committed quantities and pull flags, not just an in-memory response.
    const reader = new sqlite3.Database(process.env.DB_PATH, sqlite3.OPEN_READONLY);
    try {
      const persisted = await new Promise((resolve, reject) => reader.all(
        'SELECT card_id, quantity, checked_out FROM deck_cards WHERE deck_id = ? ORDER BY card_id', [id],
        (error, rows) => error ? reject(error) : resolve(rows)
      ));
      assert.deepStrictEqual(persisted, [{ card_id: 'added', quantity: 1, checked_out: 1 }, { card_id: 'first', quantity: 3, checked_out: 0 }]);
      const persistedNotes = await new Promise((resolve, reject) => reader.get(
        'SELECT notes, description FROM decks WHERE id = ?', [id],
        (error, row) => error ? reject(error) : resolve(row)
      ));
      assert.deepStrictEqual(persistedNotes, { notes: draft.notes, description: draft.description });
    } finally {
      await new Promise((resolve, reject) => reader.close(error => error ? reject(error) : resolve()));
    }

    const olderDraft = { ...draft };
    delete olderDraft.notes;
    assert.strictEqual((await save(olderDraft)).status, 200);
    assert.deepStrictEqual(await reload(), saved, 'older editor payloads preserve saved notes');
    assert.strictEqual((await request('PUT', id, { name: 'After', description: draft.description })).status, 200);
    assert.strictEqual((await reload()).notes, draft.notes, 'legacy metadata updates preserve notes');
    const duplicate = await request('POST', `${id}/duplicate`, {});
    assert.strictEqual(duplicate.status, 201);
    assert.strictEqual((await request('GET', duplicate.body.id)).body.notes, draft.notes);
    assert.strictEqual((await save({ ...draft, notes: '' })).status, 200);
    assert.strictEqual((await reload()).notes, '', 'an empty string explicitly clears notes');
    assert.strictEqual((await reload()).description, draft.description, 'clearing notes leaves description unchanged');
    assert.strictEqual((await request('GET', duplicate.body.id)).body.notes, draft.notes, 'a copy keeps independent notes');
    assert.strictEqual((await save(draft)).status, 200);
    saved = await reload();

    const invalidDrafts = [
      { cards: [...draft.cards, { card_id: 'alternate', quantity: 2, pulled: false }] },
      { cards: [...draft.cards, { card_id: 'wrong-game', quantity: 1, pulled: false }] },
      { cards: [...draft.cards, { card_id: 'missing', quantity: 1, pulled: false }] },
      { cards: [...draft.cards, draft.cards[0]] },
      { cards: null }, { cards: [null] },
      ...[0, -1, 1.5, '2', Number.MAX_SAFE_INTEGER + 1].map(quantity => ({ cards: [{ card_id: 'first', quantity, pulled: false }] })),
      ...[0, 'true', null].map(pulled => ({ cards: [{ card_id: 'first', quantity: 1, pulled }] })),
      { commander_card_id: 'removed' }, { commander_card_id: 12 }, { commander_card_id: undefined },
      { format: 'Modern' }, { name: ' ' }, { description: {} }, { target_size: 301 }, { target_size: '100' },
      ...[null, 12, false, {}, []].map(notes => ({ notes })),
      { inventory_type: 'wishlist' }
    ];
    for (const invalid of invalidDrafts) {
      const result = await save({ ...draft, name: 'Must roll back', notes: 'Must roll back notes', ...invalid });
      assert.strictEqual(result.status, 400, JSON.stringify(invalid));
      assert.strictEqual(typeof result.body.error, 'string');
      assert.deepStrictEqual(await reload(), saved, 'failed save must preserve metadata, cards, pull flags and commander');
    }
    assert.strictEqual((await save(draft, id, 2)).status, 404);
    assert.strictEqual((await save(draft, foreignDeck)).status, 404);
    assert.strictEqual((await save(draft, legacyDeck)).status, 404);
    assert.strictEqual((await save(draft, 999999)).status, 404);
    assert.strictEqual((await request('GET', id, undefined, 2)).status, 404, 'another account cannot read private notes');
    assert.strictEqual((await request('POST', `${id}/duplicate`, {}, 2)).status, 404);
    assert.deepStrictEqual(await reload(), saved);
    assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [foreignDeck]), foreignBefore);
    assert.deepStrictEqual(await db.all('SELECT card_id, quantity FROM deck_cards WHERE deck_id = ?', [foreignDeck]), [{ card_id: 'foreign', quantity: 1 }]);

    // Replacing a printing validates the final composition, not old + new copies.
    const replacement = { ...draft, commander_card_id: null, cards: [{ card_id: 'alternate', quantity: 4, pulled: false }, { card_id: 'land', quantity: 20, pulled: true }] };
    assert.strictEqual((await save(replacement)).status, 200);
    saved = await reload();
    assert.strictEqual(saved.commander_card_id, null);
    assert.deepStrictEqual(saved.cards.map(card => [card.id, card.quantity]).sort(), [['alternate', 4], ['land', 20]]);
    const arena = { ...draft, inventory_type: 'arena', cards: draft.cards.map(card => ({ ...card, quantity: 1 })) };
    assert.strictEqual((await save(arena)).status, 200);
    assert.strictEqual((await reload()).inventory_type, 'arena');
    const arenaUnowned = { ...arena, cards: [...arena.cards, { card_id: 'alternate', quantity: 1, pulled: true }] };
    assert.strictEqual((await save(arenaUnowned)).status, 200);
    assert.deepStrictEqual((await reload()).cards.map(card => [card.id, card.quantity, card.checked_out]).sort(),
      [['added', 1, 1], ['alternate', 1, 1], ['first', 1, 0]]);
    assert.strictEqual((await save(draft)).status, 200);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), inventory, 'saving a definition must not mutate inventory');

    // Draft saves, including source autosave payloads, do not reserve inventory.
    for (const state of ['unowned', 'missing', 'locked', 'short']) {
      const cardId = `unavailable-${state}`;
      await db.run("INSERT INTO card_cache (id, name, game, supertype) VALUES (?, ?, 'mtg', 'Creature')", [cardId, cardId]);
      const entryId = state === 'unowned' ? null : (await db.run(
        `INSERT INTO collection (card_id, quantity, game, user_id, list_type, missing)
         VALUES (?, ?, 'mtg', 1, 'collection', ?)`, [cardId, state === 'short' ? 1 : 2, state === 'missing' ? 1 : 0]
      )).lastID;
      if (state === 'locked') {
        const blocker = (await db.run("INSERT INTO decks (name, user_id) VALUES ('Reserved elsewhere', 1)")).lastID;
        await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 2)', [blocker, cardId]);
        assert.strictEqual((await request('PUT', `${blocker}/checkout`, {})).status, 200);
      }
      const unavailableDeck = (await db.run("INSERT INTO decks (name, user_id) VALUES ('Unavailable draft', 1)")).lastID;
      const initial = { ...draft, commander_card_id: null, cards: [
        { card_id: 'added', quantity: 1, pulled: false },
        { card_id: cardId, quantity: 2, pulled: false, source_entry_id: null }
      ] };
      assert.strictEqual((await save(initial, unavailableDeck)).status, 200, `${state} cards can be saved`);
      const changed = { ...initial, name: `Saved ${state}`, description: 'Whole current draft',
        category: 'Casual', accent_color: '#123456', target_size: 99, commander_card_id: cardId,
        cards: initial.cards.map(card => ({ ...card, pulled: true,
          source_entry_id: card.card_id === cardId ? entryId : null })) };
      assert.strictEqual((await save(changed, unavailableDeck)).status, 200, `${state} must not block properties, pull flags or source changes`);
      const reloaded = (await request('GET', unavailableDeck)).body;
      for (const key of ['name', 'description', 'category', 'accent_color', 'target_size', 'commander_card_id']) {
        assert.strictEqual(reloaded[key], changed[key]);
      }
      assert.deepStrictEqual(reloaded.cards.map(card => [card.id, card.quantity, card.checked_out, card.source_entry_id]).sort(),
        [['added', 1, 1, null], [cardId, 2, 1, entryId]].sort());
      const snapshot = async () => ({
        deck: await db.get('SELECT * FROM decks WHERE id = ?', [unavailableDeck]),
        cards: await db.all('SELECT * FROM deck_cards WHERE deck_id = ? ORDER BY card_id', [unavailableDeck]),
        allocations: await db.all('SELECT * FROM deck_card_allocations ORDER BY deck_id, card_id, entry_id'),
        inventory: await db.all('SELECT * FROM collection ORDER BY id')
      });
      const beforeCheckout = await snapshot();
      assert.strictEqual((await request('PUT', `${unavailableDeck}/checkout`, {})).status, 400, `${state} still blocks checkout`);
      assert.deepStrictEqual(await snapshot(), beforeCheckout, 'failed checkout cannot partially reserve cards or change the saved draft');
    }

    assert.strictEqual((await request('PUT', `${id}/checkout`, {})).status, 200);
    saved = await reload();
    for (const changes of [
      { cards: [draft.cards[1]] },
      { cards: draft.cards.map(card => ({ ...card, quantity: 2 })) },
      { cards: [...draft.cards, { card_id: 'land', quantity: 1, pulled: false }] },
      { inventory_type: 'arena' }
    ]) {
      assert.strictEqual((await save({ ...draft, ...changes })).status, 400);
      assert.deepStrictEqual(await reload(), saved);
    }
    await db.run("UPDATE collection SET quantity = 1 WHERE card_id = 'first' AND user_id = 1 AND list_type = 'collection'");
    assert.strictEqual((await save({ ...draft, name: 'Still checked out', commander_card_id: 'first', cards: draft.cards.map(card => ({ ...card, pulled: !card.pulled })) })).status, 200);
    const checkedOut = await reload();
    assert.strictEqual(checkedOut.checked_out, 1);
    assert.strictEqual(checkedOut.checked_out_at, saved.checked_out_at);
    assert.strictEqual(checkedOut.name, 'Still checked out');
    assert.strictEqual(checkedOut.commander_card_id, 'first');
    assert.deepStrictEqual(checkedOut.cards.map(card => [card.id, card.quantity, card.checked_out]).sort(), [['added', 1, 0], ['first', 3, 1]]);
    assert.strictEqual((await request('PUT', `${id}/return`, {})).status, 200);
    assert.strictEqual((await save({ ...draft, format: 'Modern', commander_card_id: null, cards: [] })).status, 200);
    const empty = await reload();
    assert.deepStrictEqual(empty.cards, []);
    assert.strictEqual(empty.commander_card_id, null);
    assert.strictEqual(empty.format, 'Modern');

    // Archival is a definition-only transition; restoring must validate the destination inventory.
    const archivedId = (await db.run(`INSERT INTO decks (name, user_id, format, inventory_type)
      VALUES ('Archive editor', 1, 'Casual', 'collection')`)).lastID;
    const source = await db.get("SELECT id FROM collection WHERE card_id = 'first' AND user_id = 1 AND list_type = 'collection'");
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id)
      VALUES (?, 'first', 2, ?)`, [archivedId, source.id]);
    const archiveDraft = {
      name: 'Archive editor', description: 'Keep definition', notes: 'Keep private notes',
      format: 'Casual', category: 'Casual', accent_color: '#123456', target_size: 60,
      inventory_type: 'graveyard', commander_card_id: null,
      cards: [{ card_id: 'first', quantity: 2, pulled: false, source_entry_id: source.id }]
    };
    const archiveInventory = await db.all('SELECT * FROM collection ORDER BY id');
    await db.run('UPDATE decks SET checked_out = 1 WHERE id = ?', [archivedId]);
    assert.strictEqual((await save(archiveDraft, archivedId)).status, 400);
    assert.strictEqual((await db.get('SELECT inventory_type FROM decks WHERE id = ?', [archivedId])).inventory_type, 'collection');
    assert.strictEqual((await db.get('SELECT source_entry_id FROM deck_cards WHERE deck_id = ?', [archivedId])).source_entry_id, source.id);
    assert.strictEqual((await request('PUT', `${archivedId}/return`, {})).status, 200);
    assert.strictEqual((await save(archiveDraft, archivedId)).status, 200);
    const archivedDraft = { ...archiveDraft, cards: archiveDraft.cards.map(card => ({ ...card, source_entry_id: null })) };
    let archiveSaved = (await request('GET', archivedId)).body;
    assert.strictEqual(archiveSaved.inventory_type, 'graveyard');
    assert.deepStrictEqual(archiveSaved.cards.map(card => [card.id, card.quantity, card.source_entry_id]), [['first', 2, null]]);
    assert.strictEqual((await save({ ...archivedDraft, notes: 'Edited while missing' }, archivedId)).status, 200);
    archiveSaved = (await request('GET', archivedId)).body;
    assert.strictEqual(archiveSaved.notes, 'Edited while missing');
    for (const inventoryType of ['collection', 'arena']) {
      assert.strictEqual((await save({ ...archivedDraft, name: 'Must roll back', inventory_type: inventoryType }, archivedId)).status, 400);
      assert.deepStrictEqual((await request('GET', archivedId)).body, archiveSaved);
    }
    assert.strictEqual((await save(archivedDraft, archivedId, 2)).status, 404);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), archiveInventory);
    for (const inventoryType of ['collection', 'arena']) {
      await db.run("UPDATE collection SET quantity = 2 WHERE card_id = 'first' AND user_id = 1 AND list_type = ?", [inventoryType]);
      assert.strictEqual((await save({ ...archivedDraft, inventory_type: inventoryType }, archivedId)).status, 200);
      assert.strictEqual((await request('GET', archivedId)).body.inventory_type, inventoryType);
      assert.strictEqual((await save(archivedDraft, archivedId)).status, 200);
    }
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testEditor()
  .then(() => console.log('Atomic deck editor HTTP self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
