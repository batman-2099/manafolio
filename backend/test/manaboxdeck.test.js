const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseManaboxText } = require('../src/utils/csvMappers');

const decklist = fs.readFileSync(path.join(__dirname, 'fixtures', 'zoraline-deck.txt'), 'utf8');
const expected = parseManaboxText(decklist);
const greenRampDecklist = fs.readFileSync(path.join(__dirname, 'fixtures', 'green-ramp-deck.txt'), 'utf8');
const greenRampExpected = parseManaboxText(greenRampDecklist);
const firstDeckCardId = `mtg-test-${expected[0].set_code}-${expected[0].collector_number}-0`;
const tmpDb = path.join(os.tmpdir(), `manafolio-manabox-deck-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const deckRouter = require('../src/routes/decks');
const createDeck = deckRouter.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack[0].handle;
const duplicateDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id/duplicate' && layer.route.methods.post).route.stack[0].handle;
const updateDeck = deckRouter.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.put).route.stack[0].handle;
const { validateDeckAddition } = require('../src/utils/deckRules');

async function testManaBoxDeckCreation() {
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  const originalCacheCards = scryfallApi.cacheCards;

  try {
    await db.initDb();
    scryfallApi.bulkFetchByIdentifier = async rows => {
      const cards = rows.map((row, index) => ({ id: `mtg-test-${row.set_id}-${row.number}-${index}`, name: row.name, game: 'mtg' }));
      return { cards, pairs: rows.map((row, index) => ({ row, card: cards[index] })) };
    };
    scryfallApi.cacheCards = async cards => {
      for (const card of cards) {
        const basicLand = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'].includes(card.name);
        await db.run('INSERT OR IGNORE INTO card_cache (id, name, game, supertype, subtypes) VALUES (?, ?, ?, ?, ?)', [card.id, card.name, card.game, basicLand ? 'Land' : null, basicLand ? JSON.stringify(['Basic', 'Land', card.name]) : null]);
        await db.run('INSERT INTO collection (card_id, user_id, quantity, list_type) VALUES (?, ?, ?, ?)', [card.id, 1, 999, 'arena']);
      }
    };

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await createDeck({
      body: { name: "Zoraline's Last Light", game: 'mtg', inventory_type: 'arena', decklist_format: 'manabox', decklist_text: decklist },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 201);
    const imported = await db.all(`
      SELECT cc.name, dc.quantity FROM deck_cards dc
      JOIN card_cache cc ON cc.id = dc.card_id
      WHERE dc.deck_id = ? ORDER BY cc.name
    `, [res.body.id]);
    assert.strictEqual(imported.length, expected.length);
    assert.strictEqual(imported.reduce((sum, card) => sum + card.quantity, 0), expected.reduce((sum, card) => sum + card.quantity, 0));
    assert.deepStrictEqual(imported.find(card => card.name === 'Zoraline, Cosmos Caller'), { name: 'Zoraline, Cosmos Caller', quantity: 1 });
    assert.deepStrictEqual(imported.find(card => card.name === 'Plains'), { name: 'Plains', quantity: 8 });
    assert.strictEqual((await db.get('SELECT inventory_type FROM decks WHERE id = ?', [res.body.id])).inventory_type, 'arena');
    assert.strictEqual((await validateDeckAddition({ deckId: res.body.id, userId: 1, cardId: firstDeckCardId, newQty: 1 })).ok, true, 'Arena deck can use Arena cards');
    assert.strictEqual((await validateDeckAddition({ deckId: res.body.id, userId: 1, cardId: firstDeckCardId, newQty: 1000 })).ok, false, 'Arena deck cannot exceed Arena copies');
    const duplicated = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await duplicateDeck({ params: { id: String(res.body.id) }, user: { id: 1 } }, duplicated);
    assert.strictEqual(duplicated.statusCode, 201);
    assert.deepStrictEqual(
      await db.all(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ? ORDER BY card_id`, [duplicated.body.id]),
      await db.all(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ? ORDER BY card_id`, [res.body.id]),
      'duplicate preserves deck cards'
    );
    assert.deepStrictEqual(
      await db.get(`SELECT name, game, inventory_type, checked_out FROM decks WHERE id = ?`, [duplicated.body.id]),
      { name: "Zoraline's Last Light (Copy)", game: 'mtg', inventory_type: 'arena', checked_out: 0 },
      'duplicate preserves deck metadata without checkout state'
    );
    const updateResponse = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const updateRequest = { params: { id: String(res.body.id) }, user: { id: 1 }, body: { name: "Zoraline's Last Light", inventory_type: 'collection' } };
    await updateDeck(updateRequest, updateResponse);
    assert.strictEqual(updateResponse.statusCode, 400, 'deck cannot switch to an inventory missing its cards');
    await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type) SELECT card_id, user_id, quantity, 'collection' FROM collection WHERE user_id = ? AND list_type = 'arena'`, [1]);
    updateResponse.statusCode = 200;
    await updateDeck(updateRequest, updateResponse);
    assert.strictEqual(updateResponse.statusCode, 200);
    assert.strictEqual((await db.get(`SELECT inventory_type FROM decks WHERE id = ?`, [res.body.id])).inventory_type, 'collection', 'deck switches after every card is available');
    await db.run(`DELETE FROM collection WHERE card_id = ? AND user_id = ? AND list_type = 'arena'`, [firstDeckCardId, 1]);
    await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type) VALUES (?, ?, ?, ?)`, [firstDeckCardId, 1, 1, 'collection']);
    const rejected = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await createDeck({
      body: { name: 'Arena ownership check', game: 'mtg', inventory_type: 'arena', decklist_text: '1 Zoraline, Cosmos Caller' },
      user: { id: 1 }
    }, rejected);
    assert.strictEqual(rejected.statusCode, 400, 'Arena deck import rejects physical-only cards');
    const autoDetected = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await createDeck({
      body: { name: 'Green Ramp', game: 'mtg', decklist_format: 'plain', decklist_text: greenRampDecklist },
      user: { id: 1 }
    }, autoDetected);
    assert.strictEqual(autoDetected.statusCode, 201, 'ManaBox text imports without selecting its format');
    const importedGreenRamp = await db.all(`SELECT card_id, quantity FROM deck_cards WHERE deck_id = ?`, [autoDetected.body.id]);
    assert.strictEqual(importedGreenRamp.length, greenRampExpected.length);
    assert.strictEqual(importedGreenRamp.reduce((sum, card) => sum + card.quantity, 0), 60);
    assert(importedGreenRamp.some(card => card.card_id === 'mtg-test-FDN-227-0'), 'exact ManaBox printing is used');

    scryfallApi.bulkFetchByIdentifier = async () => ({ cards: [], pairs: [] });
    const unmatched = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await createDeck({
      body: { name: 'Unmatched ManaBox deck', game: 'mtg', decklist_format: 'manabox', decklist_text: greenRampDecklist },
      user: { id: 1 }
    }, unmatched);
    assert.strictEqual(unmatched.statusCode, 422);
    assert.strictEqual(unmatched.body.error, `Only 0 of ${greenRampExpected.length} ManaBox cards matched Scryfall`);
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    scryfallApi.cacheCards = originalCacheCards;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testManaBoxDeckCreation()
  .then(() => console.log('ManaBox deck creation self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
