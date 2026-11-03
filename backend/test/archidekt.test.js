const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDb = path.join(os.tmpdir(), `manafolio-archidekt-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const api = require('../src/archidektApi');
const scryfall = require('../src/scryfallApi');
const router = require('../src/routes/decks');
const handler = path => router.stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack.at(-1).handle;
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const url = 'https://archidekt.com/decks/24321624/spellslinger';
const uuid = '11111111-1111-1111-1111-111111111111';
const row = (categories, quantity, extra = {}) => ({ categories, quantity, card: { uid: uuid, oracleCard: { types: ['Creature'], layout: 'normal' } }, ...extra });

async function test() {
  const originalGet = api.client.get;
  const originalBulk = scryfall.bulkFetchByIdentifier;
  const originalCache = scryfall.cacheCards;
  let requests = 0;
  const payload = { name: 'Remote deck', description: 'Description', categories: [
    { name: 'Commander', includedInDeck: true }, { name: 'Main', includedInDeck: true },
    { name: 'Maybeboard', includedInDeck: false }, { name: 'Tokens', includedInDeck: true },
  ], cards: [row(['Commander'], 1), row(['Main'], 3), row(['Maybeboard'], 8), row(['Main'], 4, { deletedAt: '2026-01-01' }), row(['Tokens'], 6, { card: { oracleCard: { types: ['Token'], layout: 'token' } } })] };
  try {
    await db.initDb();
    assert.strictEqual(api.client.defaults.maxRedirects, 0);
    assert.ok(api.client.defaults.timeout > 0);
    assert.ok(api.client.defaults.maxContentLength > 0);
    assert.strictEqual(api.client.defaults.baseURL, 'https://archidekt.com');
    api.client.get = async request => { requests++; assert.strictEqual(request, '/api/decks/24321624/'); return { data: payload }; };
    for (const bad of [null, 1, '', 'http://archidekt.com/decks/1', 'https://evil.test/decks/1', 'https://archidekt.com.evil.test/decks/1', 'https://user:secret@archidekt.com/decks/1', 'https://archidekt.com:444/decks/1', 'https://archidekt.com/api/decks/1/', 'https://archidekt.com/decks/0', 'https://archidekt.com/decks/1?next=evil', 'https://archidekt.com/decks/1#x', 'https://archidekt.com/x/../decks/1', 'https://archidekt.com/decks/1/../../decks/2']) {
      await assert.rejects(api.getDeck(bad), error => error.status === 400);
    }
    assert.strictEqual(requests, 0);
    const preview = response();
    await handler('/archidekt/preview')({ body: { url } }, preview);
    assert.deepStrictEqual(preview.body, { name: 'Remote deck', description: 'Description', card_count: 4, commander: true });
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM decks')).count, 0);
    scryfall.bulkFetchByIdentifier = async rows => {
      assert.deepStrictEqual(rows, [{ id: uuid, quantity: 1, isCommander: true }, { id: uuid, quantity: 3, isCommander: false }]);
      const card = { id: `mtg-${uuid}`, name: 'Exact printing' };
      return { cards: [card], pairs: rows.map(row => ({ row, card })) };
    };
    scryfall.cacheCards = async cards => { for (const card of cards) await db.run('INSERT OR IGNORE INTO card_cache (id, name, game) VALUES (?, ?, ?)', [card.id, card.name, 'mtg']); };
    const created = response();
    await handler('/')({ body: { name: 'My deck', description: 'Edited', archidekt_url: url }, user: { id: 1 } }, created);
    assert.strictEqual(created.statusCode, 201, JSON.stringify(created.body));
    assert.deepStrictEqual(await db.get('SELECT name, description, format, commander_card_id FROM decks WHERE id = ?', [created.body.id]), { name: 'My deck', description: 'Edited', format: 'Commander / EDH', commander_card_id: `mtg-${uuid}` });
    assert.deepStrictEqual(await db.all('SELECT card_id, quantity FROM deck_cards WHERE deck_id = ?', [created.body.id]), [{ card_id: `mtg-${uuid}`, quantity: 4 }]);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, 0);
    for (const conflict of [{ precon_file: 'other' }, { decklist_text: '1 Card' }, { commander_card_id: 'other' }]) {
      const result = response();
      await handler('/')({ body: { name: 'Conflict', archidekt_url: url, ...conflict }, user: { id: 1 } }, result);
      assert.strictEqual(result.statusCode, 400);
    }
    scryfall.bulkFetchByIdentifier = async () => ({ cards: [], pairs: [] });
    const failed = response();
    await handler('/')({ body: { name: 'Incomplete', archidekt_url: url }, user: { id: 1 } }, failed);
    assert.strictEqual(failed.statusCode, 422);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM decks')).count, 1);
    payload.cards = [row(['Main'], 0)];
    await assert.rejects(api.getDeck(url), error => error.status === 502);
    for (const status of [302, 403, 404, 429, 500]) {
      api.client.get = async () => { throw Object.assign(new Error('private upstream details'), { response: { status } }); };
      await assert.rejects(api.getDeck(url), error => error.status === ([403, 404].includes(status) ? 422 : 502) && !error.message.includes('private upstream details'));
    }
  } finally {
    api.client.get = originalGet;
    scryfall.bulkFetchByIdentifier = originalBulk;
    scryfall.cacheCards = originalCache;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ } }
  }
}

test().then(() => console.log('Archidekt import self-check passed')).catch(error => { console.error(error); process.exitCode = 1; });
