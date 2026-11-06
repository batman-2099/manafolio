// Runnable smoke test for Scryfall result paging (issue #24: set/name searches
// were capped at one page, so a set showed ~55 cards and "Sol Ring" showed 2).
// fetchWindow has to slice an arbitrary [offset, offset+limit) window out of
// Scryfall's fixed 175-card pages. No framework — plain node + assert.
// Run: `node test/scryfallpaging.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the db module at a throwaway file before scryfallApi pulls it in.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-scrypaging-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'scryfall-paging-test';
process.env.SCRYFALL_GAP_SCALE = '0';
const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');

const SCRY_PAGE = 175;
const TOTAL = 400;

// Stub the axios adapter: serve TOTAL fake cards in 175-card pages.
let requested = [];
let queries = [];
scryfallApi.client.defaults.adapter = async (config) => {
  const params = new URL(config.url, 'https://api.scryfall.com').searchParams;
  const page = parseInt(params.get('page'), 10) || 1;
  queries.push(params.get('q'));
  requested.push(page);
  const start = (page - 1) * SCRY_PAGE;
  const data = [];
  for (let i = start; i < Math.min(start + SCRY_PAGE, TOTAL); i++) {
    data.push({ id: `card-${i + 1}`, name: 'Sol Ring', set: 'tst', collector_number: '488', lang: 'en' });
  }
  return { status: 200, statusText: 'OK', headers: {}, config, data: { data, total_cards: TOTAL, has_more: start + SCRY_PAGE < TOTAL } };
};

const ids = r => r.cards.map(c => c.id);

async function main() {
  // 1. First window is the head of page 1 and reports more to come.
  let r = await scryfallApi.fetchWindow('set:tst', null, 0, 60);
  assert.strictEqual(r.cards.length, 60);
  assert.strictEqual(ids(r)[0], 'card-1');
  assert.strictEqual(ids(r)[59], 'card-60');
  assert.strictEqual(r.hasMore, true);

  // 2. A window inside page 1 must skip, not refetch from the top.
  requested = [];
  r = await scryfallApi.fetchWindow('set:tst', null, 60, 60);
  assert.deepStrictEqual(ids(r), Array.from({ length: 60 }, (_, i) => `card-${61 + i}`));
  assert.deepStrictEqual(requested, [1], 'offset 60 lives in Scryfall page 1');
  assert.strictEqual(r.hasMore, true);

  // 3. A window straddling a Scryfall page boundary stitches both pages.
  requested = [];
  r = await scryfallApi.fetchWindow('set:tst', null, 150, 60);
  assert.deepStrictEqual(ids(r), Array.from({ length: 60 }, (_, i) => `card-${151 + i}`));
  assert.deepStrictEqual(requested, [1, 2], 'must pull the next page to fill the window');
  assert.strictEqual(r.hasMore, true);

  // 4. The last window returns the remainder and reports the end.
  r = await scryfallApi.fetchWindow('set:tst', null, 340, 60);
  assert.deepStrictEqual(ids(r), Array.from({ length: 60 }, (_, i) => `card-${341 + i}`));
  assert.strictEqual(r.hasMore, false, 'no cards left after 400');

  // 5. Past the end is empty, not an error.
  r = await scryfallApi.fetchWindow('set:tst', null, 400, 60);
  assert.deepStrictEqual(ids(r), []);
  assert.strictEqual(r.hasMore, false);

  await db.initDb();
  queries = [];
  const search = { name: 'Sol Ring', number: '#0488/500', set: 'tst', allPrints: true, scope: 'internet', limit: 24 };
  const first = await scryfallApi.searchCards(search);
  const second = await scryfallApi.searchCards({ ...search, page: 2 });
  assert.deepStrictEqual(ids(first), Array.from({ length: 24 }, (_, i) => `mtg-card-${i + 1}`));
  assert.deepStrictEqual(ids(second), Array.from({ length: 24 }, (_, i) => `mtg-card-${i + 25}`));
  assert.strictEqual(first.total, TOTAL);
  assert.strictEqual(second.total, TOTAL);
  assert(queries.every(q => q === '!"Sol Ring" set:tst cn:488 unique:prints'), 'exact name, set and cleaned number constrain every page');
  const tokens = await scryfallApi.searchCards({ name: 'Sol Ring', allPrints: true, scope: 'internet', limit: 100, page: 2 });
  assert.deepStrictEqual(ids(tokens), Array.from({ length: 100 }, (_, i) => `mtg-card-${i + 101}`));
  assert.strictEqual(tokens.total, TOTAL);
  assert.strictEqual(queries.at(-1), '!"Sol Ring" unique:prints', 'scanner searches need neither set nor number');
  const exhausted = await scryfallApi.searchCards({ ...search, page: 18 });
  assert.deepStrictEqual(exhausted.cards, []);
  assert.strictEqual(exhausted.total, TOTAL);
  console.log('scryfallpaging.test.js: all assertions passed');
}

main().then(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}).catch(err => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
