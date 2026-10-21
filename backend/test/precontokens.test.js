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
  let omitted = null;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'restore', 'unused', 'restore')");
    for (const id of [1, 2]) await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, DATETIME('now', '+1 hour'))", [`precon-${id}`, id]);
    mtgjson.resetDeckListCache();
    mtgjson.client.get = async url => ({ data: { data: url === '/DeckList.json'
      ? [{ name: 'Multiverse Reforged', fileName: 'MultiverseReforged_FRC', code: 'FRC', type: 'Commander Deck' }]
      : { name: 'Multiverse Reforged', mainBoard: [{ name: 'Plains', count: 100, setCode: 'tst', number: '1' }], tokens: [] } } });
    scryfall.client.post = async (url, body) => {
      assert.strictEqual(url, '/cards/collection');
      return { data: { data: rawCards.filter(card => card.id !== omitted && body.identifiers.some(id => id.id === card.id
        || (id.set === card.set && id.collector_number === card.collector_number))), not_found: [] } };
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
    console.log('Verified precon edition, cross-set pairs, native backs, rollback and backup checks passed');
  } finally {
    mtgjson.client.get = originalGet;
    mtgjson.resetDeckListCache();
    scryfall.client.post = originalPost;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
