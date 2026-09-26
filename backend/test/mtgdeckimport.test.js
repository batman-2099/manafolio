const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-mtg-deck-import-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const mtgjsonApi = require('../src/mtgjsonApi');
const collectionRouter = require('../src/routes/collection');
const decksRouter = require('../src/routes/decks');

const routeHandler = (path, method) => {
  const route = collectionRouter.stack.find(layer => layer.route?.path === path && layer.route.methods[method]);
  return route.route.stack.at(-1).handle;
};

const searchDecks = routeHandler('/mtg-decks', 'get');
const getDeckDetails = routeHandler('/mtg-decks/:fileName', 'get');
const importDeck = routeHandler('/mtg-decks/:fileName/import', 'post');
const createDeck = (() => {
  const route = decksRouter.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post);
  return route.route.stack.at(-1).handle;
})();

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function testMtgDeckImport() {
  const originalGet = mtgjsonApi.client.get;
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  const originalCacheCards = scryfallApi.cacheCards;
  try {
    await db.initDb();
    mtgjsonApi.resetDeckListCache();
    mtgjsonApi.client.get = async (url) => {
      if (url === '/DeckList.json') {
        return { data: { data: [{ code: 'TST', fileName: 'ExampleDeck_TST', name: 'Example Deck', releaseDate: '2026-01-01', type: 'Commander Deck' }] } };
      }
      assert.strictEqual(url, '/decks/ExampleDeck_TST.json');
      return { data: { data: {
        name: 'Example Deck',
        commander: [{ name: 'Example Card', count: 1, type: 'Creature — Wizard', types: ['Creature'], setCode: 'tst', number: '1', identifiers: { scryfallId: '11111111-1111-1111-1111-111111111111' } }],
        mainBoard: [
          { name: 'Example Card', count: 2, type: 'Creature — Wizard', types: ['Creature'], setCode: 'tst', number: '1', identifiers: { scryfallId: '11111111-1111-1111-1111-111111111111' } },
          { name: 'Example Spell', count: 1, type: 'Instant', types: ['Instant'], setCode: 'tst', number: '3', identifiers: { scryfallId: '33333333-3333-3333-3333-333333333333' } },
        ],
        sideBoard: [{ name: 'Side Card', count: 1, isFoil: true, type: 'Land', types: ['Land'], setCode: 'tst', number: '2', identifiers: { scryfallId: '22222222-2222-2222-2222-222222222222' } }],
      } } };
    };
    scryfallApi.bulkFetchByIdentifier = async rows => {
      const cards = rows.map((row, index) => ({ id: `mtg-${index + 1}`, name: row.name, game: 'mtg', language: 'English' }));
      return { cards, pairs: rows.map((row, index) => ({ row, card: cards[index] })) };
    };
    scryfallApi.cacheCards = async cards => {
      for (const card of cards) {
        await db.run('INSERT OR REPLACE INTO card_cache (id, name, game, language) VALUES (?, ?, ?, ?)', [card.id, card.name, card.game, card.language]);
      }
    };

    const searchRes = response();
    await searchDecks({ query: { q: 'example' } }, searchRes);
    assert.deepStrictEqual(searchRes.body, [{ code: 'TST', fileName: 'ExampleDeck_TST', name: 'Example Deck', releaseDate: '2026-01-01', type: 'Commander Deck' }]);
    const detailsRes = response();
    await getDeckDetails({ params: { fileName: 'ExampleDeck_TST' } }, detailsRes);
    assert.deepStrictEqual(detailsRes.body, {
      name: 'Example Deck',
      creatures: [{ name: 'Example Card', count: 3, type: 'Creature — Wizard', setCode: 'tst', number: '1' }],
      spells: [{ name: 'Example Spell', count: 1, type: 'Instant', setCode: 'tst', number: '3' }],
      lands: [{ name: 'Side Card', count: 1, type: 'Land', setCode: 'tst', number: '2' }],
    });

    const importRes = response();
    await importDeck({ params: { fileName: 'ExampleDeck_TST' }, body: { create_container: true, create_deck: true }, user: { id: 1 } }, importRes);
    assert.strictEqual(importRes.statusCode, 200);
    assert.strictEqual(importRes.body.added, 5, 'commander, main board, and sideboard counts must all be added');
    assert.strictEqual(importRes.body.missing, 0);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection WHERE user_id = 1')).count, 5);
    assert.strictEqual((await db.get(`SELECT printing FROM collection WHERE card_id = 'mtg-3'`)).printing, 'Holofoil');
    assert.ok(importRes.body.location_id);
    assert.deepStrictEqual(
      await db.get('SELECT name, type, game FROM locations WHERE id = ?', [importRes.body.location_id]),
      { name: 'Example Deck', type: 'Deck Box', game: 'mtg' }
    );
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection WHERE location_id = ?', [importRes.body.location_id])).count, 5);
    const importedDeck = await db.get('SELECT name, checked_out, checked_out_at, user_id, inventory_type FROM decks WHERE id = ?', [importRes.body.deck_id]);
    assert.strictEqual(importedDeck.name, 'Example Deck');
    assert.strictEqual(importedDeck.checked_out, 1);
    assert.ok(importedDeck.checked_out_at);
    assert.strictEqual(importedDeck.user_id, 1);
    assert.strictEqual(importedDeck.inventory_type, 'collection');
    assert.deepStrictEqual(
      await db.all('SELECT card_id, quantity FROM deck_cards WHERE deck_id = ? ORDER BY card_id', [importRes.body.deck_id]),
      [{ card_id: 'mtg-1', quantity: 3 }, { card_id: 'mtg-2', quantity: 1 }, { card_id: 'mtg-3', quantity: 1 }]
    );
    const unpackedRes = response();
    await importDeck({ params: { fileName: 'ExampleDeck_TST' }, body: { create_container: false }, user: { id: 1 } }, unpackedRes);
    assert.strictEqual(unpackedRes.statusCode, 200);
    assert.strictEqual(unpackedRes.body.location_id, null);
    assert.strictEqual((await db.get(`SELECT COUNT(*) AS count FROM locations WHERE user_id = 1 AND name = 'Example Deck'`)).count, 1);
    assert.strictEqual(unpackedRes.body.deck_id, null);
    const deckOnly = response();
    await importDeck({ params: { fileName: 'ExampleDeck_TST' }, body: { create_deck: true }, user: { id: 1 } }, deckOnly);
    assert.strictEqual(deckOnly.statusCode, 200);
    assert.strictEqual(deckOnly.body.location_id, null);
    assert.strictEqual((await db.get('SELECT checked_out FROM decks WHERE id = ?', [deckOnly.body.deck_id])).checked_out, 1);

    const counts = () => db.get(`SELECT (SELECT COUNT(*) FROM collection) AS cards, (SELECT COUNT(*) FROM decks) AS decks`);
    const beforeFailure = await counts();
    await db.run(`CREATE TRIGGER fail_precon BEFORE INSERT ON deck_cards WHEN NEW.card_id = 'mtg-2' BEGIN SELECT RAISE(ABORT, 'test import failure'); END`);
    const failedImport = response();
    await importDeck({ params: { fileName: 'ExampleDeck_TST' }, body: { create_deck: true }, user: { id: 1 } }, failedImport);
    assert.strictEqual(failedImport.statusCode, 502);
    assert.deepStrictEqual(await counts(), beforeFailure, 'failed deck creation must roll back newly imported copies and deck');
    await db.run('DROP TRIGGER fail_precon');
    const fullFetch = scryfallApi.bulkFetchByIdentifier;
    scryfallApi.bulkFetchByIdentifier = async rows => fullFetch(rows.slice(1));
    const incomplete = response();
    await importDeck({ params: { fileName: 'ExampleDeck_TST' }, body: { create_deck: true }, user: { id: 1 } }, incomplete);
    assert.strictEqual(incomplete.statusCode, 422);
    assert.deepStrictEqual(await counts(), beforeFailure);
    scryfallApi.bulkFetchByIdentifier = fullFetch;
    const createRes = response();
    await createDeck({
      body: { name: 'Selected Precon', game: 'mtg', precon_file: 'ExampleDeck_TST' },
      user: { id: 1 }
    }, createRes);
    assert.strictEqual(createRes.statusCode, 201);
    assert.strictEqual((await db.get('SELECT game FROM decks WHERE id = ?', [createRes.body.id])).game, 'mtg');
    assert.deepStrictEqual(
      await db.get('SELECT COUNT(*) AS types, SUM(quantity) AS copies FROM deck_cards WHERE deck_id = ?', [createRes.body.id]),
      { types: 3, copies: 5 },
      'creating from an MTGJSON precon must retain commander, main-board, and sideboard quantities'
    );
  } finally {
    mtgjsonApi.client.get = originalGet;
    mtgjsonApi.resetDeckListCache();
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    scryfallApi.cacheCards = originalCacheCards;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testMtgDeckImport()
  .then(() => console.log('MTGJSON deck import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
