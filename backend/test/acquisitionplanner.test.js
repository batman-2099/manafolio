const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-acquisition-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'isolated-test-password';
const db = require('../src/db');

async function run() {
  let server;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, api_key, share_token) VALUES (2, 'other', 'unused', 'read-only', 'other-share')");
    await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES ('owner', 1, DATETIME('now', '+1 day')), ('other', 2, DATETIME('now', '+1 day'))");
    for (const [id, name, price, currency] of [['a', 'Shared card', 2, 'USD'], ['b', 'Shared card', 4, 'USD'], ['c', 'Unknown card', null, 'USD'], ['d', 'Euro card', 3, 'EUR']]) {
      await db.run('INSERT INTO card_cache (id, name, game, price_normal, price_currency, set_id, number) VALUES (?, ?, \'mtg\', ?, ?, \'test\', \'1\')', [id, name, price, currency]);
    }
    await db.run("INSERT INTO decks (id, user_id, name, inventory_type, checked_out) VALUES (1, 1, 'First sample deck', 'collection', 1), (2, 1, 'Second sample deck', 'collection', 0), (3, 1, 'Arena sample', 'arena', 0), (4, 1, 'Archived sample', 'graveyard', 0)");
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (1, 'a', 4), (2, 'b', 3), (2, 'c', 2), (2, 'd', 1), (3, 'a', 25)");
    for (const [card, qty, list, missing, user = 1] of [['a', 2, 'collection', 0], ['b', 1, 'collection', 0], ['a', 10, 'collection', 1], ['a', 20, 'arena', 0], ['a', 10, 'graveyard', 0], ['a', 1, 'wishlist', 0], ['b', 1, 'wishlist', 0], ['a', 100, 'collection', 0, 2]]) {
      await db.run('INSERT INTO collection (card_id, quantity, list_type, missing, user_id) VALUES (?, ?, ?, ?, ?)', [card, qty, list, missing, user]);
    }
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/middleware/auth').authenticateToken);
    app.use('/api/decks', require('../src/routes/decks'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api/decks/acquisition-plan`;
    const request = async (body, token = 'owner', save = false) => {
      const response = await fetch(base + (save ? '/wishlist' : ''), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const selection = { deck_ids: [1, 2], preference: 'any' };
    const before = await db.all('SELECT * FROM collection ORDER BY id');
    const preview = await request(selection);
    assert.equal(preview.status, 200);
    assert.deepStrictEqual(preview.body.items.map(({ name, required, owned, needed, wishlist, to_add }) => ({ name, required, owned, needed, wishlist, to_add })), [
      { name: 'Shared card', required: 7, owned: 3, needed: 4, wishlist: 2, to_add: 2 },
      { name: 'Unknown card', required: 2, owned: 0, needed: 2, wishlist: 0, to_add: 2 },
      { name: 'Euro card', required: 1, owned: 0, needed: 1, wishlist: 0, to_add: 1 },
    ]);
    assert.deepStrictEqual(preview.body.totals, { USD: 8, EUR: 3 });
    assert.equal(preview.body.unknown, 2);
    assert.equal(preview.body.items[1].estimated_cost, null);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), before, 'preview and cancellation do not write');
    const exact = await request({ ...selection, preference: 'exact' });
    assert.deepStrictEqual(exact.body.items.slice(0, 2).map(item => [item.required, item.owned, item.needed, item.wishlist, item.to_add]), [[4, 2, 2, 1, 1], [3, 1, 2, 1, 1]]);
    for (const ids of [[1, 3], [4], [1, 1], [], [999]]) assert.notEqual((await request({ ...selection, deck_ids: ids })).status, 200);
    const arena = await request({ deck_ids: [3], preference: 'any' });
    assert.deepStrictEqual([arena.body.items[0].owned, arena.body.items[0].needed, arena.body.items[0].wishlist, arena.body.items[0].unit_price], [20, 5, 0, null]);
    assert.equal((await request({ deck_ids: [3], preference: 'any', confirmed: true, revision: arena.body.revision }, 'owner', true)).status, 400);
    assert.equal((await request(selection, null)).status, 401);
    assert.equal((await request(selection, 'other')).status, 404);
    assert.equal((await request(selection, 'read-only')).status, 403);
    assert.equal((await request(selection, 'owner', true)).status, 400);
    const confirmation = { ...selection, confirmed: true, revision: preview.body.revision };
    assert.equal((await request(confirmation, 'other', true)).status, 404);
    const saved = await Promise.all([request(confirmation, 'owner', true), request(confirmation, 'owner', true)]);
    assert.deepStrictEqual(saved.map(result => result.status).sort(), [200, 409]);
    assert.equal(saved.find(result => result.status === 200).body.added, 5);
    const after = await request(selection);
    assert.deepStrictEqual(after.body.items.map(item => item.to_add), [0, 0, 0]);
    assert.deepStrictEqual(await db.all("SELECT * FROM collection WHERE list_type != 'wishlist' ORDER BY id"), before.filter(row => row.list_type !== 'wishlist'));
    await db.run("UPDATE deck_cards SET quantity = 10 WHERE deck_id = 1 AND card_id = 'a'");
    assert.equal((await request({ ...selection, confirmed: true, revision: after.body.revision }, 'owner', true)).status, 409);
    console.log('Acquisition planner HTTP regression passed: overlap, inventories, prices, authorization, cancellation, stale plans and concurrent confirmation.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
