const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-scandrafts-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const { authenticateToken } = require('../src/middleware/auth');

async function testScanDrafts() {
  let server;
  const originalGet = scryfall.client.get;
  try {
    await db.initDb();
    await db.run(`INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')`);
    for (const id of [1, 2]) {
      await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 hour'))`, [`scan-session-${id}`, id]);
    }
    const location = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Review destination', 'Box', 1)`)).lastID;
    const compartment = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 20)`, [location])).lastID;
    const foreignLocation = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Private destination', 'Box', 2)`)).lastID;
    const archivedLocation = (await db.run(`INSERT INTO locations (name, type, user_id, inventory_type) VALUES ('Archived destination', 'Box', 1, 'graveyard')`)).lastID;
    const providerCalls = [];
    scryfall.client.get = async url => {
      providerCalls.push(url);
      if (!['/cards/scan-source', '/cards/scan-other', '/cards/tst/2/ja'].includes(url)) {
        throw Object.assign(new Error('Not found'), { response: { status: 404 } });
      }
      const japanese = url.endsWith('/ja');
      const source = url === '/cards/scan-source';
      return { data: {
        id: japanese ? 'scan-japanese' : source ? 'scan-source' : 'scan-other',
        name: source ? 'Scan Source' : 'Scan Other', printed_name: japanese ? '別のカード' : undefined,
        lang: japanese ? 'ja' : 'en', set: 'tst', set_name: 'Test Set', collector_number: source ? '1' : '2',
        type_line: 'Creature — Wizard', colors: ['U'], color_identity: ['U'], rarity: 'common',
        image_uris: { normal: `https://example.invalid/${japanese ? 'ja' : 'en'}.jpg` },
        prices: { usd: '4.00', usd_foil: '9.00' }
      } };
    };

    const app = express();
    app.use(express.json());
    app.use('/api', authenticateToken);
    app.use('/api', require('../src/routes/collection'));
    app.use('/api', require('../src/routes/storage'));
    app.use('/api', require('../src/routes/stats'));
    app.use('/api/decks', require('../src/routes/decks'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function response(url, method = 'GET', body, user = 1) {
      const result = await fetch(base + url, {
        method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer scan-session-${user}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: result.status, data: await result.json() };
    }
    async function request(url, method = 'GET', body, user = 1, status = 200) {
      const result = await response(url, method, body, user);
      assert.strictEqual(result.status, status, JSON.stringify(result.data));
      return result.data;
    }
    const stage = (body, user = 1, status = 200) => request('/scan-drafts', 'POST', body, user, status);
    const owned = () => db.all('SELECT * FROM collection ORDER BY id');

    await request('/scan-drafts', 'GET', undefined, null, 401);
    const draft = await stage({ card_id: 'mtg-scan-source', quantity: 2, location_id: location, user_id: 2, list_type: 'arena' });
    assert.strictEqual(draft.id, 'mtg-scan-source');
    assert.strictEqual(draft.card_id, draft.id);
    assert.ok(Number.isInteger(draft.draft_id));
    assert.strictEqual(draft.entry_id, undefined, 'a review row is not an owned entry');
    assert.deepStrictEqual(draft.types, ['Blue']);
    assert.ok(draft.subtypes.includes('Creature'));
    assert.deepStrictEqual(draft.color_identity, ['Blue']);
    assert.deepStrictEqual(await owned(), [], 'staging never creates collection rows');
    assert.deepStrictEqual(await request('/collection'), []);
    assert.strictEqual((await request('/stats')).summary.totalCards, 0);
    assert.strictEqual((await request('/locations')).find(row => row.id === location).total_cards, 0);
    assert.strictEqual((await request(`/locations/${location}/compartments`))[0].count, 0);
    assert.deepStrictEqual(await db.all('SELECT * FROM price_history'), []);
    assert.deepStrictEqual(await request('/scan-drafts'), [draft]);
    assert.deepStrictEqual(await request('/scan-drafts', 'GET', undefined, 2), []);
    await db.initDb();
    assert.deepStrictEqual(await request('/scan-drafts'), [draft], 'drafts survive database initialization');

    const draftUrl = `/scan-drafts/${draft.draft_id}`;
    for (const [method, body] of [['PATCH', { quantity: 5 }], ['DELETE', undefined]]) {
      await request(draftUrl, method, body, 2, 404);
    }
    await request('/scan-drafts/commit', 'POST', { draft_ids: [draft.draft_id] }, 2, 404);
    assert.deepStrictEqual(await request('/scan-drafts'), [draft], 'another account cannot edit, discard, or consume the draft');
    const invalidFields = [
      { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 251 }, { quantity: '2' },
      { purchase_price: -1 }, { purchase_price: 'NaN' }, { purchase_price: null },
      { condition: 'Mint' }, { printing: 'Etched' }, { language: 'unknown' },
      { location_id: foreignLocation }, { location_id: archivedLocation }, { location_id: true },
      { card_id: 'unsupported-card' }, { card_id: 'mtg-missing-card' }
    ];
    for (const fields of invalidFields) {
      await stage({ card_id: draft.card_id, ...fields }, 1, 400);
      await request(draftUrl, 'PATCH', fields, 1, 400);
    }
    assert.deepStrictEqual(await request('/scan-drafts'), [draft], 'validation failures preserve the reviewed state');
    assert.deepStrictEqual(await owned(), []);

    const edited = await request(draftUrl, 'PATCH', {
      card_id: 'mtg-scan-other', quantity: 3, condition: 'Lightly Played', printing: 'Holofoil',
      language: 'ja', purchase_price: 1.25, location_id: String(location)
    });
    assert.strictEqual(edited.card_id, 'mtg-scan-japanese');
    assert.strictEqual(edited.id, edited.card_id);
    assert.strictEqual(edited.draft_id, draft.draft_id);
    assert.strictEqual(edited.language, 'Japanese');
    assert.strictEqual(edited.printed_name, '別のカード');
    assert.strictEqual(edited.quantity, 3);
    assert.strictEqual(edited.condition, 'Lightly Played');
    assert.strictEqual(edited.printing, 'Holofoil');
    assert.strictEqual(edited.purchase_price, 1.25);
    assert.strictEqual(edited.location_id, location);
    assert.deepStrictEqual(await request(draftUrl, 'PATCH', { printing: 'Normal' }),
      { ...edited, printing: 'Normal' }, 'turning foil off preserves every other draft field');
    await request(draftUrl, 'PATCH', { printing: 'Holofoil' });
    assert.deepStrictEqual(await request('/scan-drafts'), [edited], 'turning foil back on persists without changing identity or copy details');
    assert.strictEqual((await request(draftUrl, 'PATCH', { location_id: null })).location_id, null);
    await request(draftUrl, 'PATCH', { location_id: location });
    assert.deepStrictEqual(await owned(), [], 'reviewing every field still creates no owned copies');
    const deck = (await db.run(`INSERT INTO decks (name, user_id) VALUES ('Review supply', 1)`)).lastID;
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 3)`, [deck, edited.card_id]);
    assert.strictEqual((await request(`/decks/${deck}`)).cards[0].owned_qty, 0);

    const second = await stage({ card_id: 'mtg-scan-source', quantity: 2, location_id: location });
    const unrelated = await stage({ card_id: 'mtg-scan-other' });
    const foreign = await stage({ card_id: draft.card_id }, 2);
    const batch = { draft_ids: [edited.draft_id, second.draft_id] };
    const reviewed = await request('/scan-drafts');
    const invalidBatches = [
      undefined, {}, { draft_ids: null }, { draft_ids: [] }, { draft_ids: edited.draft_id },
      { draft_ids: [String(edited.draft_id)] }, { draft_ids: [null] }, { draft_ids: [true] },
      { draft_ids: [0] }, { draft_ids: [-1] }, { draft_ids: [1.5] },
      { draft_ids: [Number.MAX_SAFE_INTEGER + 1] },
      { draft_ids: [edited.draft_id, edited.draft_id] }
    ];
    for (const body of invalidBatches) {
      await request('/scan-drafts/commit', 'POST', body, 1, 400);
    }
    await request('/scan-drafts/commit', 'POST', { draft_ids: [edited.draft_id, 999999] }, 1, 404);
    await request('/scan-drafts/commit', 'POST', { draft_ids: [edited.draft_id, foreign.draft_id] }, 1, 404);
    assert.deepStrictEqual(await request('/scan-drafts'), reviewed, 'invalid batches preserve every reviewed draft');
    assert.deepStrictEqual(await request('/scan-drafts', 'GET', undefined, 2), [foreign]);
    assert.deepStrictEqual(await owned(), []);

    // Failure on the later card rolls back earlier copies, placements, prices, and draft deletion.
    await db.run(`CREATE TRIGGER fail_scan_commit BEFORE INSERT ON collection
      WHEN NEW.user_id = 1 AND NEW.card_id = 'mtg-scan-source'
      BEGIN SELECT RAISE(ABORT, 'forced scan commit failure'); END`);
    const failed = await request('/scan-drafts/commit', 'POST', batch, 1, 500);
    assert.ok(!failed.error.includes('SQLITE') && !failed.error.includes('forced'));
    assert.deepStrictEqual(await owned(), []);
    assert.deepStrictEqual(await request('/scan-drafts'), reviewed);
    assert.deepStrictEqual(await request('/scan-drafts', 'GET', undefined, 2), [foreign]);
    assert.deepStrictEqual(await db.all('SELECT * FROM price_history'), []);
    assert.strictEqual((await request(`/locations/${location}/compartments`))[0].count, 0);
    await db.run('DROP TRIGGER fail_scan_commit');
    await db.run(`UPDATE locations SET inventory_type = 'graveyard' WHERE id = ?`, [location]);
    await request('/scan-drafts/commit', 'POST', batch, 1, 400);
    assert.deepStrictEqual(await request('/scan-drafts'), reviewed, 'a changed destination cannot consume any drafts');
    assert.deepStrictEqual(await owned(), []);
    await db.run(`UPDATE locations SET inventory_type = 'collection' WHERE id = ?`, [location]);

    const callsBeforeCommit = providerCalls.length;
    const [firstCommit, secondCommit, newer] = await Promise.all([
      response('/scan-drafts/commit', 'POST', batch),
      response('/scan-drafts/commit', 'POST', batch),
      stage({ card_id: draft.card_id })
    ]);
    const commits = [firstCommit, secondCommit];
    assert.deepStrictEqual(commits.map(r => r.status).sort(), [200, 404], 'concurrent confirmations consume a batch once');
    assert.deepStrictEqual(commits.find(r => r.status === 200).data, { added: 5, drafts: 2 });
    const copies = await owned();
    assert.strictEqual(copies.length, 5);
    assert.strictEqual(copies.filter(copy => copy.card_id === edited.card_id).length, 3);
    assert.strictEqual(copies.filter(copy => copy.card_id === second.card_id).length, 2);
    for (const copy of copies) {
      const source = copy.card_id === edited.card_id ? edited : second;
      assert.deepStrictEqual(
        [copy.card_id, copy.user_id, copy.quantity, copy.condition, copy.printing, copy.language, copy.purchase_price, copy.location_id, copy.compartment_id, copy.list_type],
        [source.card_id, 1, 1, source.condition, source.printing, source.language, source.purchase_price, location, compartment, 'collection']
      );
    }
    assert.strictEqual(providerCalls.length, callsBeforeCommit, 'commit uses the reviewed cache without provider requests');
    assert.deepStrictEqual(await request('/scan-drafts'), [newer, unrelated], 'unselected drafts and scans arriving during commit remain for review');
    assert.deepStrictEqual(await request('/scan-drafts', 'GET', undefined, 2), [foreign]);
    assert.strictEqual((await request('/stats')).summary.totalCards, 5);
    assert.strictEqual((await request(`/decks/${deck}`)).cards[0].owned_qty, 3);
    assert.strictEqual((await request(`/locations/${location}/compartments`))[0].count, 5);
    await request('/scan-drafts/commit', 'POST', batch, 1, 404);
    await request('/scan-drafts/commit', 'POST', { draft_ids: [newer.draft_id, edited.draft_id] }, 1, 404);
    assert.deepStrictEqual(await owned(), copies, 'repeated or overlapping confirmations cannot duplicate copies');
    assert.deepStrictEqual(await request('/scan-drafts'), [newer, unrelated]);
    await request(draftUrl, 'PATCH', { quantity: 1 }, 1, 404);

    const clearBatch = { draft_ids: [newer.draft_id, unrelated.draft_id] };
    await request('/scan-drafts', 'DELETE', clearBatch, null, 401);
    for (const draft_ids of [[], [0], ['1'], [newer.draft_id, newer.draft_id]]) {
      await request('/scan-drafts', 'DELETE', { draft_ids }, 1, 400);
    }
    await request('/scan-drafts', 'DELETE', { draft_ids: [newer.draft_id, foreign.draft_id] }, 1, 404);
    assert.deepStrictEqual(await request('/scan-drafts'), [newer, unrelated], 'foreign IDs cannot partially clear a batch');
    await db.run(`CREATE TRIGGER fail_scan_clear BEFORE DELETE ON scan_drafts
      WHEN OLD.id = ${unrelated.draft_id} BEGIN SELECT RAISE(ABORT, 'forced clear failure'); END`);
    await request('/scan-drafts', 'DELETE', clearBatch, 1, 500);
    assert.deepStrictEqual(await request('/scan-drafts'), [newer, unrelated], 'a later delete failure rolls back earlier deletions');
    await db.run('DROP TRIGGER fail_scan_clear');
    const arriving = await stage({ card_id: draft.card_id });
    assert.deepStrictEqual(await request('/scan-drafts', 'DELETE', clearBatch), { drafts: 2 });
    assert.deepStrictEqual(await request('/scan-drafts'), [arriving], 'newly queued drafts are outside the clear snapshot');
    assert.deepStrictEqual(await request('/scan-drafts', 'GET', undefined, 2), [foreign], 'clearing cannot remove another account’s drafts');
    assert.deepStrictEqual(await owned(), copies, 'clearing scan review never alters owned cards');
    await request(`/scan-drafts/${arriving.draft_id}`, 'DELETE');
    assert.deepStrictEqual(await request('/scan-drafts'), []);
    assert.deepStrictEqual(await owned(), copies, 'discarding scans does not change collection inventory');
    await db.run('DELETE FROM users WHERE id = 2');
    assert.deepStrictEqual(await db.all('SELECT * FROM scan_drafts'), [], 'account deletion cascades its drafts');

    // Existing non-scanner addition remains immediate.
    const direct = await request('/collection', 'POST', { card_id: draft.card_id });
    assert.strictEqual((await db.get('SELECT card_id FROM collection WHERE id = ?', [direct.id])).card_id, draft.card_id);
  } finally {
    scryfall.client.get = originalGet;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

testScanDrafts().then(() => console.log('Scan draft HTTP/SQLite regression checks passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
