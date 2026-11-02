const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { gzipSync } = require('zlib');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-treatments-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'treatment-test-password';
process.env.SCRYFALL_GAP_SCALE = '0';
const db = require('../src/db');
const api = require('../src/scryfallApi');
const bulk = require('../src/scryfallBulk');
const { parseCardRow } = require('../src/utils/priceHelpers');
const router = require('../src/routes/collection');
const getCollection = router.stack.find(layer => layer.route?.path === '/collection' && layer.route.methods.get).route.stack[0].handle;
const raw = (index, extra = {}) => ({
  object: 'card', id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  name: `Treatment ${index}`, set: 'tst', collector_number: String(index), lang: 'en',
  frame: '2015', border_color: 'black', full_art: false, prices: { usd: '1.00' }, ...extra,
});
const cardId = card => `mtg-${card.id}`;
async function collection(query = {}, userId = 1) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await getCollection({ query, user: { id: userId } }, res);
  return res;
}

async function main() {
  const originalAdapter = api.client.defaults.adapter;
  const originalBulkGet = bulk.client.get;
  const originalFetch = api.bulkFetchByIdentifier;
  const originalWarn = console.warn;
  try {
    for (const [extra, expected] of [
      [{}, ['regular']], [{ frame: '2003' }, ['regular']],
      [{ frame_effects: ['legendary'] }, ['regular']],
      [{ border_color: 'borderless' }, ['borderless']],
      [{ frame_effects: ['extendedart'] }, ['extendedart']],
      [{ frame_effects: ['showcase'] }, ['showcase']],
      [{ frame: '1993' }, ['retro']], [{ frame: '1997' }, ['retro']],
      [{ full_art: true }, ['fullart']],
      [{ border_color: 'borderless', full_art: true, frame_effects: ['showcase'] }, ['borderless', 'showcase', 'fullart']],
      [{ frame: 'future' }, null], [{ frame: 'unknown' }, null],
      [{ frame: undefined }, null], [{ border_color: undefined }, null],
      [{ border_color: 'unknown' }, null], [{ full_art: undefined }, null],
      [{ full_art: 'false' }, null], [{ frame: undefined, full_art: true }, null],
    ]) assert.deepStrictEqual(api.normalizeCard(raw(1, extra)).printing_treatments, expected, JSON.stringify(extra));
    assert.strictEqual(parseCardRow({ printing_treatments: null }).printing_treatments, null);

    await db.initDb();
    // Recreate the pre-upgrade schema in this disposable database, with an existing card.
    await db.run('ALTER TABLE card_cache DROP COLUMN printing_treatments');
    const local = raw(1, { frame_effects: ['showcase'] });
    const remote = raw(2, { full_art: true, border_color: 'borderless' });
    const unknown = raw(3, { full_art: undefined });
    const otherAccount = raw(4);
    const otherList = raw(5);
    for (const card of [local, remote, unknown, otherAccount, otherList]) {
      await db.run('INSERT INTO card_cache (id, name, game, price_trend, last_updated) VALUES (?, ?, ?, 42, ?)',
        [cardId(card), `Owned ${card.name}`, 'mtg', '2020-01-01 00:00:00']);
    }
    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('legacy-name-only', 'Treatment 1', 'mtg')");
    await db.initDb();
    const migrated = await db.get('SELECT * FROM card_cache WHERE id = ?', [cardId(local)]);
    assert.strictEqual(migrated.printing_treatments, null);
    assert.strictEqual(migrated.name, 'Owned Treatment 1');
    await db.initDb();
    assert.deepStrictEqual(await db.get('SELECT * FROM card_cache WHERE id = ?', [cardId(local)]), migrated, 'migration is idempotent');

    const cached = api.normalizeCard(raw(99));
    await api.cacheCards([cached]);
    const partial = { ...cached };
    delete partial.printing_treatments;
    await api.cacheCards([partial]);
    await api.cacheCards([{ ...partial, printing_treatments: null }]);
    assert.deepStrictEqual(parseCardRow(await db.get('SELECT * FROM card_cache WHERE id = ?', [cached.id])).printing_treatments, ['regular']);
    await api.cacheCards([{ ...cached, printing_treatments: ['retro'] }]);
    assert.deepStrictEqual(parseCardRow(await db.get('SELECT * FROM card_cache WHERE id = ?', [cached.id])).printing_treatments, ['retro']);

    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other')");
    for (const [id, userId, listType, printing] of [
      [cardId(local), 1, 'collection', 'Normal'], [cardId(local), 1, 'collection', 'Holofoil'],
      [cardId(remote), 1, 'collection', 'Normal'], [cardId(unknown), 1, 'collection', 'Normal'],
      ['legacy-name-only', 1, 'collection', 'Normal'],
      [cardId(otherAccount), 2, 'collection', 'Normal'], [cardId(otherList), 1, 'wishlist', 'Normal'],
    ]) await db.run('INSERT INTO collection (card_id, user_id, list_type, printing, quantity, notes) VALUES (?, ?, ?, ?, 2, ?)',
      [id, userId, listType, printing, 'Keep copy details']);
    const copies = await db.all('SELECT * FROM collection ORDER BY id');
    const cacheBefore = await db.all('SELECT * FROM card_cache ORDER BY id');
    let requests = 0;
    api.client.defaults.adapter = async () => { requests++; throw new Error('Unexpected network'); };
    bulk.client.get = async () => { throw new Error('Collection reads must not download bulk data'); };
    assert.strictEqual((await collection()).body.length, 5);
    assert.ok((await collection({ include_treatments: 'false' })).body.every(card => card.printing_treatments === null));
    for (const invalid of ['1', '', 'TRUE', true, ['true'], { value: 'true' }, 'true'.repeat(1000)]) {
      assert.strictEqual((await collection({ include_treatments: invalid })).statusCode, 400);
    }
    assert.strictEqual(requests, 0, 'ordinary reads and invalid flags never contact Scryfall');

    // Build a real local catalog from a tiny compressed fixture, then forbid all catalog downloads.
    const payload = gzipSync(`${JSON.stringify(local)}\n`);
    bulk.client.get = async url => url === '/bulk-data/default_cards'
      ? { data: { object: 'bulk_data', type: 'default_cards', updated_at: '2026-01-01T00:00:00Z', compressed_size: payload.length,
        jsonl_download_uri: 'https://data.scryfall.io/default-cards/treatments.jsonl.gz' } }
      : { data: Readable.from([payload]) };
    await bulk.refresh();
    bulk.client.get = async () => { throw new Error('Hydration must not download a catalog'); };
    const batches = [];
    api.bulkFetchByIdentifier = (rows, progress, options) => {
      batches.push(rows.map(row => row.id));
      assert.deepStrictEqual(options, { localFirst: true });
      return originalFetch(rows, progress, options);
    };
    api.client.defaults.adapter = async config => {
      requests++;
      assert.strictEqual(config.url, '/cards/collection');
      const ids = JSON.parse(config.data).identifiers.map(value => value.id).sort();
      assert.deepStrictEqual(ids, [remote.id, unknown.id]);
      return { status: 200, statusText: 'OK', headers: {}, config, data: { data: [remote, unknown], not_found: [] } };
    };
    const hydrated = await collection({ include_treatments: 'true' });
    assert.strictEqual(hydrated.statusCode, 200);
    assert.strictEqual(batches[0].length, 3, 'duplicate copies are resolved once; legacy IDs and other accounts/lists are excluded');
    assert.strictEqual(requests, 1, 'only missing local UUIDs use the API adapter');
    assert.deepStrictEqual(hydrated.body.filter(card => card.card_id === cardId(local)).map(card => card.printing_treatments), [['showcase'], ['showcase']]);
    assert.deepStrictEqual(hydrated.body.find(card => card.card_id === cardId(remote)).printing_treatments, ['borderless', 'fullart']);
    assert.strictEqual(hydrated.body.find(card => card.card_id === cardId(unknown)).printing_treatments, null);
    assert.strictEqual(hydrated.body.find(card => card.card_id === 'legacy-name-only').printing_treatments, null);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), copies, 'hydration never rewrites owned copies');
    const withoutTreatments = rows => rows.map(({ printing_treatments, ...row }) => row);
    assert.deepStrictEqual(withoutTreatments(await db.all('SELECT * FROM card_cache ORDER BY id')), withoutTreatments(cacheBefore),
      'hydration changes no names, artwork, prices, timestamps or other cached metadata');
    assert.strictEqual((await collection({}, 2)).body[0].printing_treatments, null);
    assert.strictEqual((await collection({ list_type: 'wishlist' })).body[0].printing_treatments, null);
    assert.strictEqual(requests, 1);

    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    api.client.defaults.adapter = async () => { requests++; throw new Error('offline fixture'); };
    const failed = await collection({ include_treatments: 'true' });
    assert.strictEqual(failed.statusCode, 200);
    assert.strictEqual(failed.body.find(card => card.card_id === cardId(unknown)).printing_treatments, null);
    assert.ok(warnings.some(message => message.includes('Collection printing treatment lookup failed: offline fixture')));
    assert.deepStrictEqual(batches.at(-1), [cardId(unknown)], 'known treatment metadata is not fetched again');
    api.client.defaults.adapter = async config => ({ status: 200, statusText: 'OK', headers: {}, config,
      data: { data: [raw(300)], not_found: [{ id: unknown.id }] } });
    assert.strictEqual((await collection({ include_treatments: 'true' })).body.find(card => card.card_id === cardId(unknown)).printing_treatments, null,
      'unmatched provider cards cannot relabel an owned identity');
    api.client.defaults.adapter = async config => ({ status: 200, statusText: 'OK', headers: {}, config,
      data: { data: [{ ...unknown, full_art: false }], not_found: [] } });
    assert.deepStrictEqual((await collection({ include_treatments: 'true' })).body.find(card => card.card_id === cardId(unknown)).printing_treatments, ['regular'],
      'unknown metadata can be retried successfully');
    api.client.defaults.adapter = async () => { throw new Error('Cached reads must remain offline'); };
    assert.deepStrictEqual((await collection()).body.find(card => card.card_id === cardId(unknown)).printing_treatments, ['regular']);
    console.log('printingtreatments.test.js: classification, migration, caching and scoped local-first hydration passed');
  } finally {
    console.warn = originalWarn;
    api.bulkFetchByIdentifier = originalFetch;
    api.client.defaults.adapter = originalAdapter;
    bulk.client.get = originalBulkGet;
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
