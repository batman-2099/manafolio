const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-token-allocation-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { physicalCardEntries, deckLocations, deckMissingCards, checkedOutAllocation, moveContainerCopies, planCardSources } = require('../src/utils/collectionHelpers');
const { stackKey, STACK_KEY_SQL } = require('../src/utils/compartmentSort');
const { collectionQuery } = require('../src/utils/cardSearchSql');

async function main() {
  let server;
  try {
    await db.initDb();
    for (const [id, name] of [['mtg-front', 'Soldier'], ['mtg-back', 'Spirit'], ['mtg-third', 'Treasure']]) {
      await db.run(`INSERT INTO card_cache (id, name, game, supertype, language, set_id) VALUES (?, ?, 'mtg', 'Token', 'en', 'tst')`, [id, name]);
    }
    const pair = (await db.run(`INSERT INTO collection (card_id, reverse_card_id, quantity, user_id) VALUES ('mtg-front', 'mtg-back', 1, 1)`)).lastID;
    const makeDeck = async (name, inventory = 'collection') => (await db.run('INSERT INTO decks (name, user_id, inventory_type) VALUES (?, 1, ?)', [name, inventory])).lastID;
    const first = await makeDeck('First');
    const second = await makeDeck('Second');
    const arena = await makeDeck('Digital', 'arena');
    const graveyard = await makeDeck('Archived', 'graveyard');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 1 }; next(); });
    app.use('/api/decks', require('../src/routes/decks'));
    app.use('/api/trades', require('../src/routes/trades'));
    app.use('/api', require('../src/routes/storage'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const request = async (method, route, body) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${route}`, {
        method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const add = (deck, card, source) => request('POST', `decks/${deck}/cards`, { card_id: card, quantity: 1, source_entry_id: source });
    const checkout = deck => request('PUT', `decks/${deck}/checkout`, {});
    assert.equal((await physicalCardEntries(1, 'mtg-back'))[0].entry_id, pair);
    const query = collectionQuery('mtg', { userId: 1, name: 'Spirit', limit: 20, offset: 0 });
    assert.equal((await db.all(query.sql, query.params))[0].id, 'mtg-back');
    assert.equal((await add(first, 'mtg-back', pair)).status, 200);
    assert.equal((await request('GET', `decks/${first}`)).body.cards[0].source_entry_id, pair);
    assert.equal((await add(first, 'mtg-front')).status, 400, 'one physical token cannot fill both faces');
    assert.equal((await checkout(first)).status, 200);
    assert.equal((await add(second, 'mtg-front')).status, 200, 'unchecked definitions can share owned cards');
    assert.equal((await checkout(second)).status, 400, 'other face is reserved by first deck');
    const locked = (await request('GET', `decks/${second}`)).body.cards[0];
    assert.equal(locked.locked_qty, 1);
    assert.equal(locked.locked_decks, 'First');
    assert.equal((await checkedOutAllocation(1)).get(pair), 1);
    assert.equal((await deckLocations(await db.get('SELECT * FROM decks WHERE id = ?', [first]), 1))[0].locations[0].entry_id, pair);
    await db.run("UPDATE collection SET list_type = 'graveyard' WHERE id = ?", [pair]);
    assert.equal((await deckMissingCards([await db.get('SELECT * FROM decks WHERE id = ?', [first])], 1)).get(first), 1);
    assert.equal((await deckLocations(await db.get('SELECT * FROM decks WHERE id = ?', [first]), 1))[0].found, 1, 'archival retains exact return allocation');
    assert.equal((await add(arena, 'mtg-back')).status, 400, 'physical or archived pairs never supply Arena');
    assert.equal((await add(graveyard, 'mtg-back')).status, 200, 'archival retains both identities');
    assert.equal((await checkout(graveyard)).status, 400, 'Graveyard cannot reserve a physical pair');
    await db.run("UPDATE collection SET list_type = 'collection' WHERE id = ?", [pair]);
    assert.equal((await request('PUT', `decks/${first}/return`, {})).status, 200);
    await db.run('DELETE FROM deck_cards');
    await db.run('DELETE FROM deck_card_allocations');

    // The first face must use its standalone copy, leaving the pair for the reverse.
    const plain = (await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES ('mtg-front', 1, 1)`)).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-front', 1), (?, 'mtg-back', 1)`, [first, first]);
    const definition = await db.get('SELECT * FROM decks WHERE id = ?', [first]);
    const plan = await deckLocations(definition, 1);
    assert.equal(plan.reduce((sum, row) => sum + row.found, 0), 2);
    assert.equal(plan.find(row => row.card_id === 'mtg-front').locations[0].entry_id, plain);
    assert.equal(plan.find(row => row.card_id === 'mtg-back').locations[0].entry_id, pair);
    assert.equal((await deckMissingCards([definition], 1)).get(first), 0);
    await db.run('DELETE FROM collection WHERE id = ?', [plain]);
    assert.equal((await deckMissingCards([definition], 1)).get(first), 1);
    assert.equal((await checkout(first)).status, 400);
    const boxed = await request('POST', `decks/${first}/container`, { name: 'Token box' });
    assert.equal(boxed.status, 201);
    assert.equal(boxed.body.count, 1, 'deck-to-container moves a paired entry only once');
    assert.equal(boxed.body.missing, 1);
    assert.equal((await db.get('SELECT SUM(quantity) AS n FROM collection')).n, 1);

    // Stocktake splits and later partial moves retain the explicit reverse identity.
    await db.run('UPDATE collection SET quantity = 3 WHERE id = ?', [pair]);
    const snapshot = await request('GET', `locations/${boxed.body.id}/stocktake`);
    assert.equal(snapshot.body.entries[0].reverse_card_id, 'mtg-back');
    const marked = await request('POST', `locations/${boxed.body.id}/stocktake`, {
      revision: snapshot.body.revision, entry_id: pair, copy_index: 1, status: 'missing',
    });
    assert.equal(marked.status, 200);
    assert.equal((await db.get("SELECT SUM(quantity) AS n FROM collection WHERE reverse_card_id = 'mtg-back'")).n, 3);
    const movable = await db.get('SELECT *, id AS entry_id FROM collection WHERE missing = 0 LIMIT 1');
    await db.run('UPDATE collection SET quantity = 2 WHERE id = ?', [movable.id]);
    const moveEntry = { ...movable, quantity: 2, available: 1 };
    const compartment = (await db.get('SELECT id FROM compartments WHERE location_id = ?', [boxed.body.id])).id;
    await db.withTransaction(() => moveContainerCopies(1, boxed.body.id, compartment, [moveEntry], 1));
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM collection WHERE reverse_card_id IS NULL')).n, 0);
    assert.notEqual(stackKey({ card_id: 'mtg-front', reverse_card_id: 'mtg-back' }), stackKey({ card_id: 'mtg-front', reverse_card_id: 'mtg-third' }));
    assert.notEqual(stackKey({ card_id: 'mtg-front', reverse_card_id: 'mtg-back' }), stackKey({ card_id: 'mtg-front' }));
    assert.equal((await db.get(`SELECT COUNT(DISTINCT ${STACK_KEY_SQL}) AS n FROM collection`)).n, 1);

    const available = (await request('GET', 'trades/entries')).body;
    const giving = available[0];
    const trade = { trade_id: 'paired-token-trade-01', giving: [{ entry_id: giving.entry_id, quantity: 1, snapshot: giving.snapshot }],
      receiving: [{ card_id: 'mtg-front', reverse_card_id: 'mtg-third', quantity: 1, printing: 'Normal', language: 'English', condition: 'Near Mint' }] };
    assert.equal((await request('POST', 'trades/confirm', trade)).status, 200);
    assert.equal((await db.get("SELECT SUM(quantity) AS n FROM collection WHERE reverse_card_id = 'mtg-third'")).n, 1);
    const stale = (await request('GET', 'trades/entries')).body.find(row => row.reverse_card_id === 'mtg-third');
    await db.run("UPDATE collection SET reverse_card_id = 'mtg-back' WHERE id = ?", [stale.entry_id]);
    assert.equal((await request('POST', 'trades/review', { ...trade, trade_id: 'paired-token-trade-02', giving: [{ entry_id: stale.entry_id, quantity: 1, snapshot: stale.snapshot }] })).status, 409);

    const entries = [{ entry_id: 1, card_id: 'a', reverse_card_id: 'b', quantity: 2, game: 'mtg' }, { entry_id: 2, card_id: 'a', quantity: 1, game: 'mtg' }];
    const plans = planCardSources(entries, [{ card_id: 'a', quantity: 2 }, { card_id: 'b', quantity: 2 }], 'mtg');
    assert.equal(plans.flatMap(row => [...row.values()]).reduce((sum, n) => sum + n, 0), 3);
    console.log('Paired token allocation, storage, source, trade and search regressions passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
