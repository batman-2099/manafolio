// Run: node test/magiconly.test.js
const assert = require('assert');
const express = require('express');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-magiconly-${process.pid}.db`);
const db = require('../src/db');
const sets = require('../src/routes/sets');
const decks = require('../src/routes/decks');

async function main() {
  await db.initDb();
  const user = await db.run(
    `INSERT INTO users (username, password_hash, share_token) VALUES (?, ?, ?)`,
    ['magic-only-test', 'hash', 'magic-only-test-token']
  );
  await db.run(`INSERT INTO sets (id, name, game) VALUES (?, ?, ?)`, ['mtg-test', 'Magic Test', 'mtg']);
  await db.run(`INSERT INTO sets (id, name, game) VALUES (?, ?, ?)`, ['unsupported-test', 'Legacy Test', 'unsupported']);
  await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, ?, ?)`, [user.lastID, 'Magic Deck', 'mtg']);
  await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, ?, ?)`, [user.lastID, 'Legacy Deck', 'unsupported']);
  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-legacy', 'Stored Legacy Card', 'unsupported')`);
  const legacyEntry = await db.run(`INSERT INTO collection (card_id, user_id, game) VALUES ('mtg-legacy', ?, 'unsupported')`, [user.lastID]);
  const legacyLocation = await db.run(`INSERT INTO locations (name, type, game, user_id) VALUES ('Legacy Box', 'Box', 'unsupported', ?)`, [user.lastID]);
  const storedRows = async () => Promise.all(['sets', 'card_cache', 'collection', 'locations', 'decks'].map(table => db.all(`SELECT * FROM ${table} ORDER BY id`)));
  const before = await storedRows();
  await db.initDb();
  assert.deepStrictEqual(await storedRows(), before, 'startup must not relabel or delete stored identities');
  const cardApi = require('../src/utils/cardApi');
  assert.throws(() => cardApi.gameOf('mtg-card', 'unsupported'), /Unsupported/);
  assert.throws(() => cardApi.gameOf('unsupported-card', 'mtg'), /Unsupported/);
  await assert.rejects(cardApi.getCardById('mtg-legacy'), /Unsupported/);
  await assert.rejects(cardApi.printingInLanguage({ id: 'mtg-legacy', game: 'unsupported', language: 'English' }, 'English'), /Unsupported/);
  await assert.rejects(require('../src/scryfallApi').cacheCards([{ id: 'mtg-legacy', name: 'New Magic Card', game: 'mtg' }]), /identity conflicts/);
  assert.deepStrictEqual(await storedRows(), before, 'provider hydration must not overwrite a stored game identity');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: user.lastID }; next(); });
  app.use('/sets', sets);
  app.use('/decks', decks);
  app.use('/api', require('../src/routes/collection'));
  app.use('/io', require('../src/routes/importExport'));
  app.use('/storage', require('../src/routes/storage'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.strictEqual((await fetch(`${base}/sets?game=unsupported`)).status, 400);
    for (const endpoint of ['/api/search', '/api/scan-sets', '/api/collection']) {
      assert.strictEqual((await fetch(`${base}${endpoint}?game=unsupported`)).status, 400);
    }
    const send = (method, endpoint, body) => fetch(`${base}${endpoint}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.strictEqual((await send('POST', '/api/scan-match', { game: 'unsupported', image: 'x' })).status, 400);
    assert.strictEqual((await send('POST', '/io/import', { format: 'json', data: [{ card_id: 'mtg-legacy', game: 'mtg' }] })).status, 400);
    assert.strictEqual((await send('POST', '/io/import', { format: 'json', data: [{ card_id: 'unsupported-card', game: 'unsupported' }] })).status, 400);
    assert.strictEqual((await send('PUT', `/api/collection/${legacyEntry.lastID}`, { game: 'mtg' })).status, 400);
    assert.strictEqual((await send('PUT', `/storage/locations/${legacyLocation.lastID}`, { game: 'mtg' })).status, 400);
    const backup = await (await fetch(`${base}/io/export?format=backup`)).json();
    assert.deepStrictEqual(backup.card_cache.map(card => [card.id, card.game]), [['mtg-legacy', 'unsupported']]);
    assert.deepStrictEqual(backup.collection.map(card => [card.card_id, card.game]), [['mtg-legacy', 'unsupported']]);
    assert.ok(backup.decks.some(deck => deck.name === 'Legacy Deck' && deck.game === 'unsupported'));
    assert.ok(backup.locations.some(location => location.name === 'Legacy Box' && location.game === 'unsupported'));
    assert.strictEqual((await send('POST', '/io/import', { format: 'backup', data: backup })).status, 400);
    const emptyBackup = Object.fromEntries(Object.entries(backup).map(([key, value]) => [key, Array.isArray(value) ? [] : value]));
    assert.strictEqual((await send('POST', '/io/import', { format: 'backup', data: emptyBackup })).status, 400,
      'even a supported backup must not silently replace unsupported stored records');
    assert.deepStrictEqual(await storedRows(), before, 'rejected requests and restores leave every stored row untouched');
    const setRows = await (await fetch(`${base}/sets`)).json();
    assert.deepStrictEqual(setRows.map(row => row.game), ['mtg']);

    const deckRows = await (await fetch(`${base}/decks`)).json();
    assert.deepStrictEqual(deckRows.map(row => row.name), ['Magic Deck']);

    const response = await fetch(`${base}/decks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Unsupported Deck', game: 'unsupported' }),
    });
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await db.get(`SELECT COUNT(*) AS count FROM decks WHERE name = 'Unsupported Deck'`)).count, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  console.log('Magic-only API regression check passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
