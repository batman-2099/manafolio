const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { gzipSync } = require('zlib');
const express = require('express');

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-related-tokens-'));
  process.env.DB_PATH = path.join(dir, 'user.db');
  process.env.DEFAULT_ADMIN_PASSWORD = 'related-tokens-test';
  process.env.SCRYFALL_GAP_SCALE = '0';
  const db = require('../src/db');
  const api = require('../src/scryfallApi');
  const bulk = require('../src/scryfallBulk');
  const originalGet = api.client.get;
  const originalBulkGet = bulk.client.get;
  let server;
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const cardId = n => `mtg-${id(n)}`;
  const part = (n, component = 'token') => ({ id: id(n), component, uri: 'https://untrusted.invalid/never-follow' });
  const card = (n, fields = {}) => ({
    object: 'card', id: id(n), name: `Card ${n}`, set: 'tst', collector_number: String(n), lang: 'en', ...fields,
  });
  const cards = [
    card(1, { all_parts: [part(3), part(4), part(3), part(6, 'combo_piece'), part(6, 'meld_result'), part(6, 'meld_part')] }),
    card(2, { all_parts: [part(3)] }),
    card(3, { name: 'Soldier', type_line: 'Token Creature — Soldier', oracle_text: 'Vigilance',
      image_uris: { normal: 'https://cards.scryfall.io/soldier.jpg' }, scryfall_uri: 'https://scryfall.com/card/tst/3' }),
    card(4, { name: 'Day // Night', card_faces: [{ name: 'Day', type_line: 'Token', oracle_text: 'Daybound',
      image_uris: { normal: 'https://cards.scryfall.io/day.jpg' } }, { name: 'Night' }] }),
    card(5, { oracle_text: 'Create a token. This text alone is not a relationship.' }),
    card(7, { name: 'Soldier' }),
    card(10, { all_parts: [3, 4, 8, 9, 11, 12, 13, 14, 15].map(n => part(n)) }),
    ...[8, 9, 11, 12, 13, 15].map(n => card(n)),
    card(14, { name: 'Soldier' }),
  ];
  const expected = { tokens: [
    { id: cardId(3), name: 'Soldier', image_url: 'https://cards.scryfall.io/soldier.jpg', owned: false, locations: [], source_cards: [{ id: cardId(1), name: 'Card 1' }, { id: cardId(2), name: 'Card 2' }] },
    { id: cardId(4), name: 'Day // Night', image_url: 'https://cards.scryfall.io/day.jpg', owned: false, locations: [], source_cards: [{ id: cardId(1), name: 'Card 1' }] },
  ] };
  try {
    await db.initDb();
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('token-test', 1, '2999-01-01')`);
    await api.cacheCards([api.normalizeCard(cards[0])]);
    await db.run('INSERT INTO collection (card_id, user_id, quantity) VALUES (?, 1, 2)', [cardId(1)]);
    const deck = (await db.run(`INSERT INTO decks (name, user_id) VALUES ('Token Deck', 1)`)).lastID;
    await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 2)', [deck, cardId(1)]);
    const snapshot = async () => ({
      cache: await db.all('SELECT * FROM card_cache ORDER BY id'),
      collection: await db.all('SELECT * FROM collection ORDER BY id'),
      deck: await db.all('SELECT * FROM deck_cards ORDER BY deck_id, card_id'),
    });
    const before = await snapshot();
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/middleware/auth').authenticateToken);
    app.use('/api', require('../src/routes/collection'));
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    async function request(body, status = 200, authenticated = true) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cards/related-tokens`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer token-test' } : {}) },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      assert.strictEqual(response.status, status, JSON.stringify(data));
      return data;
    }
    const calls = [];
    api.client.get = async url => {
      calls.push(url);
      const raw = cards.find(raw => url === `/cards/${raw.id}`);
      if (!raw) throw Object.assign(new Error('Missing'), { response: { status: 404 } });
      return { data: raw };
    };
    await request({ card_ids: [cardId(1)] }, 401, false);
    for (const body of [{}, { card_ids: 'bad' }, { card_ids: [null] }, { card_ids: ['mtg-../../sets'] },
      { card_ids: [id(1)] }, { card_ids: ['unsupported-1'] }, { card_ids: Array(501).fill(cardId(1)) }]) {
      const result = await request(body, 400);
      assert.match(result.error, /card_ids/);
    }
    for (const inventory_type of ['wishlist', '', null, 1]) {
      assert.match((await request({ card_ids: [cardId(1)], inventory_type }, 400)).error, /inventory_type/);
    }
    for (const commander_card_id of [false, 0, 1, {}, [], ' ', 'mtg-../../sets', id(1), 'unsupported-1', cardId(2)]) {
      assert.match((await request({ card_ids: [cardId(1)], commander_card_id }, 400)).error, /commander_card_id/);
    }
    assert.match((await request({ card_ids: [], commander_card_id: cardId(1) }, 400)).error, /commander_card_id/);
    assert.deepStrictEqual(await request({ card_ids: [] }), { tokens: [] });
    assert.deepStrictEqual(calls, [], 'rejected and empty inputs never call the provider');
    assert.deepStrictEqual(await request({ card_ids: [cardId(1), cardId(2), cardId(1)] }), expected,
      'already cached producers still expose raw relations, dedup tokens and preserve every producer');
    assert.deepStrictEqual(calls, [1, 2, 3, 4].map(n => `/cards/${id(n)}`),
      'each UUID fetched once, excluding non-token relations and their arbitrary URIs');
    assert.deepStrictEqual(await request({ card_ids: [cardId(5)] }), { tokens: [] });
    assert.match((await request({ card_ids: [cardId(6)] }, 404)).error, /Card not found/);
    api.client.get = async () => { throw Object.assign(new Error('Offline'), { response: { status: 503 } }); };
    assert.match((await request({ card_ids: [cardId(1)] }, 502)).error, /Unable to load related tokens/);
    api.client.get = async url => ({ data: url === `/cards/${id(1)}` ? cards[0] : null });
    await request({ card_ids: [cardId(1)] }, 502);
    api.client.get = async () => ({ data: card(1, { all_parts: [{ component: 'token', id: 'https://untrusted.invalid' }] }) });
    await request({ card_ids: [cardId(1)] }, 502);

    // A real persisted bulk catalog supplies the same result entirely offline.
    const payload = gzipSync(cards.map(raw => JSON.stringify(raw)).join('\n') + '\n');
    const info = { object: 'bulk_data', type: 'default_cards', updated_at: '2026-09-22T09:00:00Z',
      jsonl_download_uri: 'https://data.scryfall.io/default-cards/tokens.jsonl.gz', compressed_size: payload.length };
    bulk.client.get = async url => {
      if (url === '/bulk-data/default_cards') return { data: info };
      assert.strictEqual(url, info.jsonl_download_uri);
      return { data: Readable.from([payload]) };
    };
    await bulk.refresh();
    api.client.get = bulk.client.get = async () => { throw new Error('Provider must not be used with local raw cards'); };
    assert.deepStrictEqual(await request({ card_ids: [cardId(1), cardId(2)] }), expected);
    assert.deepStrictEqual(await request({ card_ids: [cardId(5)] }), { tokens: [] });
    assert.deepStrictEqual(await snapshot(), before, 'token references never change cached cards, inventory or deck quantities');
    await api.cacheCards(cards.map(raw => api.normalizeCard(raw)));
    await db.run(`UPDATE card_cache SET image_url = 'https://cards.scryfall.io/owned-soldier.jpg' WHERE id = ?`, [cardId(7)]);
    await db.run(`INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-share')`);
    const binder = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Binder', 'Binder', 1)`)).lastID;
    const box = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Box', 'Box', 1)`)).lastID;
    const foreign = (await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Private Location', 'Box', 2)`)).lastID;
    const page = (await db.run(`INSERT INTO compartments (location_id, idx) VALUES (?, 2)`, [binder])).lastID;
    const row = (await db.run(`INSERT INTO compartments (location_id, idx, label) VALUES (?, 1, 'Token Row')`, [box])).lastID;
    const foreignRow = (await db.run(`INSERT INTO compartments (location_id, idx, label) VALUES (?, 1, 'Private Row')`, [foreign])).lastID;
    async function own(n, list = 'collection', quantity = 1, user = 1, location = null, compartment = null, position = 0) {
      await db.run(`INSERT INTO collection (card_id, user_id, quantity, list_type, location_id, compartment_id, position)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, [cardId(n), user, quantity, list, location, compartment, position]);
    }
    await own(3);
    await own(3, 'collection', 1, 1, null, page, 3000.001);
    await own(3, 'collection', 1, 1, box, row, 7000);
    await own(3, 'collection', 1, 2, foreign, foreignRow, 1000);
    await own(4, 'arena', 1, 1, binder, page, 1000);
    await own(8, 'wishlist');
    await own(9, 'graveyard');
    await own(7);
    await own(15, 'collection', 1, 1, foreign, foreignRow, 1000);
    for (const list of ['collection', 'arena']) {
      await own(11, list, 1, 2, foreign, foreignRow, 1000);
      await own(12, list, 0);
      await own(13, list, -1);
    }
    const inventoryBefore = await snapshot();
    const unowned = n => ({ id: cardId(n), name: cards.find(raw => raw.id === id(n)).name,
      image_url: n === 3 ? 'https://cards.scryfall.io/soldier.jpg' : n === 4 ? 'https://cards.scryfall.io/day.jpg' : null,
      source_cards: [{ id: cardId(10), name: 'Card 10' }], owned: false, locations: [] });
    const physical = [3, 4, 8, 9, 11, 12, 13, 14, 15].map(unowned);
    physical[0] = { ...physical[0], owned: true, locations: [
      { location_name: null, compartment_display: null, position: null },
      { location_name: null, compartment_display: null, position: null },
      { location_name: 'Binder', compartment_display: 'Page 2', position: 3000.001 },
      { location_name: 'Box', compartment_display: 'Token Row', position: 7000 },
    ] };
    physical[0].matched_card_id = cardId(3);
    physical[7] = { ...physical[7], owned: true, matched_card_id: cardId(3),
      image_url: 'https://cards.scryfall.io/soldier.jpg', locations: physical[0].locations };
    physical[8] = { ...physical[8], owned: true, locations: [
      { location_name: null, compartment_display: null, position: null },
    ] };
    physical[8].matched_card_id = cardId(15);
    physical[8].image_url = '';
    assert.deepStrictEqual(await request({ card_ids: [cardId(10)] }), { tokens: physical },
      'physical ownership matches names across printings while preserving user and quantity scopes');
    assert.deepStrictEqual(await request({ card_ids: [cardId(10)], inventory_type: 'collection' }), { tokens: physical });
    const arena = [3, 4, 8, 9, 11, 12, 13, 14, 15].map(unowned);
    arena[1].owned = true;
    arena[1].matched_card_id = cardId(4);
    arena[1].image_url = 'https://cards.scryfall.io/day.jpg';
    assert.deepStrictEqual(await request({ card_ids: [cardId(10)], inventory_type: 'arena' }), { tokens: arena },
      'Arena ownership is separate and has no physical storage, even on stale located rows');
    const graveyard = await request({ card_ids: [cardId(10)], inventory_type: 'graveyard' });
    assert.deepStrictEqual(graveyard.tokens.filter(token => token.owned).map(token => token.id), [cardId(9)],
      'Graveyard token ownership excludes Physical, Arena, Wishlist and other accounts');
    assert.deepStrictEqual(await snapshot(), inventoryBefore, 'ownership lookups never mutate inventory or cached cards');
    await db.run(`DELETE FROM collection WHERE user_id = 1 AND card_id = ?`, [cardId(3)]);
    const alternate = (await request({ card_ids: [cardId(1)] })).tokens[0];
    assert.strictEqual(alternate.owned, true);
    assert.strictEqual(alternate.matched_card_id, cardId(7));
    assert.strictEqual(alternate.image_url, 'https://cards.scryfall.io/owned-soldier.jpg');

    await own(3, 'collection', 1, 1, binder, page, 3000.001);
    await own(3, 'arena');
    await own(7, 'arena');
    await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = 7000
      WHERE card_id = ? AND user_id = 1 AND list_type = 'collection'`, [box, row, cardId(7)]);
    await db.run(`UPDATE card_cache SET set_id = 'CMDR' WHERE id = ?`, [cardId(1)]);
    await db.run(`UPDATE card_cache SET set_id = 'other' WHERE id = ?`, [cardId(3)]);
    await db.run(`UPDATE card_cache SET set_id = 'cmdr' WHERE id = ?`, [cardId(7)]);
    const commanderBody = { card_ids: [cardId(1)], commander_card_id: cardId(1) };
    const soldier = { ...expected.tokens[0], owned: true, source_cards: [expected.tokens[0].source_cards[0]] };
    const binderLocation = { location_name: 'Binder', compartment_display: 'Page 2', position: 3000.001 };
    const boxLocation = { location_name: 'Box', compartment_display: 'Token Row', position: 7000 };
    const preferredSoldier = { ...soldier, matched_card_id: cardId(7),
      image_url: 'https://cards.scryfall.io/owned-soldier.jpg', locations: [boxLocation] };
    const fallbackSoldier = { ...soldier, matched_card_id: cardId(3), locations: [binderLocation, boxLocation] };
    assert.deepStrictEqual((await request(commanderBody)).tokens[0], preferredSoldier,
      'same-set name match beats an exact linked printing from another set, including image and storage');
    assert.deepStrictEqual((await request({ ...commanderBody, inventory_type: 'arena' })).tokens[0],
      { ...preferredSoldier, locations: [] }, 'Arena applies the same preferred set pool without physical storage');
    for (const commander_card_id of [undefined, null, '']) {
      assert.deepStrictEqual((await request({ card_ids: [cardId(1)], commander_card_id })).tokens[0], fallbackSoldier,
        'absent or empty commander keeps exact-print preference and all matching locations');
    }
    for (const set of [null, '']) {
      await db.run('UPDATE card_cache SET set_id = ? WHERE id = ?', [set, cardId(1)]);
      assert.deepStrictEqual((await request(commanderBody)).tokens[0], fallbackSoldier,
        'missing commander set metadata keeps the existing any-set behavior');
    }
    await db.run(`UPDATE card_cache SET set_id = 'CMDR' WHERE id = ?`, [cardId(1)]);
    await db.run('DELETE FROM card_cache WHERE id = ?', [cardId(2)]);
    const uncachedCommanderBody = { card_ids: [cardId(1), cardId(2)], commander_card_id: cardId(2) };
    assert.deepStrictEqual(await request(uncachedCommanderBody),
      await request({ card_ids: uncachedCommanderBody.card_ids }),
      'an uncached commander falls back without fetching or caching extra metadata');
    assert.strictEqual(await db.get('SELECT id FROM card_cache WHERE id = ?', [cardId(2)]), undefined);

    await db.run(`UPDATE card_cache SET set_id = 'TCMDR' WHERE id = ?`, [cardId(7)]);
    assert.deepStrictEqual((await request(commanderBody)).tokens[0], preferredSoldier,
      'the conventional t-prefixed token set joins the preferred pool case-insensitively');
    await db.run(`UPDATE card_cache SET set_id = 'cmdr' WHERE id = ?`, [cardId(3)]);
    assert.deepStrictEqual((await request(commanderBody)).tokens[0], fallbackSoldier,
      'exact linked printing still wins within the combined same-set and token-set pool');
    await db.run(`UPDATE card_cache SET set_id = 'other' WHERE id IN (?, ?)`, [cardId(3), cardId(7)]);
    await db.run(`UPDATE card_cache SET set_id = 'cmdr' WHERE id = ?`, [cardId(14)]);
    await own(14, 'wishlist');
    await own(14, 'graveyard');
    for (const list of ['collection', 'arena']) {
      await own(14, list, 0);
      await own(14, list, -1);
      await own(14, list, 1, 2, foreign, foreignRow, 1000);
    }
    await own(14, 'arena');
    assert.deepStrictEqual((await request(commanderBody)).tokens[0], fallbackSoldier,
      'unowned preferred printings and excluded users, quantities, lists and Arena cannot override physical fallback');
    await db.run(`UPDATE collection SET quantity = 0 WHERE card_id = ? AND user_id = 1 AND list_type = 'arena'`, [cardId(14)]);
    await own(14);
    assert.deepStrictEqual((await request({ ...commanderBody, inventory_type: 'arena' })).tokens[0],
      { ...fallbackSoldier, locations: [] },
      'physical preferred printings and excluded users, quantities and lists cannot override Arena fallback');
    await db.run(`DELETE FROM collection WHERE card_id = ? AND user_id = 1 AND list_type = 'arena'`, [cardId(3)]);
    assert.deepStrictEqual((await request({ ...commanderBody, inventory_type: 'arena' })).tokens[0],
      { ...preferredSoldier, locations: [] }, 'any-set fallback still accepts another printing with the same name');
    console.log('relatedtokens.test.js: validation, offline relations, scoped ownership, commander-set preference, storage and reference-only checks passed');
  } finally {
    api.client.get = originalGet;
    bulk.client.get = originalBulkGet;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
