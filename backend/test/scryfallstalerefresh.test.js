const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-stale-refresh-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'stale-refresh-test';
process.env.SCRYFALL_GAP_SCALE = '0';
const db = require('../src/db');
const api = require('../src/scryfallApi');
const originalPost = api.client.post;
const originalGet = api.client.get;
const originalTimezone = process.env.TZ;
const originalNow = Date.now;
const now = Date.now();
Date.now = () => now;
const ageLimit = 3 * 24 * 60 * 60 * 1000;
const raw = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Refresh A', set: 'tst',
  collector_number: '1', lang: 'en', image_uris: {}, prices: { usd: '1.00' },
};
const empty = { data: { data: [], not_found: [] } };
const timestamp = age => new Date(now - age).toISOString().slice(0, 19).replace('T', ' ');
const search = name => api.searchCards({ name, lang: 'English' });
// A queued no-network request is a barrier for every refresh already scheduled by search.
const drain = async () => {
  await api.scryGetRetried('/sets');
  await new Promise(resolve => setImmediate(resolve));
};

async function main() {
  try {
    await db.initDb();
    await api.cacheCards([api.normalizeCard(raw)]);
    api.client.get = async () => ({ data: {} });
    let batches = [];
    api.client.post = async (_url, body) => { batches.push(body.identifiers); return empty; };
    for (const [timezone, age, expected] of [
      ['America/New_York', ageLimit + 60 * 60 * 1000, 1],
      ['Asia/Tokyo', ageLimit - 60 * 60 * 1000, 0],
    ]) {
      process.env.TZ = timezone;
      batches = [];
      await db.run('UPDATE card_cache SET last_updated = ?', [timestamp(age)]);
      const cached = await search('Refresh A');
      assert.strictEqual(cached.cards[0].id, `mtg-${raw.id}`);
      await drain();
      assert.strictEqual(batches.length, expected, `${timezone} interprets SQLite timestamps as UTC`);
    }

    const other = { ...raw, id: '22222222-2222-4222-8222-222222222222', name: 'Refresh B', collector_number: '2' };
    await api.cacheCards([api.normalizeCard(other)]);
    await db.run('UPDATE card_cache SET last_updated = ?', [timestamp(ageLimit + 24 * 60 * 60 * 1000)]);
    batches = [];
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    api.client.post = async (_url, body) => {
      batches.push(body.identifiers);
      await blocked;
      return empty;
    };
    await search('Refresh A');
    const overlapping = await Promise.all([search('Refresh'), search('Refresh'), search('Refresh A')]);
    assert.deepStrictEqual(overlapping[0].cards.map(card => card.name).sort(), ['Refresh A', 'Refresh B'],
      'cached searches finish while a refresh is blocked');
    release();
    await drain();
    assert.deepStrictEqual(batches, [[{ id: raw.id }], [{ id: other.id }]],
      'overlapping searches refresh each stale ID once, without suppressing newly encountered IDs');
    await search('Refresh A');
    await drain();
    assert.strictEqual(batches.length, 3, 'successful completion releases the ID for a later refresh');

    let attempts = 0;
    api.client.post = async () => { attempts++; throw new Error('offline fixture'); };
    await search('Refresh A');
    await drain();
    await search('Refresh A');
    await drain();
    assert.strictEqual(attempts, 2, 'failed refreshes release their IDs instead of blocking all future refreshes');
    console.log('scryfallstalerefresh.test.js: UTC age and per-ID refresh lifecycle passed');
  } finally {
    api.client.post = originalPost;
    api.client.get = originalGet;
    Date.now = originalNow;
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
