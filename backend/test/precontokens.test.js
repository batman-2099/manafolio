const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-precon-tokens-'));
process.env.DB_PATH = path.join(dir, 'collection.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'sample-only-password';
const db = require('../src/db');
const mtgjson = require('../src/mtgjsonApi');
const scryfall = require('../src/scryfallApi');
const { authenticateToken } = require('../src/middleware/auth');
const tokens = require('./fixtures/multiverseTokens.json');
const native = tokens.find(card => card.layout === 'double_faced_token');
const plain = { id: '11111111-1111-4111-8111-111111111111', name: 'Plains', set: 'tst', set_name: 'Sample set', collector_number: '1', type_line: 'Basic Land — Plains', lang: 'en' };
const rawCards = [plain, ...tokens];

async function run() {
  let server;
  const originalGet = mtgjson.client.get;
  const originalPost = scryfall.client.post;
  const originalCardGet = scryfall.client.get;
  const originalTransaction = db.withTransaction;
  let inTransaction = false;
  let deckTokens = [];
  const selectedBack = { ...tokens.find(card => card.name === 'Treasure'), id: '22222222-2222-4222-8222-222222222222' };
  const selectedBackId = `mtg-${selectedBack.id}`;
  let omitted = null;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'restore', 'unused', 'restore')");
    for (const id of [1, 2]) await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 hour'))", [`precon-${id}`, id]);
    mtgjson.resetDeckListCache();
    mtgjson.client.get = async url => ({ data: { data: url === '/DeckList.json'
      ? [{ name: 'Multiverse Reforged', fileName: 'MultiverseReforged_FRC', code: 'FRC', type: 'Commander Deck' }]
      : { name: 'Multiverse Reforged', mainBoard: [{ name: 'Plains', count: 100, setCode: 'tst', number: '1' }], tokens: deckTokens } } });
    scryfall.client.post = async (url, body) => {
      assert.strictEqual(url, '/cards/collection');
      return { data: { data: rawCards.filter(card => card.id !== omitted && body.identifiers.some(id => id.id === card.id
        || (id.set === card.set && id.collector_number === card.collector_number))), not_found: [] } };
    };
    db.withTransaction = async fn => originalTransaction(async () => {
      inTransaction = true;
      try { return await fn(); } finally { inTransaction = false; }
    });
    scryfall.client.get = async url => {
      assert.strictEqual(inTransaction, false, 'reverse resolution happens before the write transaction');
      if (url === `/cards/${selectedBack.id}`) return { data: selectedBack };
      throw Object.assign(new Error('Missing fixture card'), { response: { status: 404 } });
    };
    const app = express();
    app.use(express.json());
    app.use('/api', authenticateToken);
    app.use('/api', require('../src/routes/collection'));
    app.use('/api', require('../src/routes/importExport'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const request = async (url, method = 'GET', body, status = 200, user = 1) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
        method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer precon-${user}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json();
      assert.strictEqual(res.status, status, JSON.stringify(data));
      return data;
    };
    const endpoint = '/mtg-decks/MultiverseReforged_FRC';
    const listed = await request('/mtg-decks?q=Multiverse');
    assert.deepStrictEqual(listed[0].token_editions.map(edition => edition.id), ['white-angel']);
    assert.deepStrictEqual((await request(endpoint)).tokens, [], 'an edition is never selected implicitly');
    const preview = await request(endpoint + '?token_edition=white-angel');
    assert.strictEqual(preview.tokens.reduce((sum, token) => sum + token.count, 0), 10);
    const reviewedEdition = await request(endpoint + '/tokens?token_edition=white-angel');
    assert.strictEqual(reviewedEdition.cards.length, 10);
    assert.strictEqual(reviewedEdition.cards.filter(card => card.reverse_card_id).length, 9);
    assert.strictEqual(reviewedEdition.cards.find(card => card.id === `mtg-${native.id}`).image_url_back, native.card_faces[1].image_uris.normal);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, 0, 'review only caches catalog metadata');
    await request(endpoint + '/tokens?token_edition=unknown', 'GET', undefined, 400);
    await request('/mtg-decks/Unknown/tokens', 'GET', undefined, 404);
    const options = { token_edition: 'white-angel', create_deck: true, create_container: true };
    const result = await request(endpoint + '/import', 'POST', options);
    assert.strictEqual(result.added, 110);
    const collection = await request('/collection');
    const imported = collection.filter(card => card.set_id === 'tfrc');
    assert.strictEqual(imported.reduce((sum, card) => sum + card.quantity, 0), 10, 'ten physical tokens, not twenty independent faces');
    assert.ok(imported.every(card => card.location_id === result.location_id));
    assert.deepStrictEqual(Object.fromEntries(imported.map(card => [card.name, card.reverse_name])), {
      Angel: 'Treasure', Spirit: 'Jace', Incubator: null,
      'Kobolds of Kher Keep': 'Phyrexian Mite', Soldier: 'Map', Warrior: 'Shark',
      'Zombie Army': 'Goblin', Insect: 'Rogue', 'Gingerbrute Token': 'Myr', 'The Monarch': 'Citizen',
    }, 'all published reverse pairs are preserved, including cross-set Spirit/Jace and Angel/Treasure');
    assert.deepStrictEqual(imported.filter(card => card.reverse_set_id === 'tfra').map(card => card.name).sort(), ['Angel', 'Spirit']);
    const incubator = imported.find(card => card.name === 'Incubator');
    assert.strictEqual(incubator.image_url_back, native.card_faces[1].image_uris.normal);
    assert.strictEqual(incubator.name_back, 'Phyrexian');
    assert.strictEqual((await db.get('SELECT target_size FROM decks WHERE id = ?', [result.deck_id])).target_size, 100);
    assert.strictEqual((await db.get('SELECT SUM(quantity) AS copies FROM deck_cards WHERE deck_id = ?', [result.deck_id])).copies, 100);
    assert.strictEqual((await db.get('SELECT SUM(quantity) AS copies FROM deck_card_allocations WHERE deck_id = ?', [result.deck_id])).copies, 100);
    const snapshot = () => db.get('SELECT (SELECT COUNT(*) FROM collection) AS copies, (SELECT COUNT(*) FROM decks) AS decks, (SELECT COUNT(*) FROM locations) AS locations');
    const before = await snapshot();
    for (const token_edition of ['unknown', null, false, ['white-angel']]) {
      await request(endpoint + '/import', 'POST', { token_edition }, 400);
    }
    await request(endpoint + '?token_edition=unknown', 'GET', undefined, 400);
    const verifiedFront = reviewedEdition.cards.find(card => card.reverse_card_id);
    await request(endpoint + '/import', 'POST', {
      token_edition: 'white-angel', reverse_card_ids: { [verifiedFront.id]: null },
    }, 400);
    await request(endpoint + '/import', 'POST', {
      token_edition: 'white-angel', reverse_card_ids: { [`mtg-${native.id}`]: selectedBackId },
    }, 400);
    assert.deepStrictEqual(await snapshot(), before, 'review choices cannot override verified or native backs');
    omitted = tokens.find(card => card.name === 'Map').id;
    await request(endpoint + '/import', 'POST', { token_edition: 'white-angel' }, 422);
    assert.deepStrictEqual(await snapshot(), before, 'unresolved reverse art identity must not cause a partial import');
    omitted = null;
    await db.run(`CREATE TRIGGER fail_token BEFORE INSERT ON collection WHEN NEW.card_id = 'mtg-${native.id}' BEGIN SELECT RAISE(ABORT, 'token failure'); END`);
    await request(endpoint + '/import', 'POST', { token_edition: 'white-angel' }, 502);
    assert.deepStrictEqual(await snapshot(), before, 'verified contents roll back even without Create Deck');
    await db.run('DROP TRIGGER fail_token');
    const backup = await request('/export?format=backup');
    // A fresh cache identity exercises restore insertion rather than reusing the source cache row.
    const restoredId = 'mtg-99999999-9999-4999-8999-999999999999';
    backup.card_cache.find(card => card.id === incubator.card_id).id = restoredId;
    for (const card of backup.collection) if (card.card_id === incubator.card_id) card.card_id = restoredId;
    await request('/import', 'POST', { format: 'backup', data: backup }, 200, 2);
    const restored = (await request('/collection', 'GET', undefined, 200, 2)).find(card => card.card_id === restoredId);
    assert.deepStrictEqual([restored.image_url_back, restored.name_back], [incubator.image_url_back, 'Phyrexian']);
    const angel = tokens.find(card => card.name === 'Angel');
    const frontId = `mtg-${angel.id}`;
    const tokenRow = card => ({ name: card.name, count: 1, identifiers: { scryfallId: card.id } });
    deckTokens = [tokenRow(angel), { ...tokenRow(angel), count: 2, isFoil: true }, tokenRow(native)];
    const beforeReview = await snapshot();
    const review = await request(endpoint + '/tokens');
    assert.deepStrictEqual(review.cards.map(card => card.id).sort(), [frontId, `mtg-${native.id}`].sort(), 'duplicate fronts are reviewed once across printings');
    assert.strictEqual(review.cards.find(card => card.id === frontId).reverse_card_id, null);
    assert.strictEqual(review.cards.find(card => card.id === `mtg-${native.id}`).image_url_back, native.card_faces[1].image_uris.normal);
    assert.deepStrictEqual(await snapshot(), beforeReview);
    omitted = angel.id;
    await request(endpoint + '/tokens', 'GET', undefined, 422);
    assert.deepStrictEqual(await snapshot(), beforeReview, 'unresolved token fronts do not write inventory');
    omitted = null;

    for (const reverse_card_ids of [null, [], '', false, 1]) {
      await request(endpoint + '/import', 'POST', { reverse_card_ids, create_container: true }, 400);
    }
    for (const reverse_card_ids of [
      { [frontId]: '' }, { [frontId]: ' ' }, { [frontId]: false }, { [frontId]: 1 },
      { [frontId]: [] }, { [frontId]: {} }, { [frontId]: frontId },
      { [frontId]: `mtg-${plain.id}` }, { 'mtg-foreign-front': null },
      { [`mtg-${plain.id}`]: selectedBackId }, { [`mtg-${native.id}`]: null },
      { [frontId]: selectedBackId, 'mtg-foreign-front': null },
    ]) {
      await request(endpoint + '/import', 'POST', { reverse_card_ids, create_deck: true, create_container: true }, 400);
    }
    deckTokens.push(tokenRow(plain));
    await request(endpoint + '/import', 'POST', { reverse_card_ids: { [`mtg-${plain.id}`]: null } }, 400);
    deckTokens.pop();
    await request(endpoint + '/import', 'POST', {
      reverse_card_ids: { [frontId]: 'mtg-33333333-3333-4333-8333-333333333333' }, create_deck: true, create_container: true,
    }, 422);
    omitted = plain.id;
    await request(endpoint + '/import', 'POST', { reverse_card_ids: { [frontId]: null } }, 422);
    omitted = null;
    assert.deepStrictEqual(await snapshot(), beforeReview, 'invalid or unresolved review choices leave all owned state unchanged');
    const validTokens = deckTokens;
    deckTokens = [{ ...tokenRow(angel), count: Number.MAX_SAFE_INTEGER }, tokenRow(angel), tokenRow(native)];
    await request(endpoint + '/import', 'POST', { reverse_card_ids: {} }, 400);
    assert.deepStrictEqual(await snapshot(), beforeReview, 'even an empty review mapping rolls back earlier inserts when a token quantity is invalid');
    deckTokens = validTokens;

    const lastEntry = (await db.get('SELECT MAX(id) AS id FROM collection')).id;
    const otherUserBefore = await db.all('SELECT * FROM collection WHERE user_id = 2');
    await db.run('DELETE FROM card_cache WHERE id = ?', [selectedBackId]);
    const paired = await request(endpoint + '/import', 'POST', { reverse_card_ids: { [frontId]: selectedBackId } });
    assert.strictEqual(paired.added, 104);
    const pairedTokens = await db.all('SELECT * FROM collection WHERE id > ? AND card_id = ? AND user_id = 1', [lastEntry, frontId]);
    assert.strictEqual(pairedTokens.reduce((sum, card) => sum + card.quantity, 0), 3);
    assert.ok(pairedTokens.every(card => card.reverse_card_id === selectedBackId), 'one review choice applies to every unpaired printing');
    assert.ok(await db.get('SELECT id FROM card_cache WHERE id = ?', [selectedBackId]), 'selected reverse is resolved and cached');
    assert.deepStrictEqual(await db.all('SELECT * FROM collection WHERE user_id = 2'), otherUserBefore, 'another account is unchanged');

    const lastPairedEntry = (await db.get('SELECT MAX(id) AS id FROM collection')).id;
    await request(endpoint + '/import', 'POST', { reverse_card_ids: { [frontId]: null } });
    const skippedTokens = await db.all('SELECT * FROM collection WHERE id > ? AND card_id = ?', [lastPairedEntry, frontId]);
    assert.strictEqual(skippedTokens.reduce((sum, card) => sum + card.quantity, 0), 3);
    assert.ok(skippedTokens.every(card => card.reverse_card_id === null), 'explicit skip does not reuse an owned copy pairing');
    const importedNative = (await request('/collection')).filter(card => card.card_id === `mtg-${native.id}`);
    assert.ok(importedNative.every(card => card.reverse_card_id === null && card.image_url_back === native.card_faces[1].image_uris.normal));
    console.log('Verified and reviewed precon tokens, reverse validation, atomicity, account scope and backup checks passed');
  } finally {
    mtgjson.client.get = originalGet;
    mtgjson.resetDeckListCache();
    scryfall.client.post = originalPost;
    scryfall.client.get = originalCardGet;
    db.withTransaction = originalTransaction;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
