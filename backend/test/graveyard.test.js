const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-graveyard-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { inventory } = require('../src/utils/aiDecks');

async function testGraveyard() {
  let server;
  try {
    await db.initDb();
    await db.run(`INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')`);
    await db.run(`INSERT INTO card_cache (id, name, game, price_trend) VALUES ('archive-card', 'Archive Card', 'mtg', 10), ('spare-card', 'Spare Card', 'mtg', 1)`);
    const location = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Archive Box', 'Box', 1)`)).lastID;
    const compartment = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)`, [location])).lastID;
    const physical = (await db.run(`INSERT INTO collection
      (card_id, user_id, quantity, location_id, compartment_id, position, printing, language, condition,
       purchase_price, favorite, is_trade, notes, grader, grade, cert_number, market_value, market_value_source, added_at)
      VALUES ('archive-card', 1, 3, ?, ?, 1000, 'Holofoil', 'German', 'Lightly Played',
        5, 1, 1, 'Keep provenance', 'PSA', 9, 'archive-cert', 30, 'manual', '2025-01-01 00:00:00')`, [location, compartment])).lastID;
    const arena = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type) VALUES ('archive-card', 1, 2, 'arena')`)).lastID;
    const foreign = (await db.run(`INSERT INTO collection (card_id, user_id, quantity) VALUES ('archive-card', 2, 9)`)).lastID;
    const deck = (await db.run(`INSERT INTO decks (name, user_id) VALUES ('Physical Deck', 1)`)).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'archive-card', 1)`, [deck]);
    const original = await db.get('SELECT * FROM collection WHERE id = ?', [physical]);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/api', require('../src/routes/collection'));
    app.use('/api', require('../src/routes/storage'));
    app.use('/api', require('../src/routes/importExport'));
    app.use('/api', require('../src/routes/stats'));
    app.use('/api/decks', require('../src/routes/decks'));
    app.use('/api/shared', require('../src/routes/shared'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function request(url, method = 'GET', body, user = 1, status = 200) {
      const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await response.json();
      assert.strictEqual(response.status, status, JSON.stringify(data));
      return data;
    }
    const change = (id, list_type, user = 1, status = 200) => request(`/collection/${id}`, 'PUT', { list_type }, user, status);
    const bulk = (entry_ids, value, status = 200) => request('/collection/bulk', 'POST', { entry_ids, action: 'list_type', value }, 1, status);

    // Deck archival changes only the definition, even when the archive owns no copies.
    for (const inventoryType of ['collection', 'arena']) {
      const archiveDeck = (await db.run(`INSERT INTO decks
        (name, description, notes, user_id, inventory_type, format, category, accent_color, target_size, commander_card_id, wins, losses)
        VALUES (?, 'Public description', 'Private notes', 1, ?, 'Commander', 'Casual', '#123456', 100, 'archive-card', 7, 2)`,
      [`Archived ${inventoryType}`, inventoryType])).lastID;
      await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out, source_entry_id)
        VALUES (?, 'archive-card', 4, 1, ?)`, [archiveDeck, inventoryType === 'collection' ? physical : null]);
      const before = await db.get('SELECT * FROM decks WHERE id = ?', [archiveDeck]);
      const cardsBefore = await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [archiveDeck]);
      const inventoryBefore = await db.all('SELECT * FROM collection ORDER BY id');
      const properties = { name: before.name, inventory_type: 'graveyard' };
      await request(`/decks/${archiveDeck}`, 'PUT', properties, 2, 404);
      await db.run('UPDATE decks SET checked_out = 1 WHERE id = ?', [archiveDeck]);
      await request(`/decks/${archiveDeck}`, 'PUT', properties, 1, 400);
      assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [archiveDeck]), cardsBefore);
      await request(`/decks/${archiveDeck}/return`, 'PUT', {});
      const returned = await db.get('SELECT * FROM decks WHERE id = ?', [archiveDeck]);
      await request(`/decks/${archiveDeck}`, 'PUT', properties);
      assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [archiveDeck]), { ...returned, inventory_type: 'graveyard' });
      const archivedCards = await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [archiveDeck]);
      assert.deepStrictEqual(archivedCards.map(card => [card.card_id, card.quantity, card.source_entry_id]), [['archive-card', 4, null]]);
      assert.strictEqual((await request('/decks')).find(row => row.id === archiveDeck).missing_cards, 4);
      for (const target of ['collection', 'arena']) {
        await request(`/decks/${archiveDeck}`, 'PUT', { ...properties, name: 'Must roll back', inventory_type: target }, 1, 400);
        assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [archiveDeck]), { ...returned, inventory_type: 'graveyard' });
        assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [archiveDeck]), archivedCards);
      }
      await request(`/decks/${archiveDeck}/checkout`, 'PUT', {}, 1, 400);
      await request(`/decks/${archiveDeck}/locations`, 'GET', undefined, 1, 400);
      await request(`/decks/${archiveDeck}/cards/archive-card/sources`, 'GET', undefined, 1, 400);
      assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [archiveDeck]), []);
      assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), inventoryBefore);
      const copied = await request(`/decks/${archiveDeck}/duplicate`, 'POST', {}, 1, 201);
      const copy = await request(`/decks/${copied.id}`);
      assert.strictEqual(copy.inventory_type, 'graveyard');
      for (const key of ['description', 'notes', 'format', 'category', 'accent_color', 'target_size', 'commander_card_id']) {
        assert.strictEqual(copy[key], before[key]);
      }
      assert.deepStrictEqual(copy.cards.map(card => [card.id, card.quantity, card.source_entry_id]), [['archive-card', 4, null]]);
    }
    await change(foreign, 'graveyard', 1, 404);
    await change(physical, 'invalid', 1, 400);
    await request('/collection?list_type=invalid', 'GET', undefined, 1, 400);
    await change(physical, 'graveyard');
    const archived = { ...original, list_type: 'graveyard', location_id: null, compartment_id: null, position: 0 };
    assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [physical]), archived, 'archive preserves quantity and every non-placement field');
    assert.deepStrictEqual((await request('/collection?list_type=graveyard')).map(row => [row.entry_id, row.quantity, row.notes]), [[physical, 3, 'Keep provenance']]);
    assert.deepStrictEqual(await request('/collection'), []);
    assert.deepStrictEqual(await request('/collection?list_type=graveyard', 'GET', undefined, 2), []);
    assert.deepStrictEqual((await request('/collection', 'GET', undefined, 2)).map(row => row.quantity), [9]);
    assert.strictEqual((await request('/locations')).find(row => row.id === location).total_cards, 0);
    assert.strictEqual((await request(`/locations/${location}/compartments`))[0].count, 0);
    await request(`/collection/${physical}`, 'PUT', { location_id: location }, 1, 400);
    await request(`/collection/${physical}/place`, 'POST', { compartment_id: compartment, slot: 0 }, 1, 400);
    await request('/collection/bulk', 'POST', { entry_ids: [physical], action: 'move', value: location }, 1, 400);
    await request(`/locations/${location}/apply-all`, 'POST', { entry_ids: [physical] }, 1, 400);
    assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [physical]), archived);
    const stats = await request('/stats');
    assert.strictEqual(stats.summary.totalCards, 2);
    assert.deepStrictEqual(stats.topValuable.map(row => row.entry_id), [arena]);
    assert.strictEqual((await request(`/decks/${deck}`)).cards[0].owned_qty, 0);
    assert.deepStrictEqual(await inventory(1, 'collection'), []);
    assert.strictEqual((await inventory(1, 'arena'))[0].available_qty, 2);
    assert.strictEqual((await request('/collection/bulk', 'POST', { entry_ids: [physical], action: 'add_to_deck', value: deck })).affected, 0);
    const emptyArchive = await request('/decks', 'POST', { name: 'Owned archive', inventory_type: 'graveyard' }, 1, 201);
    const foreignArchive = (await db.run("INSERT INTO collection (card_id, user_id, quantity, list_type) VALUES ('spare-card', 2, 9, 'graveyard')")).lastID;
    assert.strictEqual((await request(`/decks/${emptyArchive.id}`)).inventory_type, 'graveyard');
    await request(`/decks/${emptyArchive.id}/cards`, 'POST', { card_id: 'archive-card', quantity: 3 });
    await request(`/decks/${emptyArchive.id}/cards`, 'POST', { card_id: 'archive-card', quantity: 4 }, 1, 400);
    await request(`/decks/${emptyArchive.id}/cards`, 'POST', { card_id: 'spare-card', quantity: 1 }, 1, 400);
    await request(`/decks/${emptyArchive.id}/cards`, 'POST', { card_id: 'archive-card', quantity: 1 }, 2, 404);
    const ownedArchive = await request(`/decks/${emptyArchive.id}`);
    assert.deepStrictEqual(ownedArchive.cards.map(card => [card.id, card.quantity, card.owned_qty, card.locked_qty]), [['archive-card', 3, 3, 0]]);
    assert.strictEqual((await request('/decks')).find(row => row.id === emptyArchive.id).missing_cards, 0);
    assert.deepStrictEqual((await request('/search?scope=collection&name=Archive&list_type=graveyard')).map(card => [card.id, card.owned_qty]), [['archive-card', 3]]);
    assert.deepStrictEqual(await request('/search?scope=collection&name=Spare&list_type=graveyard'), []);
    assert.deepStrictEqual((await request('/search?scope=collection&name=Spare&list_type=graveyard', 'GET', undefined, 2)).map(card => [card.id, card.owned_qty]), [['spare-card', 9]]);
    await db.run('DELETE FROM collection WHERE id = ?', [foreignArchive]);
    const imported = await request('/decks', 'POST', {
      name: 'Imported archive', inventory_type: 'graveyard', decklist_text: '3 Archive Card'
    }, 1, 201);
    assert.deepStrictEqual((await request(`/decks/${imported.id}`)).cards.map(card => [card.id, card.quantity]), [['archive-card', 3]]);
    const beforeBadImport = await db.all('SELECT * FROM decks ORDER BY id');
    await request('/decks', 'POST', { name: 'Unowned archive', inventory_type: 'graveyard', decklist_text: '4 Archive Card' }, 1, 400);
    assert.deepStrictEqual(await db.all('SELECT * FROM decks ORDER BY id'), beforeBadImport);

    const backup = await request('/export?format=backup');
    assert.deepStrictEqual(backup.collection.find(row => row.id === physical), archived);
    await request('/import', 'POST', { format: 'backup', data: backup });
    const restoredArchive = await db.get(`SELECT * FROM collection WHERE user_id = 1 AND list_type = 'graveyard'`);
    assert.deepStrictEqual({ ...restoredArchive, id: physical }, archived, 'complete backup preserves archive state and metadata');
    for (const inventoryType of ['collection', 'arena']) {
      const restoredDefinition = await db.get('SELECT * FROM decks WHERE user_id = 1 AND name = ?', [`Archived ${inventoryType}`]);
      assert.strictEqual(restoredDefinition.inventory_type, 'graveyard');
      assert.strictEqual(restoredDefinition.notes, 'Private notes');
      assert.strictEqual(restoredDefinition.description, 'Public description');
      assert.strictEqual(restoredDefinition.commander_card_id, 'archive-card');
      assert.deepStrictEqual(await db.all('SELECT card_id, quantity, source_entry_id FROM deck_cards WHERE deck_id = ?', [restoredDefinition.id]),
        [{ card_id: 'archive-card', quantity: 4, source_entry_id: null }]);
    }
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [foreign])).quantity, 9);
    const restoredArena = await db.get(`SELECT id FROM collection WHERE user_id = 1 AND list_type = 'arena'`);
    await change(restoredArchive.id, 'collection');
    assert.deepStrictEqual((await request('/collection')).map(row => [row.quantity, row.location_id]), [[3, null]]);
    await bulk([restoredArchive.id, restoredArena.id, foreign], 'graveyard');
    assert.strictEqual((await request('/stats')).summary.totalCards, 0);
    assert.strictEqual((await db.get('SELECT list_type FROM collection WHERE id = ?', [foreign])).list_type, 'collection');
    await bulk([restoredArchive.id, restoredArena.id], 'arena');
    assert.strictEqual((await inventory(1, 'arena'))[0].available_qty, 5);
    assert.deepStrictEqual(await inventory(1, 'collection'), []);

    await change(restoredArchive.id, 'collection');
    const restoredDeck = await db.get("SELECT id FROM decks WHERE user_id = 1 AND name = 'Physical Deck'");
    await db.run('UPDATE decks SET checked_out = 1 WHERE id = ?', [restoredDeck.id]);
    const spare = (await db.run(`INSERT INTO collection (card_id, user_id) VALUES ('spare-card', 1)`)).lastID;
    const beforeGuard = await db.all('SELECT * FROM collection WHERE user_id = 1 ORDER BY id');
    await change(restoredArchive.id, 'graveyard', 1, 409);
    await bulk([spare, restoredArchive.id], 'graveyard', 409);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection WHERE user_id = 1 ORDER BY id'), beforeGuard, 'checked-out guard rejects the whole batch without mutation');
    assert.strictEqual((await db.get('SELECT checked_out FROM decks WHERE id = ?', [restoredDeck.id])).checked_out, 1);
    await db.run('UPDATE decks SET checked_out = 0 WHERE id = ?', [restoredDeck.id]);
    await change(restoredArchive.id, 'graveyard');
    assert.deepStrictEqual((await request('/collection?list_type=graveyard')).map(row => row.quantity), [3]);

    // Archive containers keep storage separate from the active collection.
    const create = (name, inventory_type = 'graveyard', user = 1) => request('/locations', 'POST', {
      name, type: 'Box', sort_order: 'custom', inventory_type, compartmentPlan: { count: 1, capacity: 20 }
    }, user);
    const archiveBox = (await create('Filed archive')).id;
    const secondBox = (await create('Second archive')).id;
    const foreignBox = (await create('Private archive', 'graveyard', 2)).id;
    const activeBox = (await create('Active storage', 'collection')).id;
    const archiveComp = (await request(`/locations/${archiveBox}/compartments`))[0].id;
    const activeComp = (await request(`/locations/${activeBox}/compartments`))[0].id;
    const foreignComp = (await request(`/locations/${foreignBox}/compartments`, 'GET', undefined, 2))[0].id;
    assert.deepStrictEqual((await request('/locations?inventory_type=graveyard')).map(row => row.id), [archiveBox, secondBox]);
    assert.ok(!(await request('/locations')).some(row => row.id === archiveBox));
    await request('/locations?inventory_type=arena', 'GET', undefined, 1, 400);
    await request('/locations', 'POST', { name: 'Invalid inventory', type: 'Box', inventory_type: 'arena' }, 1, 400);
    await request(`/locations/${archiveBox}`, 'PUT', { inventory_type: 'collection' }, 1, 400);
    await request(`/locations/${archiveBox}`, 'GET', undefined, 2, 404);
    await request(`/collection/${restoredArchive.id}`, 'PUT', { compartment_id: foreignComp }, 1, 400);
    await request(`/collection/${restoredArchive.id}`, 'PUT', { location_id: activeBox }, 1, 400);
    await request(`/collection/${spare}`, 'PUT', { location_id: archiveBox }, 1, 400);
    await request(`/collection/${spare}/place`, 'POST', { compartment_id: archiveComp, slot: 1 }, 1, 400);
    await request(`/compartments/${archiveComp}`, 'PATCH', { capacity: 2 });
    await request(`/collection/${restoredArchive.id}`, 'PUT', { compartment_id: archiveComp });
    assert.strictEqual((await request(`/locations/${archiveBox}/compartments`))[0].capacity, 2);
    await request(`/collection/${restoredArchive.id}`, 'PUT', { notes: 'Still archived' });
    let filed = await db.get('SELECT * FROM collection WHERE id = ?', [restoredArchive.id]);
    assert.deepStrictEqual([filed.list_type, filed.location_id, filed.compartment_id, filed.quantity], ['graveyard', archiveBox, archiveComp, 3]);
    assert.strictEqual((await request('/collection?list_type=graveyard'))[0].location_id, archiveBox);
    assert.strictEqual((await request('/locations?inventory_type=graveyard'))[0].total_cards, 3);
    assert.strictEqual((await request(`/locations/${archiveBox}/compartments`))[0].count, 3);
    await db.run("UPDATE card_cache SET image_url = 'https://example.com/archive.jpg' WHERE id = 'archive-card'");
    await request(`/locations/${archiveBox}`, 'PUT', { cover_card_id: 'archive-card' });
    assert.strictEqual((await request(`/locations/${archiveBox}`)).cover_card_id, 'archive-card');
    await request(`/collection/${restoredArchive.id}/place`, 'POST', { compartment_id: activeComp, slot: 1 }, 1, 400);
    await request(`/collection/${restoredArchive.id}/place`, 'POST', { compartment_id: archiveComp, slot: 2 });
    await request(`/locations/${secondBox}/recommend`, 'POST', { card_id: 'archive-card', list_type: 'graveyard' });
    await request(`/locations/${secondBox}/recommend`, 'POST', { card_id: 'archive-card' }, 1, 400);
    await request(`/locations/${secondBox}/recommend-batch`, 'POST', { entry_ids: [spare] }, 1, 400);
    assert.strictEqual((await request(`/locations/${secondBox}/recommend-batch`, 'POST', { entry_ids: [restoredArchive.id] }))[0].recommended.location_id, secondBox);
    assert.strictEqual((await request('/collection/bulk', 'POST', { entry_ids: [restoredArchive.id], action: 'move', value: secondBox })).affected, 1);
    await request(`/locations/${archiveBox}/apply-all`, 'POST', { entry_ids: [restoredArchive.id] });
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [restoredArchive.id])).location_id, archiveBox);
    await request(`/locations/${archiveBox}/resort`, 'POST', {});
    await request(`/locations/${archiveBox}`, 'PUT', { locked: true });
    await request(`/locations/${archiveBox}/resort`, 'POST', {}, 1, 409);
    assert.strictEqual((await request(`/locations/${archiveBox}/recommend`, 'POST', { card_id: 'spare-card', list_type: 'graveyard' })).rejected, true);
    await request(`/locations/${archiveBox}`, 'PUT', { locked: false });
    const containerInventory = await db.all('SELECT * FROM collection ORDER BY id');
    const containerDeck = await request('/decks/from-container', 'POST', { location_id: archiveBox, name: 'Filed deck' }, 1, 201);
    const filedDeck = await request(`/decks/${containerDeck.id}`);
    assert.strictEqual(filedDeck.inventory_type, 'graveyard');
    assert.deepStrictEqual(filedDeck.cards.map(card => [card.id, card.quantity, card.source_entry_id]), [['archive-card', 3, null]]);
    await request('/decks/from-container', 'POST', { location_id: archiveBox, name: 'Foreign deck' }, 2, 404);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), containerInventory);
    await request('/import-container/move', 'POST', { location_id: archiveBox, card_id: 'spare-card', printing: 'Normal', requested: 1 }, 1, 400);
    await assert.rejects(inventory(1, 'collection', { container_ids: [archiveBox] }), /Container not found/);
    await db.run("UPDATE users SET share_enabled = 1, share_locations = 1, share_token = 'archive-owner' WHERE id = 1");
    await request(`/shared/archive-owner/containers/${archiveBox}`, 'GET', undefined, 1, 404);

    filed = await db.get('SELECT * FROM collection WHERE id = ?', [restoredArchive.id]);
    const filedBackup = await request('/export?format=backup');
    const badBackup = structuredClone(filedBackup);
    badBackup.locations.find(row => row.id === archiveBox).inventory_type = 'collection';
    await request('/import', 'POST', { format: 'backup', data: badBackup }, 1, 400);
    assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [restoredArchive.id]), filed);
    await request('/import', 'POST', { format: 'backup', data: filedBackup });
    const restoredBox = (await request('/locations?inventory_type=graveyard')).find(row => row.name === 'Filed archive');
    const restored = await db.get("SELECT * FROM collection WHERE user_id = 1 AND list_type = 'graveyard'");
    assert.strictEqual(restored.location_id, restoredBox.id);
    assert.deepStrictEqual({ ...restored, id: filed.id, location_id: filed.location_id, compartment_id: filed.compartment_id }, filed);
    assert.strictEqual(restoredBox.cover_card_id, 'archive-card');
    assert.strictEqual((await request(`/locations/${restoredBox.id}/compartments`))[0].count, 3);
    const restoredFiledDeck = await db.get("SELECT * FROM decks WHERE user_id = 1 AND name = 'Filed deck'");
    assert.strictEqual(restoredFiledDeck.inventory_type, 'graveyard');
    assert.deepStrictEqual(await db.all('SELECT card_id, quantity, source_entry_id FROM deck_cards WHERE deck_id = ?', [restoredFiledDeck.id]),
      [{ card_id: 'archive-card', quantity: 3, source_entry_id: null }]);
    await change(restored.id, 'arena');
    assert.deepStrictEqual(await db.get('SELECT list_type, location_id, compartment_id, position, quantity FROM collection WHERE id = ?', [restored.id]),
      { list_type: 'arena', location_id: null, compartment_id: null, position: 0, quantity: 3 });
    await change(restored.id, 'graveyard');
    await request(`/collection/${restored.id}`, 'PUT', { location_id: restoredBox.id });
    await bulk([restored.id], 'collection');
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [restored.id])).location_id, null);
    await change(restored.id, 'graveyard');
    await request(`/collection/${restored.id}`, 'PUT', { location_id: restoredBox.id });
    await request(`/locations/${restoredBox.id}`, 'DELETE');
    assert.deepStrictEqual(await db.get('SELECT list_type, location_id, compartment_id, position, quantity FROM collection WHERE id = ?', [restored.id]),
      { list_type: 'graveyard', location_id: null, compartment_id: null, position: 0, quantity: 3 });

    const transferBox = (await request('/locations', 'POST', {
      name: 'Transfer binder', type: 'Binder', inventory_type: 'collection', sort_order: 'custom',
      foil_sorting: 'foils_first', rule_type: 'specific_sets', rule_config: { sets: ['test'] },
      compartmentPlan: { count: 2, capacity: 9 }
    })).id;
    const transferComps = await request(`/locations/${transferBox}/compartments`);
    const transferComp = transferComps[0].id;
    await request(`/compartments/${transferComp}`, 'PATCH', { label: 'Keep this page' });
    const transferEntry = (await db.run(`INSERT INTO collection
      (card_id, user_id, quantity, list_type, location_id, compartment_id, position, printing, language,
       condition, purchase_price, favorite, is_trade, notes, grader, grade, cert_number, market_value, market_value_source, added_at)
      VALUES ('archive-card', 1, 3, 'collection', ?, ?, 4000, 'Holofoil', 'German',
        'Lightly Played', 5, 1, 1, 'Transfer provenance', 'PSA', 9, 'transfer-cert', 30, 'manual', '2025-02-01 00:00:00')`,
    [transferBox, transferComp])).lastID;
    await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, position)
      VALUES ('spare-card', 1, 2, ?, 7000)`, [transferBox]);
    await db.run(`INSERT INTO collection (card_id, user_id, quantity, compartment_id, position)
      VALUES ('spare-card', 1, 1, ?, 8000)`, [transferComp]);
    // Legacy/inconsistent placement still must not grant access to another user's rows.
    const foreignPlaced = (await db.run(`INSERT INTO collection (card_id, user_id, quantity, location_id, compartment_id)
      VALUES ('spare-card', 2, 5, ?, ?)`, [transferBox, transferComp])).lastID;
    await request(`/locations/${transferBox}`, 'PUT', { cover_card_id: 'archive-card', allow_stacking: true });
    const snapshot = async () => ({
      locations: await db.all('SELECT * FROM locations ORDER BY id'),
      compartments: await db.all('SELECT * FROM compartments ORDER BY id'),
      cards: await db.all('SELECT * FROM collection ORDER BY id')
    });
    const transfer = (id, inventory_type, user = 1, status = 200) =>
      request(`/locations/${id}/transfer`, 'POST', { inventory_type }, user, status);
    const rejectTransfer = async (id, inventory_type, user, status) => {
      const before = await snapshot();
      await transfer(id, inventory_type, user, status);
      assert.deepStrictEqual(await snapshot(), before, 'rejected transfer leaves all containers and cards unchanged');
    };
    for (const invalid of ['arena', '', null, undefined, 1, ['graveyard']]) {
      await rejectTransfer(transferBox, invalid, 1, 400);
    }
    await rejectTransfer(transferBox, 'graveyard', 2, 404);
    await rejectTransfer(2147483647, 'graveyard', 1, 404);
    await request(`/locations/${transferBox}`, 'PUT', { locked: true });
    await rejectTransfer(transferBox, 'graveyard', 1, 409);
    const lockedBefore = await snapshot();
    assert.strictEqual((await transfer(transferBox, 'collection')).affected, 0);
    assert.deepStrictEqual(await snapshot(), lockedBefore, 'same-inventory transfer is a safe no-op even when locked');
    await request(`/locations/${transferBox}`, 'PUT', { locked: false });
    await request(`/compartments/${transferComps[1].id}`, 'PATCH', { locked: true });
    await rejectTransfer(transferBox, 'graveyard', 1, 409);
    await request(`/compartments/${transferComps[1].id}`, 'PATCH', { locked: false });
    const transferDeck = (await db.run(`INSERT INTO decks (name, user_id, checked_out) VALUES ('Transfer guard', 1, 1)`)).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'archive-card', 999)`, [transferDeck]);

    const beforeTransfer = await snapshot();
    assert.strictEqual((await transfer(transferBox, 'graveyard')).affected, 3);
    const expectedArchive = {
      ...beforeTransfer,
      locations: beforeTransfer.locations.map(row => row.id === transferBox ? { ...row, inventory_type: 'graveyard' } : row),
      cards: beforeTransfer.cards.map(row => row.user_id === 1 && (row.location_id === transferBox || row.compartment_id === transferComp)
        ? { ...row, list_type: 'graveyard' } : row)
    };
    assert.deepStrictEqual(await snapshot(), expectedArchive, 'transfer preserves every field except inventory, including compartment-only placement');
    assert.strictEqual((await db.get('SELECT checked_out FROM decks WHERE id = ?', [transferDeck])).checked_out, 1);
    assert.strictEqual((await db.get('SELECT quantity FROM deck_cards WHERE deck_id = ?', [transferDeck])).quantity, 999);
    const reservations = await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [transferDeck]);
    assert.ok(reservations.some(row => row.entry_id === transferEntry && row.quantity === 3), 'archive retains the exact checked-out copies');
    assert.ok(!(await request('/collection')).some(row => row.entry_id === transferEntry), 'archived reservations do not supply physical inventory');
    const returnLocations = await request(`/decks/${transferDeck}/locations`);
    assert.ok(returnLocations.some(card => card.locations.some(location => location.entry_id === transferEntry)), 'return guide retains the archived copy location');
    assert.strictEqual((await request('/collection?list_type=graveyard')).find(row => row.entry_id === transferEntry).position, 4000);
    assert.ok(!(await request('/locations')).some(row => row.id === transferBox));
    assert.strictEqual((await request('/locations?inventory_type=graveyard')).find(row => row.id === transferBox).cover_card_id, 'archive-card');
    assert.strictEqual((await db.get('SELECT list_type FROM collection WHERE id = ?', [foreignPlaced])).list_type, 'collection');
    assert.strictEqual((await transfer(transferBox, 'graveyard')).affected, 0);
    assert.deepStrictEqual(await snapshot(), expectedArchive);
    await rejectTransfer(transferBox, 'collection', 2, 404);
    await request(`/locations/${transferBox}`, 'PUT', { locked: true });
    await rejectTransfer(transferBox, 'collection', 1, 409);
    await request(`/locations/${transferBox}`, 'PUT', { locked: false });
    await request(`/compartments/${transferComp}`, 'PATCH', { locked: true });
    await rejectTransfer(transferBox, 'collection', 1, 409);
    await request(`/compartments/${transferComp}`, 'PATCH', { locked: false });
    assert.strictEqual((await transfer(transferBox, 'collection')).affected, 3);
    assert.deepStrictEqual(await snapshot(), beforeTransfer, 'roundtrip restores the exact container, layout, contents, quantities and metadata');
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations WHERE deck_id = ?', [transferDeck]), reservations, 'restore preserves reservations');

    const emptyBox = (await create('Empty transfer', 'collection')).id;
    const beforeEmpty = await snapshot();
    assert.strictEqual((await transfer(emptyBox, 'graveyard')).affected, 0);
    assert.strictEqual((await request(`/locations/${emptyBox}`)).inventory_type, 'graveyard');
    assert.strictEqual((await transfer(emptyBox, 'collection')).affected, 0);
    assert.deepStrictEqual(await snapshot(), beforeEmpty, 'empty containers also transfer and restore without altering anything else');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testGraveyard().then(() => console.log('Graveyard archive HTTP/database self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
