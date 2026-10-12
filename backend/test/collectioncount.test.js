const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-count-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const db = require('../src/db');
const express = require('express');
let server;
(async () => {
  await db.initDb();
  const { lastID: user } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('count-owner', 'unused', 'count-owner-share')");
  const { lastID: other } = await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('count-other', 'unused', 'count-other-share')");
  await db.run("INSERT INTO card_cache (id, name, game) VALUES ('mtg-count-a', 'Sample', 'mtg'), ('mtg-count-b', 'Sample', 'mtg')");
  for (const [owner, card, inventory, quantity, finish] of [
    [user, 'mtg-count-a', 'collection', 3, 'Normal'],
    [user, 'mtg-count-a', 'collection', 2, 'Holofoil'],
    [user, 'mtg-count-a', 'arena', 4, 'Normal'],
    [user, 'mtg-count-a', 'wishlist', 8, 'Normal'],
    [user, 'mtg-count-a', 'graveyard', 9, 'Normal'],
    [other, 'mtg-count-a', 'collection', 20, 'Normal'],
    [user, 'mtg-count-b', 'collection', 7, 'Normal'],
  ]) await db.run('INSERT INTO collection (user_id, card_id, list_type, quantity, printing) VALUES (?, ?, ?, ?, ?)', [owner, card, inventory, quantity, finish]);
  const app = express();
  app.use((req, res, next) => { req.user = { id: user }; next(); });
  app.use('/api', require('../src/routes/collection'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = query => fetch(`http://127.0.0.1:${server.address().port}/api/collection?${query}`);
  for (const [query, expected] of [
    ['card_id=mtg-count-a&list_type=collection', 5],
    ['card_id=mtg-count-a&list_type=arena', 4],
    ['card_id=mtg-count-b&list_type=collection', 7],
    ['card_id=mtg-count-absent&list_type=collection', 0],
    ['list_type=collection', 12],
  ]) {
    const response = await get(query);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reduce((sum, row) => sum + row.quantity, 0), expected);
  }
  assert.equal((await get('card_id=')).status, 400);
  console.log('Exact-printing counts: quantities, finishes, account/inventory isolation, zero and unfiltered collection passed');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
