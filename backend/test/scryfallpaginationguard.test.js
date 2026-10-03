const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const axios = require('axios');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-pagination-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'pagination-test';
process.env.SCRYFALL_GAP_SCALE = '0';
const db = require('../src/db');
const api = require('../src/scryfallApi');
const { cacheSetCards } = require('../src/cardSets');
const originalGet = api.client.get;
const raw = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Sample', set: 'tst',
  collector_number: '1', lang: 'en', finishes: ['nonfoil'], games: ['paper'],
  image_uris: { normal: 'https://cards.scryfall.io/sample.jpg' }, prices: {},
};
const sets = { data: { data: [{ code: 'tst', card_count: 1 }] } };
const operations = [
  ['set import', () => api.bulkFetchByIdentifier([{ name: 'Sample', set_id: 'tst' }])],
  ['catalog build', () => cacheSetCards('mtg', 'tst', 'English')],
  ['set checklist', () => api.getSetChecklist('tst')],
];

async function main() {
  let redirected = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect-target') {
      redirected++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [raw], total_cards: 1, has_more: false }));
    } else {
      res.writeHead(302, { Location: '/redirect-target' });
      res.end();
    }
  });
  try {
    await db.initDb();
    for (const [name, operation] of operations) {
      for (const nextPage of [
        url => new URL(url, 'https://api.scryfall.com').href,
        () => 'https://example.invalid/private',
        () => 'https://api.scryfall.com/sets',
        () => undefined,
      ]) {
        let requests = 0;
        api.client.get = async url => {
          if (url === 'https://api.scryfall.com/sets' && !requests) return sets;
          requests++;
          if (requests > 1) throw new Error('Untrusted pagination was requested');
          return { data: { data: [raw], total_cards: 1, has_more: true, next_page: nextPage(url) } };
        };
        await assert.rejects(operation(), /(?:Invalid|Incomplete) set catalog pagination/, name);
        assert.strictEqual(requests, 1, `${name} rejects unsafe metadata before another request`);
      }
    }
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const localUrl = `http://127.0.0.1:${server.address().port}/start`;
    api.client.get = (url, config) => url === 'https://api.scryfall.com/sets'
      ? Promise.resolve(sets) : axios.get(localUrl, { ...config, proxy: false });
    for (const [name, operation] of operations) {
      await assert.rejects(operation(), error => error.response?.status === 302, `${name} rejects redirects`);
    }
    assert.strictEqual(redirected, 0, 'pagination requests never follow redirect destinations');
    console.log('scryfallpaginationguard.test.js: loops, origins, paths, missing links and redirects passed');
  } finally {
    api.client.get = originalGet;
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
