const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-import-quantity-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const scryfall = require('../src/scryfallApi');
const router = require('../src/routes/importExport');
const handler = route => router.stack.find(layer => layer.route?.path === route && layer.route.methods.post).route.stack[0].handle;
async function request(body, route = '/import') {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler(route)({ body, user: { id: 1 }, accepts: () => 'application/json' }, res);
  return res;
}
(async () => {
  const bulkFetch = scryfall.bulkFetchByIdentifier;
  try {
    await db.initDb();
    scryfall.bulkFetchByIdentifier = async () => { throw new Error('Invalid rows must not reach external resolution'); };
    const invalid = [0, -1, 1.5, null, true, '', 'bad', '2junk', 'Infinity', NaN, Infinity, 2147483648];
    const items = invalid.map((quantity, index) => ({ card_id: `mtg-invalid-${index}`, name: `Invalid ${index}`, quantity }));
    const result = await request({ format: 'json', data: [...items,
      { card_id: 'mtg-omitted', name: 'Default quantity' },
      { card_id: 'mtg-string', name: 'Legacy numeric string', quantity: '2' },
      { card_id: 'mtg-max', name: 'Import boundary', quantity: 2147483647 }
    ] });
    assert.strictEqual(result.statusCode, 200);
    assert.strictEqual(result.body.count, 3);
    assert.deepStrictEqual(await db.all('SELECT card_id, quantity FROM collection ORDER BY id'), [
      { card_id: 'mtg-omitted', quantity: 1 }, { card_id: 'mtg-string', quantity: 2 }, { card_id: 'mtg-max', quantity: 2147483647 }
    ]);
    assert.deepStrictEqual(result.body.summary.added.items.map(item => item.quantity), [1, 2, 2147483647]);
    assert.deepStrictEqual(result.body.summary.failed.items.map(item => item.quantity), invalid);
    assert.ok(result.body.summary.failed.items.every(item => item.error));
    assert.strictEqual(result.body.summary.failed.copies, 0, 'invalid quantities cannot invent copy counts');
    assert.deepStrictEqual(await db.all("SELECT id FROM card_cache WHERE id LIKE 'mtg-invalid-%'"), []);
    const before = await db.all('SELECT * FROM collection ORDER BY id');
    for (const format of ['internal', 'arena', 'tcgplayer', 'dragonshield', 'manabox', 'custom']) {
      const data = 'Name,Quantity,Count\nBolt,0,0\nBolt,-1,-1\nBolt,1.5,1.5\nBolt,2junk,2junk\nBolt,Infinity,Infinity\nBolt,2147483648,2147483648';
      const body = { format, data, ...(format === 'custom' ? { mapping: { name: 'Name', quantity: 'Count' } } : {}) };
      // ManaBox CSV is autodetected by the internal CSV path, unlike ManaBox text.
      if (format === 'manabox') {
        body.format = 'internal';
        body.data = data.split('\n').map((line, index) => `${line},${index === 0 ? 'Set code,Card number' : 'lea,161'}`).join('\n');
      }
      const imported = await request(body);
      assert.strictEqual(imported.statusCode, 200, format);
      assert.strictEqual(imported.body.count, 0, format);
      assert.strictEqual(imported.body.summary.failed.cards, 6, format);
      assert.ok(imported.body.summary.failed.items.every(item => item.error), format);
      assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), before);
      const preview = await request(body, '/import/preview');
      assert.strictEqual(preview.statusCode, 200);
      assert.strictEqual(preview.body.errors.length, 6);
      assert.strictEqual(preview.body.quantity, 0);
    }
  } finally {
    scryfall.bulkFetchByIdentifier = bulkFetch;
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().then(() => console.log('Import quantity regression passed')).catch(error => { console.error(error); process.exitCode = 1; });
