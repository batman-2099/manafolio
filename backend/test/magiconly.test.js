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
  await db.run(`INSERT INTO sets (id, name, game) VALUES (?, ?, ?)`, ['lorcana-test', 'Lorcana Test', 'lorcana']);
  await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, ?, ?)`, [user.lastID, 'Magic Deck', 'mtg']);
  await db.run(`INSERT INTO decks (user_id, name, game) VALUES (?, ?, ?)`, [user.lastID, 'Lorcana Deck', 'lorcana']);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: user.lastID }; next(); });
  app.use('/sets', sets);
  app.use('/decks', decks);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.strictEqual((await fetch(`${base}/sets?game=unsupported`)).status, 400);
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
