const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const compression = require('compression');

const tmpDb = path.join(os.tmpdir(), `manafolio-import-progress-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'import-progress-test';
process.env.SCRYFALL_GAP_SCALE = '0';
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const scryfallBulk = require('../src/scryfallBulk');
const router = require('../src/routes/importExport');

async function run() {
  const originalGet = scryfall.client.get;
  const originalPost = scryfall.client.post;
  const originalResolveRows = scryfallBulk.resolveRows;
  let server;
  try {
    await db.initDb();
    const app = express();
    app.use(compression(), express.json(), (req, res, next) => { req.user = { id: 1 }; next(); });
    app.use(router);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/import`;
    const raw = { id: '11111111-1111-4111-8111-111111111111', name: 'Forest', set: 'fdn', collector_number: '280', lang: 'en', image_uris: {}, prices: {} };
    const request = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });

    for (const format of ['internal', 'manabox']) {
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let calls = 0;
      const provider = async () => {
        if (++calls === 1) {
          const error = new Error('rate limited');
          error.response = { status: 429, headers: { 'retry-after': '1' } };
          throw error;
        }
        await gate;
        return { data: { data: [raw], not_found: [], has_more: false } };
      };
      scryfall.client.get = provider;
      scryfall.client.post = provider;
      const before = await db.get('SELECT COUNT(*) AS count FROM collection');
      const response = await request({ format, list_type: 'arena', data: format === 'internal' ? 'Count,Name,Edition,Collector Number,Condition,Language,Foil,Tag\n2,Forest,FDN,,Near Mint,English,,' : '2 Forest (FDN) 280' });
      assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
      const events = [];
      let pending = '';
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const event = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          events.push(event);
          if (event.stage === 'retry') {
            assert.equal((await db.get('SELECT COUNT(*) AS count FROM collection')).count, before.count, 'retry is visible before import writes');
            release();
          }
        }
      }
      assert(events.some(event => event.stage === 'local-resolved' && event.matched === 0 && event.unmatched === 1));
      assert(events.some(event => event.stage === 'api-fallback' && event.total === 1));
      assert(events.some(event => event.stage === 'lookup'));
      assert(events.some(event => event.stage === 'retry'), 'real rate-limit wait reaches client');
      assert(events.some(event => event.stage === 'saved'));
      assert.equal(events.at(-1).type, 'complete');
      assert.equal(events.at(-1).data.summary.added.copies, 2);
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM collection')).count, before.count + 1);
    }
    assert.deepEqual(await db.all('SELECT DISTINCT list_type FROM collection'), [{ list_type: 'arena' }]);

    scryfall.client.get = async () => { const error = new Error('provider unavailable'); error.response = { status: 503 }; throw error; };
    const failed = await request({ format: 'internal', list_type: 'arena', data: 'Name,Set ID\nForest,FDN' });
    const events = (await failed.text()).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).type, 'error');
    assert(!events.some(event => event.type === 'complete'));
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM collection')).count, 2, 'failed lookup inserts no rows');

    scryfallBulk.resolveRows = async rows => ({ pairs: rows.map(row => ({ row, raw })), unmatchedRows: [] });
    scryfall.client.get = scryfall.client.post = async () => { throw new Error('Local imports must not contact Scryfall'); };
    for (const format of ['internal', 'arena', 'manabox']) {
      const response = await request({
        format, list_type: 'arena',
        data: format === 'manabox' ? '2 Forest (FDN) 280'
          : 'Count,Name,Edition,Collector Number,Condition,Language,Foil,Tag\n2,Forest,FDN,280,Near Mint,English,,'
      });
      const localEvents = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
      assert(localEvents.some(event => event.stage === 'local-resolved' && event.matched === 1 && event.unmatched === 0));
      assert(!localEvents.some(event => ['api-fallback', 'lookup'].includes(event.stage)));
      assert.equal(localEvents.at(-1).type, 'complete');
      assert.equal(localEvents.at(-1).data.summary.added.copies, 2);
    }
    assert.deepEqual(await db.all('SELECT DISTINCT card_id, user_id, list_type FROM collection'), [
      { card_id: `mtg-${raw.id}`, user_id: 1, list_type: 'arena' }
    ]);
    assert.equal((await db.get('SELECT SUM(quantity) AS copies FROM collection')).copies, 10);
    console.log('Streaming CSV/TXT local hits, API fallback, rate limits, persistence, and failure checks passed');
  } finally {
    scryfall.client.get = originalGet;
    scryfall.client.post = originalPost;
    scryfallBulk.resolveRows = originalResolveRows;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await new Promise(resolve => db.dbConnection.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmpDb + suffix, { force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
