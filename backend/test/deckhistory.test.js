const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-history-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');

(async () => {
  let server;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'history-test-other')");
    await db.run(`INSERT INTO card_cache (id, name, game, supertype, subtypes) VALUES
      ('old', 'Old commander', 'mtg', 'Creature', '[]'), ('new', 'New commander', 'mtg', 'Creature', '[]'),
      ('land', 'Forest', 'mtg', 'Land', '["Basic","Land"]')`);
    const source = (await db.run("INSERT INTO collection (card_id, quantity, game, user_id, list_type) VALUES ('old', 1, 'mtg', 1, 'collection')")).lastID;
    await db.run("INSERT INTO collection (card_id, quantity, game, user_id, list_type) VALUES ('new', 1, 'mtg', 1, 'collection'), ('land', 10, 'mtg', 1, 'collection')");
    const id = (await db.run("INSERT INTO decks (name, game, format, user_id, commander_card_id) VALUES ('History', 'mtg', 'Commander', 1, 'old')")).lastID;
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'old', 1, ?), (?, 'land', 2, NULL)", [id, source, id]);
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use((req, res, next) => { req.user = { id: Number(req.headers['x-test-user'] || 1) }; next(); });
    app.use('/api/decks', require('../src/routes/decks'));
    app.use('/api', require('../src/routes/importExport'));
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const request = async (method, url, body, user = 1) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
        method, headers: { 'Content-Type': 'application/json', 'x-test-user': String(user), Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: res.status, body: await res.json() };
    };
    const history = async () => (await request('GET', `/decks/${id}/revisions`)).body.revisions;
    assert.deepStrictEqual(await history(), [], 'do not invent history before the first edit');
    const draft = { name: 'History', description: '', notes: 'Keep this', format: 'Commander', category: 'Casual', accent_color: '#eab308', target_size: 100,
      inventory_type: 'collection', commander_card_id: 'new', cards: [{ card_id: 'new', quantity: 1, pulled: false }, { card_id: 'land', quantity: 3, pulled: true }] };
    assert.strictEqual((await request('PUT', `/decks/${id}/editor`, draft)).status, 200);
    const first = await history();
    assert.deepStrictEqual(first.map(row => row.kind), ['save', 'baseline']);
    const baseline = first[1];
    assert.strictEqual(baseline.snapshot.commander_card_id, 'old');
    assert.deepStrictEqual(baseline.snapshot.cards, [{ card_id: 'land', quantity: 2, source_entry_id: null }, { card_id: 'old', quantity: 1, source_entry_id: source }]);
    assert.strictEqual((await request('PUT', `/decks/${id}/editor`, { ...draft, cards: [...draft.cards].reverse() })).status, 200);
    assert.deepStrictEqual(await history(), first, 'identical saves and reordered input do not add revisions');
    draft.cards[1].quantity = 5;
    assert.strictEqual((await request('PUT', `/decks/${id}/editor`, draft)).status, 200);
    assert.strictEqual((await history()).length, 3, 'a second real save records the quantity change');
    const reader = new sqlite3.Database(process.env.DB_PATH, sqlite3.OPEN_READONLY);
    assert.strictEqual(await new Promise((resolve, reject) => reader.get('SELECT COUNT(*) AS n FROM deck_revisions', (err, row) => err ? reject(err) : resolve(row.n))), 3);
    await new Promise(resolve => reader.close(resolve));
    assert.strictEqual((await request('GET', `/decks/${id}/revisions`, undefined, 2)).status, 404);
    assert.strictEqual((await request('POST', `/decks/${id}/revisions/${baseline.id}/restore`, {}, 2)).status, 404);
    assert.strictEqual((await request('POST', `/decks/${id}/revisions/999999/restore`, {})).status, 404);
    const inventory = await db.all('SELECT * FROM collection ORDER BY id');
    assert.strictEqual((await request('PUT', `/decks/${id}/checkout`, {})).status, 200);
    const allocations = await db.all('SELECT * FROM deck_card_allocations');
    assert.strictEqual((await request('POST', `/decks/${id}/revisions/${baseline.id}/restore`, {})).status, 400);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_card_allocations'), allocations);
    assert.strictEqual((await history()).length, 3);
    assert.strictEqual((await request('PUT', `/decks/${id}/return`, {})).status, 200);
    assert.strictEqual((await request('POST', `/decks/${id}/revisions/${baseline.id}/restore`, {})).status, 200);
    const restored = (await request('GET', `/decks/${id}`)).body;
    assert.strictEqual(restored.commander_card_id, 'old');
    assert.strictEqual(restored.notes, 'Keep this');
    assert.deepStrictEqual(restored.cards.map(card => [card.id, card.quantity, card.checked_out]).sort(), [['land', 2, 0], ['old', 1, 0]]);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), inventory);
    assert.strictEqual((await history())[0].kind, 'restore');
    // An old source must not silently become an automatic selection after it is deleted.
    assert.strictEqual((await request('PUT', `/decks/${id}/editor`, draft)).status, 200);
    await db.run('DELETE FROM collection WHERE id = ?', [source]);
    const beforeFailure = await history();
    assert.strictEqual((await request('POST', `/decks/${id}/revisions/${baseline.id}/restore`, {})).status, 400);
    assert.deepStrictEqual(await history(), beforeFailure, 'invalid restoration rolls back history and composition');
    assert.strictEqual((await request('GET', `/decks/${id}`)).body.commander_card_id, 'new');
    const backup = (await request('GET', '/export?format=backup')).body;
    assert.ok(backup.card_cache.some(card => card.id === 'old'), 'backup includes printings present only in history');
    assert.strictEqual(backup.deck_revisions.length, 5);
    assert.strictEqual((await request('POST', '/import', { format: 'backup', data: backup }, 2)).status, 200);
    const copied = await db.get('SELECT id FROM decks WHERE user_id = 2');
    const copiedHistory = (await request('GET', `/decks/${copied.id}/revisions`, undefined, 2)).body.revisions;
    assert.strictEqual(copiedHistory.length, backup.deck_revisions.length);
    const copiedBaseline = copiedHistory.find(row => row.kind === 'baseline');
    assert.ok(copiedBaseline.snapshot.cards.find(card => card.card_id === 'old').source_entry_id < 0, 'stale historical anchors remain stale after backup remapping');
    assert.strictEqual((await request('POST', `/decks/${copied.id}/revisions/${baseline.id}/restore`, {}, 2)).status, 404, 'revision IDs cannot cross decks');
    assert.strictEqual((await request('DELETE', `/decks/${copied.id}`, undefined, 2)).status, 200);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_revisions WHERE deck_id = ?', [copied.id]), []);
    console.log('Deck history assertions passed: baseline, deduplication, persistence, restore, reservations, ownership, stale sources and backup.');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
