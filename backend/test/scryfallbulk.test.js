const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpDb = path.join(os.tmpdir(), `manafolio-scryfall-bulk-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.SCRYFALL_GAP_SCALE = '0';
process.env.DEFAULT_ADMIN_PASSWORD = 'scryfall-bulk-test';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const scryfallBulk = require('../src/scryfallBulk');

async function testDuplicateIdentifiers() {
  const originalPost = scryfallApi.client.post;
  const originalGet = scryfallApi.client.get;
  const originalResolveRows = scryfallBulk.resolveRows;
  await db.initDb();
  try {
    scryfallApi.client.post = async (url, body) => {
      assert.strictEqual(url, '/cards/collection');
      assert.deepStrictEqual(body.identifiers, [{ set: 'spm', collector_number: '102' }]);
      return {
        data: {
          data: [{
            id: '11111111-1111-1111-1111-111111111111', name: 'Guy in the Chair',
            set: 'spm', collector_number: '102', lang: 'en', image_uris: {}, prices: {}
          }],
          not_found: []
        }
      };
    };
    const normal = { name: 'Guy in the Chair', set_id: 'SPM', number: '102', printing: 'Normal' };
    const foil = { name: 'Guy in the Chair', set_id: 'SPM', number: '102', printing: 'Holofoil' };
    const { cards, pairs, unmatchedRows } = await scryfallApi.bulkFetchByIdentifier([normal, foil]);
    assert.strictEqual(cards.length, 1, 'one Scryfall printing is fetched once');
    assert.deepStrictEqual(pairs.map(pair => pair.row), [normal, foil], 'every source row receives the resolved card');
    assert.deepStrictEqual(unmatchedRows, [], 'resolved rows are not reported as failed');
    let rateLimited = false;
    scryfallApi.client.get = async (url) => {
      const set = url.includes('e%3Avow') ? 'vow' : url.includes('e%3Akhm') ? 'khm' : null;
      assert.ok(set, `set-scoped search expected, got ${url}`);
      if (!rateLimited) {
        rateLimited = true;
        const error = new Error('Scryfall rate limit');
        error.response = { status: 429, headers: { 'retry-after': '0' } };
        throw error;
      }
      return {
        data: {
          has_more: false,
          data: [{
            id: `${set}-forest-0000-0000-000000000000`, name: 'Forest',
            set, collector_number: '1', lang: 'en', image_uris: {}, prices: {}
          }]
        }
      };
    };
    const vowForest = { name: 'Forest', set_id: 'VOW', number: '' };
    const khmForest = { name: 'Forest', set_id: 'KHM', number: '' };
    const scoped = await scryfallApi.bulkFetchByIdentifier([vowForest, khmForest]);
    assert.deepStrictEqual(scoped.pairs.map(pair => [pair.row.set_id, pair.card.id]), [
      ['VOW', 'mtg-vow-forest-0000-0000-000000000000'],
      ['KHM', 'mtg-khm-forest-0000-0000-000000000000']
    ], 'set codes keep duplicate land names as separate printings');

    const localRaw = {
      id: '11111111-1111-4111-8111-111111111111', name: 'Forest',
      set: 'fdn', collector_number: '280', lang: 'en', image_uris: {}, prices: { usd: '1.00' }
    };
    const remoteRaw = { ...localRaw, id: '22222222-2222-4222-8222-222222222222', collector_number: '281' };
    const localRow = { name: 'Forest', set_id: 'fdn', number: '280' };
    const foilRow = { ...localRow, printing: 'Holofoil' };
    const remoteRow = { name: 'Forest', set_id: 'fdn', number: '281' };
    const unknownRow = { name: 'Not a card', set_id: 'fdn', number: '999' };
    scryfallBulk.resolveRows = async rows => ({
      pairs: rows.filter(row => row.number === '280').map(row => ({ row, raw: localRaw })),
      unmatchedRows: rows.filter(row => row.number !== '280')
    });
    scryfallApi.client.get = scryfallApi.client.post = async () => { throw new Error('Local hits must not contact the API'); };
    const localResult = await scryfallApi.bulkFetchByIdentifier([localRow, foilRow], undefined, { localFirst: true });
    assert.deepStrictEqual(localResult.pairs.map(pair => pair.row), [localRow, foilRow]);
    assert.deepStrictEqual(localResult.cards, [scryfallApi.normalizeCard(localRaw)]);
    assert.deepStrictEqual(localResult.unmatchedRows, []);

    let apiCalls = 0;
    scryfallApi.client.post = async (url, body) => {
      apiCalls++;
      assert.deepStrictEqual(body.identifiers, [
        { set: 'fdn', collector_number: '281' }, { set: 'fdn', collector_number: '999' }
      ], 'only local misses reach the API');
      return { data: { data: [remoteRaw], not_found: [{ set: 'fdn', collector_number: '999' }] } };
    };
    const events = [];
    const mixed = await scryfallApi.bulkFetchByIdentifier([localRow, remoteRow, unknownRow], event => events.push(event), { localFirst: true });
    assert.strictEqual(apiCalls, 1);
    assert.deepStrictEqual(mixed.pairs.map(pair => [pair.row, pair.card.id]), [
      [localRow, `mtg-${localRaw.id}`], [remoteRow, `mtg-${remoteRaw.id}`]
    ]);
    assert.deepStrictEqual(mixed.unmatchedRows, [unknownRow]);
    assert.deepStrictEqual(events.find(event => event.stage === 'local-resolved'), { stage: 'local-resolved', matched: 1, unmatched: 2 });
    assert.deepStrictEqual(events.find(event => event.stage === 'api-fallback'), { stage: 'api-fallback', total: 2 });
    assert.strictEqual(events.filter(event => event.stage === 'resolved').length, 1);
    assert.strictEqual(events.at(-1).matched, 2);
    assert.strictEqual(events.at(-1).unmatched, 1);

    // No catalog was created for this isolated DB: real lookup must remain usable.
    scryfallBulk.resolveRows = originalResolveRows;
    scryfallApi.client.post = async (url, body) => {
      assert.deepStrictEqual(body.identifiers, [{ set: 'fdn', collector_number: '280' }]);
      return { data: { data: [localRaw], not_found: [] } };
    };
    const absent = await scryfallApi.bulkFetchByIdentifier([localRow], undefined, { localFirst: true });
    assert.strictEqual(absent.pairs[0].card.id, `mtg-${localRaw.id}`);
    assert.deepStrictEqual(absent.unmatchedRows, []);

    // A catalog snapshot must never replace live prices during a sweep.
    await scryfallApi.cacheCards([scryfallApi.normalizeCard(localRaw)]);
    await db.run('INSERT INTO collection (card_id, user_id, quantity, game) VALUES (?, 1, 1, ?)', [`mtg-${localRaw.id}`, 'mtg']);
    scryfallBulk.resolveRows = async () => { throw new Error('Price sweeps must not consult bulk'); };
    scryfallApi.client.post = async (url, body) => {
      assert.deepStrictEqual(body.identifiers, [{ id: localRaw.id }]);
      return { data: { data: [{ ...localRaw, prices: { usd: '9.50' } }], not_found: [] } };
    };
    await scryfallApi.updateCollectionPrices(true);
    assert.strictEqual((await db.get('SELECT price_trend FROM card_cache WHERE id = ?', [`mtg-${localRaw.id}`])).price_trend, 9.5);
    assert.strictEqual((await db.get('SELECT price FROM price_history WHERE card_id = ?', [`mtg-${localRaw.id}`])).price, 9.5);
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
    scryfallApi.client.post = originalPost;
    scryfallApi.client.get = originalGet;
    scryfallBulk.resolveRows = originalResolveRows;
  }
}

testDuplicateIdentifiers()
  .then(() => console.log('Scryfall bulk matching, local-first fallback, and live price checks passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
