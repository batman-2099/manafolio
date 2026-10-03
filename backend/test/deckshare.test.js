const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-deck-share-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
process.env.PUBLIC_BASE_URL = 'https://share.example.test/base/';
const db = require('../src/db');

async function testSharing() {
  let server;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')");
    await db.run(`INSERT INTO card_cache (id, name, printed_name, game, supertype, types, subtypes, color_identity, price_trend)
      VALUES ('mtg-public', 'Public card', 'Printed card', 'mtg', 'Creature', '["Creature"]', '["Elf"]', '["G"]', 999),
      ('mtg-private', 'Private collection card', NULL, 'mtg', 'Land', '[]', '[]', '[]', 500)`);
    await db.run(`INSERT INTO collection (card_id, quantity, user_id, notes, purchase_price, game)
      VALUES ('mtg-private', 17, 1, 'Secret collection notes', 123, 'mtg')`);
    const id = (await db.run(`INSERT INTO decks (user_id, name, description, notes, game, format, category, target_size, commander_card_id)
      VALUES (1, 'Shared sample', 'Public strategy', 'Private strategy', 'mtg', 'Commander', 'Casual', 100, 'mtg-public')`)).lastID;
    await db.run('UPDATE decks SET wins = 8, losses = 3 WHERE id = ?', [id]);
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (?, 'mtg-public', 3, 1)", [id]);
    const app = express();
    app.use(express.json());
    app.use('/api/shared', require('../src/routes/shared'));
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/api/decks', require('../src/routes/decks'));
    app.use('/api', require('../src/routes/importExport'));
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function request(method, route, body, user = 1) {
      const response = await fetch(`${base}/api${route}`, {
        method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: response.status, body: await response.json() };
    }
    const manage = (method, deckId = id, user = 1) => request(method, `/decks/${deckId}/share`, undefined, user);
    const publicDeck = token => request('GET', `/shared/decks/${token}`);
    const tokenOf = response => response.body.url.split('/').pop();
    assert.deepStrictEqual(await manage('GET'), { status: 200, body: { url: null } });
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.strictEqual((await manage(method, id, 2)).status, 404);
      assert.strictEqual((await manage(method, 999999)).status, 404);
      for (const invalid of ['0', '-1', '1x', '01', '9007199254740992']) {
        assert.strictEqual((await manage(method, invalid)).status, 400);
      }
    }
    const concurrent = await Promise.all([manage('POST'), manage('POST'), manage('POST')]);
    const created = concurrent[0];
    assert.strictEqual(created.status, 200);
    assert.match(created.body.url, /^\/share\/deck\/[a-f0-9]{64}$/, 'links must not inherit the backend host or configured base URL');
    for (const response of concurrent) assert.deepStrictEqual(response, created);
    assert.deepStrictEqual(await manage('GET'), created);
    const token = tokenOf(created);
    for (const method of ['GET', 'POST', 'DELETE']) assert.strictEqual((await manage(method, id, 2)).status, 404);
    const shared = await publicDeck(token);
    assert.strictEqual(shared.status, 200);
    assert.deepStrictEqual(Object.keys(shared.body).sort(), ['cards', 'deck', 'owner']);
    assert.strictEqual(shared.body.owner, 'admin');
    assert.deepStrictEqual(shared.body.deck, {
      name: 'Shared sample', description: 'Public strategy', game: 'mtg', format: 'Commander',
      category: 'Casual', wins: 8, losses: 3, commander_card_id: 'mtg-public'
    });
    assert.deepStrictEqual(shared.body.cards, [{
      id: 'mtg-public', name: 'Public card', printed_name: 'Printed card', set_id: null, set_name: null,
      number: null, image_url: null, game: 'mtg', supertype: 'Creature', types: ['Creature'], subtypes: ['Elf'],
      rarity: null, cmc: null, color_identity: ['G'], quantity: 3
    }]);
    assert.strictEqual((await request('GET', `/shared/${token}`)).status, 404, 'deck capabilities cannot expose collections');
    const owner = await db.get('SELECT share_token, share_enabled FROM users WHERE id = 1');
    assert.strictEqual(owner.share_enabled, 0);
    assert.strictEqual((await publicDeck(owner.share_token)).status, 404, 'collection capabilities cannot expose decks');
    for (const invalid of ['bad', 'a'.repeat(63), 'A'.repeat(64), '0'.repeat(64)]) {
      assert.strictEqual((await publicDeck(invalid)).status, 404);
    }
    assert.strictEqual((await request('PUT', `/decks/${id}`, { name: 'Saved rename', description: 'Saved description' })).status, 200);
    await db.run('UPDATE deck_cards SET quantity = 7 WHERE deck_id = ?', [id]);
    const saved = (await publicDeck(token)).body;
    assert.strictEqual(saved.deck.name, 'Saved rename');
    assert.strictEqual(saved.deck.description, 'Saved description');
    assert.strictEqual(saved.cards[0].quantity, 7);
    const copy = await request('POST', `/decks/${id}/duplicate`, {});
    assert.strictEqual(copy.status, 201);
    assert.deepStrictEqual((await manage('GET', copy.body.id)).body, { url: null });
    const copyShare = await manage('POST', copy.body.id);
    assert.notStrictEqual(tokenOf(copyShare), token);
    assert.strictEqual((await publicDeck(tokenOf(copyShare))).body.cards[0].quantity, 7);
    for (const inventory of ['arena', 'graveyard']) {
      const deckId = (await db.run('INSERT INTO decks (user_id, name, inventory_type) VALUES (1, ?, ?)', [inventory, inventory])).lastID;
      const share = await manage('POST', deckId);
      assert.strictEqual(share.status, 200);
      assert.deepStrictEqual((await publicDeck(tokenOf(share))).body.cards, []);
    }
    const backup = await request('GET', '/export?format=backup');
    assert.strictEqual(backup.status, 200);
    assert.ok(!JSON.stringify(backup.body).includes(token), 'account backups exclude share credentials');
    assert.ok(!Object.hasOwn(backup.body, 'deck_shares'));
    assert.deepStrictEqual(await manage('DELETE'), { status: 200, body: { success: true } });
    assert.strictEqual((await publicDeck(token)).status, 404);
    assert.deepStrictEqual((await manage('GET')).body, { url: null });
    const recreated = tokenOf(await manage('POST'));
    assert.notStrictEqual(recreated, token);
    assert.strictEqual((await publicDeck(token)).status, 404);
    assert.strictEqual((await publicDeck(recreated)).status, 200);
    assert.strictEqual((await request('POST', `/decks/${id}/share`, { regenerate: 'true' })).status, 400);
    assert.strictEqual((await request('POST', `/decks/${id}/share`, { regenerate: true }, 2)).status, 404);
    assert.strictEqual(tokenOf(await manage('GET')), recreated);
    await db.run(`CREATE TRIGGER fail_share_rotation BEFORE UPDATE ON deck_shares BEGIN SELECT RAISE(ABORT, 'rotation failure'); END`);
    assert.strictEqual((await request('POST', `/decks/${id}/share`, { regenerate: true })).status, 500);
    assert.strictEqual((await publicDeck(recreated)).status, 200);
    await db.run('DROP TRIGGER fail_share_rotation');
    const rotated = await request('POST', `/decks/${id}/share`, { regenerate: true });
    assert.strictEqual(rotated.status, 200);
    assert.notStrictEqual(tokenOf(rotated), recreated);
    assert.strictEqual((await publicDeck(recreated)).status, 404);
    assert.strictEqual((await publicDeck(tokenOf(rotated))).status, 200);
    assert.deepStrictEqual(await manage('GET'), rotated);
    assert.deepStrictEqual(await manage('POST'), rotated);
    const cardsBeforeDelete = await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [id]);
    assert.strictEqual((await request('DELETE', `/decks/${id}`, undefined, 2)).status, 404);
    await db.run(`CREATE TRIGGER fail_deck_delete BEFORE DELETE ON decks BEGIN SELECT RAISE(ABORT, 'delete failure'); END`);
    assert.strictEqual((await request('DELETE', `/decks/${id}`)).status, 500);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [id]), cardsBeforeDelete,
      'failed deck deletion must retain its card list');
    assert.strictEqual((await publicDeck(tokenOf(rotated))).status, 200);
    await db.run('DROP TRIGGER fail_deck_delete');
    assert.strictEqual((await request('DELETE', `/decks/${id}`)).status, 200);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [id]), []);
    assert.strictEqual((await publicDeck(recreated)).status, 404);
    assert.strictEqual((await publicDeck(tokenOf(rotated))).status, 404);
    // Even a hand-edited backup cannot inject credentials into restored definitions.
    backup.body.deck_shares = [{ deck_id: id, token }];
    backup.body.decks[0].share_token = token;
    assert.strictEqual((await request('POST', '/import', { format: 'backup', data: backup.body })).status, 200);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_shares'), []);
    assert.strictEqual((await publicDeck(tokenOf(copyShare))).status, 404);
    const restored = await db.get("SELECT id FROM decks WHERE name = 'Saved rename'");
    assert.deepStrictEqual((await manage('GET', restored.id)).body, { url: null });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testSharing().then(() => console.log('Deck sharing privacy HTTP self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
