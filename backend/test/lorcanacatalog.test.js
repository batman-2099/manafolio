// Tests for Lorcana catalog discovery, set listing, and card caching.
const assert = require('assert');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-lorcanacat-${process.pid}.db`);
const db = require('../src/db');
const catalog = require('../src/catalog');
const cardSets = require('../src/cardSets');
const lorcastApi = require('../src/lorcastApi');
const modelAssets = require('../src/utils/modelAssets');

const SAMPLE_SETS = [
  { id: 'set_1', name: 'The First Chapter', code: '1', released_at: '2023-08-18' },
  { id: 'set_2', name: 'Rise of the Floodborn', code: '2', released_at: '2023-11-17' },
];

const SAMPLE_CARDS = [
  {
    id: 'crd_1',
    name: 'Elsa',
    version: 'Snow Queen',
    collector_number: '1',
    rarity: 'Common',
    cost: 3,
    ink: 'Amethyst',
    type: ['Character'],
    prices: { usd: 1.50 },
    tcgplayer_id: 501001,
    image_uris: {
      digital: {
        normal: 'https://cards.lorcast.io/card/digital/normal/crd_1.avif',
        large: 'https://cards.lorcast.io/card/digital/large/crd_1.avif',
      },
    },
    set: { id: 'set_1', code: '1', name: 'The First Chapter' },
  },
  {
    id: 'crd_2',
    name: 'Mickey Mouse',
    version: 'Wayward Sorcerer',
    collector_number: '2',
    rarity: 'Rare',
    cost: 4,
    ink: 'Amethyst',
    type: ['Character'],
    prices: { usd: 3.50 },
    tcgplayer_id: 501002,
    image_uris: {
      digital: {
        normal: 'https://cards.lorcast.io/card/digital/normal/crd_2.avif',
        large: 'https://cards.lorcast.io/card/digital/large/crd_2.avif',
      },
    },
    set: { id: 'set_1', code: '1', name: 'The First Chapter' },
  },
];

function setupAdapter() {
  lorcastApi.client.defaults.adapter = async (config) => {
    const url = config.url || '';
    if (url.includes('/sets')) {
      return { status: 200, statusText: 'OK', headers: {}, config, data: { results: SAMPLE_SETS } };
    }
    if (url.includes('/cards/search')) {
      const q = config.params?.q || '';
      if (q.includes('set:1')) {
        return { status: 200, statusText: 'OK', headers: {}, config, data: { results: SAMPLE_CARDS } };
      }
      return { status: 200, statusText: 'OK', headers: {}, config, data: { results: [] } };
    }
    return { status: 404, statusText: 'Not Found', headers: {}, config, data: { error: 'Not found' } };
  };
}

async function main() {
  await db.initDb();
  setupAdapter();

  // 1. Set discovery
  const allSets = await cardSets.listAllSets('lorcana', 'English');
  assert.ok(allSets.length >= 2, 'should list Lorcana sets');
  assert.ok(allSets.includes('1'), 'should include set 1');

  // 2. Cache cards for set 1
  const cached = await cardSets.cacheSetCards('lorcana', '1', 'English');
  assert.strictEqual(cached.length, 2, 'should cache 2 cards for set 1');

  // Verify rows in card_cache
  const rows = await db.all(`SELECT * FROM card_cache WHERE game = 'lorcana'`);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].set_id, 'lorcana-1');

  // Verify tcgplayer_product mapping was populated
  const prodRows = await db.all(`SELECT * FROM tcgplayer_product WHERE card_id = ?`, ['lorcana-crd_1']);
  assert.strictEqual(prodRows.length, 1);
  assert.strictEqual(prodRows[0].product_id, 501001);

  // 3. Catalog list includes Lorcana
  const catList = await catalog.list();
  const lorcanaRow = catList.find(c => c.game === 'lorcana' && c.lang === 'English');
  assert.ok(lorcanaRow, 'catalog list should include Lorcana English');
  assert.strictEqual(lorcanaRow.cached, 2, 'should report 2 cached cards');
  assert.strictEqual(lorcanaRow.withArt, 2, 'should report 2 cards with artwork');

  // 4. Set counts
  const sc = await catalog.setCounts('lorcana', 'English');
  assert.ok(sc.sets['lorcana-1'], 'should have counts for lorcana-1');
  assert.ok(sc.sets['1'], 'should have counts for bare set code 1');
  assert.strictEqual(sc.sets['1'].cached, 2);

  // 5. Catalog GAMES includes Lorcana
  assert.ok(catalog.GAMES.includes('lorcana'), 'catalog.GAMES should include Lorcana');

  // 6. Cache cards for set 1 in French
  const cachedFr = await cardSets.cacheSetCards('lorcana', '1', 'French');
  assert.strictEqual(cachedFr.length, 2);
  assert.strictEqual(cachedFr[0].name, 'Elsa - Reine des neiges');
  const rowsFr = await db.all(`SELECT * FROM card_cache WHERE game = 'lorcana' AND language = 'French'`);
  assert.strictEqual(rowsFr.length, 2);
  assert.strictEqual(rowsFr[0].printed_name, 'Elsa - Reine des neiges');

  console.log('lorcanacatalog.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
