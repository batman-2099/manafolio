const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-tokenpairing-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const { authenticateToken } = require('../src/middleware/auth');
const cardId = n => `mtg-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function testTokenPairing() {
  let server;
  const originalRelated = scryfall.getRelatedTokens;
  const originalGet = scryfall.client.get;
  const originalPost = scryfall.client.post;
  try {
    await db.initDb();
    await db.run(`INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')`);
    await db.run(`UPDATE users SET share_enabled = 1, share_locations = 1, share_token = 'token-pair-share' WHERE id = 1`);
    for (const id of [1, 2]) await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 hour'))`, [`pair-${id}`, id]);
    const names = ['Goblin', 'Soldier', 'Spirit', 'Ordinary Creature'];
    const rawCards = names.map((name, i) => ({
      id: cardId(i + 1).slice(4), name, lang: 'en', set: i === 0 ? 'pair' : 'other', set_name: 'Pair fixtures',
      collector_number: String(i + 1), type_line: i < 3 ? `Token Creature — ${name}` : 'Creature — Wizard',
      colors: [], color_identity: [], rarity: 'common', image_uris: { normal: `https://example.invalid/${i}.jpg` }, prices: {},
    }));
    await scryfall.cacheCards(rawCards.map(card => scryfall.normalizeCard(card)));
    scryfall.client.get = async () => { throw new Error('Unexpected provider GET in paired-token fixture'); };
    scryfall.client.post = async (url, body) => {
      assert.strictEqual(url, '/cards/collection');
      const cards = body.identifiers.map(identifier => rawCards.find(card => card.id === identifier.id));
      assert.ok(cards.every(Boolean), 'CSV resolves only the explicit fixture printing IDs');
      return { data: { data: cards, not_found: [] } };
    };
    const location = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Token binder', 'Binder', 1)`)).lastID;
    await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)`, [location]);
    scryfall.getRelatedTokens = async () => [{ id: cardId(2), name: 'Soldier', image_url: null, source_cards: [] }];
    const app = express();
    app.use(express.json());
    app.use('/api/shared', require('../src/routes/shared'));
    app.use('/api', authenticateToken);
    app.use('/api', require('../src/routes/collection'));
    app.use('/api', require('../src/routes/importExport'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function request(url, method = 'GET', body, status = 200, user = 1) {
      const response = await fetch(base + url, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer pair-${user}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
      assert.strictEqual(response.status, status, JSON.stringify(data));
      return data;
    }
    const pair = { card_id: cardId(1), reverse_card_id: cardId(2), quantity: 2, stackable: true, location_id: location };
    const added = await request('/collection', 'POST', pair);
    const entryUrl = `/collection/${added.id}`;
    let rows = await request('/collection');
    assert.strictEqual(rows.length, 1, 'two faces share one physical entry');
    assert.deepStrictEqual([rows[0].quantity, rows[0].reverse_card_id, rows[0].reverse_name], [2, cardId(2), 'Soldier']);
    assert.strictEqual(rows[0].reverse_image_url, 'https://example.invalid/1.jpg');
    assert.strictEqual((await request(`/collection?card_id=${cardId(2)}`))[0].entry_id, added.id);
    assert.ok((await request('/search?scope=collection&name=Soldier')).some(card => card.id === cardId(2)));
    const snapshot = await request('/collection/offline-snapshot');
    assert.strictEqual(snapshot.cards[0].reverse_name, 'Soldier');
    const related = (await request('/cards/related-tokens', 'POST', { card_ids: [cardId(4)] })).tokens[0];
    assert.strictEqual(related.matched_card_id, cardId(2));
    assert.strictEqual(related.source_entry_id, added.id);
    assert.strictEqual(related.owned_qty, 2);
    assert.strictEqual(related.owned_entries[0].entry_id, added.id);
    assert.strictEqual(related.owned_entries[0].location_name, 'Token binder');
    await request(entryUrl, 'PUT', { reverse_card_id: cardId(3) });
    assert.strictEqual((await request('/collection'))[0].reverse_card_id, cardId(3), 'editing accepts a reverse from another set');
    await request(entryUrl, 'PUT', { reverse_card_id: cardId(2) });
    for (const fields of [
      { reverse_card_id: cardId(1) }, { reverse_card_id: cardId(4) }, { reverse_card_id: cardId(9) },
      { reverse_card_id: '' }, { reverse_card_id: {} }, { list_type: 'arena' }, { card_id: cardId(4) },
    ]) await request('/collection', 'POST', { ...pair, ...fields }, 400);
    await request(entryUrl, 'PUT', { notes: 'Private pairing note', purchase_price: 42 });
    assert.strictEqual((await request('/collection'))[0].reverse_card_id, cardId(2), 'omitted reverse preserves pairing');
    await request(entryUrl, 'PUT', { reverse_card_id: null });
    assert.strictEqual((await request('/collection'))[0].reverse_card_id, null);
    await request(entryUrl, 'PUT', { reverse_card_id: cardId(2) });
    await request(entryUrl, 'PUT', { list_type: 'arena' }, 400);
    await request('/collection/bulk', 'POST', { action: 'list_type', value: 'arena', entry_ids: [added.id] }, 400);
    await request(entryUrl, 'PUT', { list_type: 'wishlist' });
    assert.strictEqual((await request('/collection?list_type=wishlist'))[0].reverse_card_id, cardId(2));
    await request(entryUrl, 'PUT', { list_type: 'graveyard' });
    assert.strictEqual((await request('/collection?list_type=graveyard'))[0].reverse_card_id, cardId(2));
    await request(entryUrl, 'PUT', { list_type: 'collection', location_id: location });
    await request(entryUrl, 'PUT', { reverse_card_id: cardId(3) }, 404, 2);
    const shared = await request('/shared/token-pair-share');
    assert.strictEqual(shared.collection[0].reverse_card_id, cardId(2));
    assert.strictEqual(shared.stats.summary.totalCards, 2);
    const sharedContainer = await request(`/shared/token-pair-share/containers/${location}`);
    assert.ok(JSON.stringify(sharedContainer).includes('Soldier'));
    for (const data of [shared, sharedContainer]) {
      assert.ok(!JSON.stringify(data).includes('Private pairing note'));
      assert.ok(!JSON.stringify(data).includes('purchase_price'));
    }
    const draft = await request('/scan-drafts', 'POST', { card_id: cardId(1), reverse_card_id: cardId(3), quantity: 1 });
    assert.strictEqual(draft.reverse_name, 'Spirit');
    assert.strictEqual((await request(`/scan-drafts/${draft.draft_id}`, 'PATCH', { quantity: 2 })).reverse_card_id, cardId(3));
    await request(`/scan-drafts/${draft.draft_id}`, 'PATCH', { card_id: cardId(4) }, 400);
    await request(`/scan-drafts/${draft.draft_id}`, 'PATCH', { reverse_card_id: null });
    await request(`/scan-drafts/${draft.draft_id}`, 'PATCH', { reverse_card_id: cardId(3) });
    await request('/scan-drafts/commit', 'POST', { draft_ids: [draft.draft_id] });
    rows = await request('/collection');
    assert.strictEqual(rows.reduce((sum, row) => sum + row.quantity, 0), 4);
    assert.strictEqual(rows.filter(row => row.reverse_card_id === cardId(3)).reduce((sum, row) => sum + row.quantity, 0), 2);
    const deck = (await db.run(`INSERT INTO decks (name, user_id, checked_out) VALUES ('Reverse source', 1, 1)`)).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, ?, 1, ?)`, [deck, cardId(2), added.id]);
    await db.run(`INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, 1)`, [deck, cardId(2), added.id]);
    await request(entryUrl, 'PUT', { reverse_card_id: cardId(3) }, 409);
    const backup = await request('/export?format=backup');
    assert.ok(backup.card_cache.some(card => card.id === cardId(2)));
    const invalid = structuredClone(backup);
    invalid.collection[0].reverse_card_id = cardId(4);
    await request('/import', 'POST', { format: 'backup', data: invalid }, 400, 2);
    await request('/import', 'POST', { format: 'backup', data: backup }, 200, 2);
    const restored = await request('/collection', 'GET', undefined, 200, 2);
    const restoredPair = restored.find(row => row.reverse_card_id === cardId(2));
    assert.strictEqual(restoredPair.quantity, 2);
    assert.strictEqual(restoredPair.checked_out_qty, 1);
    const csv = await request('/export?format=csv');
    assert.ok(csv.includes('Reverse Card ID'));
    const before = (await db.get('SELECT SUM(quantity) AS qty FROM collection WHERE user_id = 2')).qty;
    await request('/import', 'POST', { format: 'internal', data: csv }, 200, 2);
    assert.strictEqual((await db.get('SELECT SUM(quantity) AS qty FROM collection WHERE user_id = 2')).qty, before + 4);
    assert.strictEqual((await db.get('SELECT SUM(quantity) AS qty FROM collection WHERE user_id = 2 AND reverse_card_id = ?', [cardId(2)])).qty, 4);
    const exported = await request('/export?format=json');
    assert.ok(exported.every(row => row.reverse_card_id));
    await request('/import', 'POST', { format: 'json', data: exported, list_type: 'arena' }, 400, 2);

    const beforeBulk = (await db.get('SELECT COUNT(*) AS count FROM collection')).count;
    for (const reverse_card_ids of [null, [], 'invalid', { unknown: cardId(2) }, { [cardId(1)]: 2 }, { [cardId(1)]: '' }]) {
      await request('/collection/bulk-add', 'POST', { card_ids: [cardId(1)], reverse_card_ids }, 400);
    }
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, beforeBulk, 'invalid maps fail before any writes');
    const bulkStart = (await db.get('SELECT MAX(id) AS id FROM collection')).id;
    const bulk = await request('/collection/bulk-add', 'POST', {
      card_ids: [cardId(1), cardId(2), cardId(4)], quantity: 2, stackable: true,
      reverse_card_id: cardId(3),
      reverse_card_ids: { [cardId(1)]: cardId(2), [cardId(4)]: null },
    });
    assert.deepStrictEqual([bulk.added, bulk.failed], [3, []]);
    const bulkRows = await db.all('SELECT card_id, reverse_card_id, quantity FROM collection WHERE id > ? ORDER BY id', [bulkStart]);
    assert.deepStrictEqual(bulkRows, [
      { card_id: cardId(1), reverse_card_id: cardId(2), quantity: 2 },
      { card_id: cardId(2), reverse_card_id: cardId(3), quantity: 2 },
      { card_id: cardId(4), reverse_card_id: null, quantity: 2 },
    ], 'per-card pairs and explicit null override the legacy shared reverse; missing keys retain it');
    const mixed = await request('/collection/bulk-add', 'POST', {
      card_ids: [cardId(1), cardId(2)],
      reverse_card_ids: { [cardId(1)]: cardId(2), [cardId(2)]: cardId(4) },
    });
    assert.strictEqual(mixed.added, 1);
    assert.deepStrictEqual(mixed.failed.map(failure => failure.card_id), [cardId(2)], 'bulk rejects non-token reverses and retains partial failures');
    const retry = await request('/collection/bulk-add', 'POST', {
      card_ids: mixed.failed.map(failure => failure.card_id), reverse_card_ids: { [cardId(2)]: cardId(1) },
    });
    assert.deepStrictEqual([retry.added, retry.failed], [1, []]);
    await db.run('UPDATE card_cache SET subtypes = ?, set_name = ? WHERE id IN (?, ?)',
      ['[]', 'Sample tOkEnS', cardId(1), cardId(2)]);
    const setPair = await request('/collection', 'POST', { card_id: cardId(1), reverse_card_id: cardId(2), quantity: 1 });
    assert.strictEqual((await db.get('SELECT reverse_card_id FROM collection WHERE id = ?', [setPair.id])).reverse_card_id, cardId(2),
      'token-set cards can pair without token type metadata');
    await request('/collection', 'POST', { card_id: cardId(1), reverse_card_id: cardId(2), list_type: 'arena' }, 400);
  } finally {
    scryfall.getRelatedTokens = originalRelated;
    scryfall.client.get = originalGet;
    scryfall.client.post = originalPost;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testTokenPairing().then(() => console.log('Paired token HTTP/SQLite regression checks passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
