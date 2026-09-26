// Runnable check for Scryfall's PER-ENDPOINT rate limits.
// https://scryfall.com/docs/api/rate-limits sets /cards/search and
// /cards/collection to 2/second (500ms) — not the 10/second that applies to
// everything else. A single 120ms gap was ~4x over on exactly the endpoints
// this app leans on, which is what earned the 429s.
// No framework — plain node + assert. Run: `node test/scryfallratelimit.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-ratelimit-${process.pid}.db`);
const scryfallApi = require('../src/scryfallApi');

const hits = [];
scryfallApi.client.defaults.adapter = async (config) => {
  hits.push({ url: config.url, at: Date.now() });
  return { status: 200, statusText: 'OK', headers: {}, config, data: { object: 'list', data: [], has_more: false } };
};

const gapsFor = (matcher) => {
  const times = hits.filter(h => matcher.test(h.url)).map(h => h.at);
  return times.slice(1).map((t, i) => t - times[i]);
};

async function main() {
  // 1. Back-to-back searches must be spaced at least 500ms apart.
  hits.length = 0;
  for (let i = 0; i < 3; i++) await scryfallApi.scryGetRetried(`/cards/search?q=c${i}`);
  const searchGaps = gapsFor(/cards\/search/);
  assert.strictEqual(searchGaps.length, 2);
  for (const g of searchGaps) {
    assert.ok(g >= 480, `/cards/search must be <=2/second, saw a ${g}ms gap`);
  }

  // 2. The bulk lookup shares that 2/second limit.
  hits.length = 0;
  for (let i = 0; i < 3; i++) {
    await scryfallApi.scryGetRetried(`/cards/collection?n=${i}`);
  }
  for (const g of gapsFor(/cards\/collection/)) {
    assert.ok(g >= 480, `/cards/collection must be <=2/second, saw a ${g}ms gap`);
  }

  // 3. Everything else keeps the looser 10/second floor — a set list must not
  //    be slowed to the strict card-endpoint pace.
  hits.length = 0;
  const t0 = Date.now();
  for (let i = 0; i < 4; i++) await scryfallApi.scryGetRetried('https://api.scryfall.com/sets');
  const setsElapsed = Date.now() - t0;
  for (const g of gapsFor(/\/sets/)) {
    assert.ok(g >= 90, `other endpoints still need the 10/second floor, saw ${g}ms`);
  }
  assert.ok(setsElapsed < 4 * 500, `/sets should not be throttled to 500ms, took ${setsElapsed}ms for 4`);

  // 4. Absolute URLs (Scryfall's own next_page links) are classified by path,
  //    not treated as an unknown endpoint that skips the strict limit.
  hits.length = 0;
  for (let i = 0; i < 2; i++) {
    await scryfallApi.scryGetRetried(`https://api.scryfall.com/cards/search?q=x&page=${i + 1}`);
  }
  for (const g of gapsFor(/cards\/search/)) {
    assert.ok(g >= 480, `absolute next_page URLs must still be rate limited, saw ${g}ms`);
  }

  console.log('scryfallratelimit.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
