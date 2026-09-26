const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-deck-mana-counts-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');
const listDecks = deckRouter.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;

async function testDeckManaCounts() {
  try {
    await db.initDb();
    await db.run('INSERT INTO users (username, password_hash, role, share_token) VALUES (?, ?, ?, ?)', ['mana-test', 'x', 'admin', 'mana-test']);
    const deck = await db.run('INSERT INTO decks (name, user_id, game) VALUES (?, ?, ?)', ['Mana Test', 1, 'mtg']);
    await db.run('INSERT INTO card_cache (id, name, color_identity, game) VALUES (?, ?, ?, ?)', ['white', 'Plains', '["White"]', 'mtg']);
    await db.run('INSERT INTO card_cache (id, name, color_identity, game) VALUES (?, ?, ?, ?)', ['multicolor', 'Selesnya Charm', '["White","Green"]', 'mtg']);
    await db.run('INSERT INTO card_cache (id, name, color_identity, game) VALUES (?, ?, ?, ?)', ['blue', 'Island', '["U"]', 'mtg']);
    await db.run('INSERT INTO card_cache (id, name, color_identity, game) VALUES (?, ?, ?, ?)', ['colorless', 'Wastes', '[]', 'mtg']);
    for (const [cardId, quantity] of [['white', 2], ['multicolor', 3], ['blue', 1], ['colorless', 5]]) {
      await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)', [deck.lastID, cardId, quantity]);
    }

    const res = { json(body) { this.body = body; } };
    await listDecks({ user: { id: 1 } }, res);
    assert.deepStrictEqual(res.body[0].white_cards, 5);
    assert.deepStrictEqual(res.body[0].blue_cards, 1);
    assert.deepStrictEqual(res.body[0].green_cards, 3);
    assert.deepStrictEqual(res.body[0].black_cards, 0);
    assert.deepStrictEqual(res.body[0].red_cards, 0);
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testDeckManaCounts()
  .then(() => console.log('Deck mana count self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
