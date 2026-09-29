const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-cardsets-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.DEFAULT_ADMIN_PASSWORD = 'cardsets-test';
  process.env.SCRYFALL_GAP_SCALE = '0';
  const db = require('../src/db');
  const api = require('../src/scryfallApi');
  const { cacheSetCards, listAllSets } = require('../src/cardSets');
  const originalGet = api.client.get;
  const image = { normal: 'https://cards.scryfall.io/front.jpg' };
  const top = { id: 'top', name: 'Top first', image_uris: image, card_faces: [{ image_uris: image }, { image_uris: image }] };
  const double = { id: 'double', name: 'Double', card_faces: [{ name: 'Front', image_uris: image }, { image_uris: image }, { image_uris: { small: 'small.jpg' } }] };
  const partial = { id: 'partial', name: 'Partial', image_uris: { small: 'small.jpg' }, card_faces: [{ image_uris: image }, {}] };
  const invisible = { id: 'invisible', image_uris: { small: 'small.jpg' }, card_faces: [{}] };
  let empty = false;
  let setsOffline = true;
  const now = Date.now;
  try {
    await db.initDb();
    api.client.get = async url => {
      const parsed = new URL(url);
      if (parsed.pathname === '/sets') {
        if (setsOffline) throw Object.assign(new Error('Sets unavailable'), { response: { status: 400 } });
        return { data: { data: [{ code: 'tst', card_count: 3 }] } };
      }
      if (empty) return { data: { data: [invisible] } };
      if (parsed.searchParams.get('page') === '2') return { data: { data: [
        { id: 'top', name: 'Must not overwrite first page', image_uris: image },
        { name: 'No id', image_uris: image },
      ] } };
      assert.strictEqual(parsed.searchParams.get('include_multilingual'), 'true');
      assert.match(parsed.searchParams.get('q'), /lang:ja/);
      return { data: { data: [top, double, partial, invisible], has_more: true,
        next_page: 'https://api.scryfall.com/cards/search?page=2' } };
    };
    await assert.rejects(listAllSets('mtg'), /Sets unavailable/);
    await assert.rejects(cacheSetCards('mtg', 'tst', 'Japanese'), /Sets unavailable/);
    setsOffline = false;
    assert.deepStrictEqual(await listAllSets('mtg'), ['tst']);
    setsOffline = true;
    Date.now = () => now() + 7 * 60 * 60 * 1000;
    assert.deepStrictEqual(await listAllSets('mtg'), ['tst'], 'a real stale set cache survives provider failure');
    const cards = await cacheSetCards('mtg', 'tst', 'Japanese');
    assert.strictEqual(cards.length, 6, 'top-level image wins, only normal-image faces count, including repeated printings');
    assert.deepStrictEqual(await db.all('SELECT id, name, language FROM card_cache ORDER BY id'), [
      { id: 'mtg-double', name: 'Front', language: 'Japanese' },
      { id: 'mtg-partial', name: 'Partial', language: 'Japanese' },
      { id: 'mtg-top', name: 'Top first', language: 'Japanese' },
    ], 'only eligible identities are cached, once per id with the first printing preserved');
    empty = true;
    await assert.rejects(cacheSetCards('mtg', 'tst', 'Japanese'), error => error.absent === true);
    empty = false;
    await db.run(`CREATE TRIGGER fail_cache BEFORE INSERT ON card_cache BEGIN SELECT RAISE(FAIL, 'cache write failed'); END`);
    await assert.rejects(cacheSetCards('mtg', 'tst', 'Japanese'), /cache write failed/);
    console.log('cardsets.test.js: face eligibility, pagination, deduplication and empty-set handling passed');
  } finally {
    Date.now = now;
    api.client.get = originalGet;
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
