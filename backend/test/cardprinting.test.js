// Test for GET /api/cards/:id/printing endpoint.
// Run: `node test/cardprinting.test.js`
const assert = require('assert');
const path = require('path');
const os = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-cardprinting-${process.pid}.db`);

(async () => {
  const db = require('../src/db');
  await db.initDb();
  const scryfall = require('../src/scryfallApi');
  const express = require('express');
  const collectionRouter = require('../src/routes/collection');

  // Stub Scryfall
  scryfall.client.get = async (url) => {
    const m = url.match(/^\/cards\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, set, number, lang] = m;
    if (set === 'lea') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: `mtg-${set}-${number}-${lang}`, lang,
        name: 'Ancestral Katana', printed_name: lang === 'ja' ? '祖先の刀' : 'Katana der Ahnen',
        set, set_name: 'Kamigawa: Neon Dynasty', collector_number: number,
        image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` },
        rarity: 'common', prices: {},
      },
    };
  };

  const app = express();
  app.use(express.json());
  app.use('/api', collectionRouter);

  // Insert mock MTG card into cache
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, set_id, number, game, language, price_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['mtg-neo-1', 'Ancestral Katana', 'neo', '1', 'mtg', 'English', 'USD']
  );

  // Stored unsupported cards remain unchanged and cannot be localized.
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, set_id, number, game, language, price_currency)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['legacy-card', 'Legacy Card', 'legacy-set', '12', 'unsupported', 'English', 'USD']
  );

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/api`;

  try {
    // 1. Fetch Japanese MTG printing
    const resMtg = await fetch(`${baseUrl}/cards/mtg-neo-1/printing?lang=ja&game=mtg`);
    assert.strictEqual(resMtg.status, 200);
    const dataMtg = await resMtg.json();
    assert.strictEqual(dataMtg.language, 'Japanese');
    assert.strictEqual(dataMtg.printed_name, '祖先の刀');
    assert.strictEqual(dataMtg.name, 'Ancestral Katana');

    for (const query of ['lang=fr', 'lang=en', 'lang=fr&game=mtg']) {
      const response = await fetch(`${baseUrl}/cards/legacy-card/printing?${query}`);
      assert.strictEqual(response.status, 400);
    }
    assert.deepStrictEqual(await db.get('SELECT game, language, printed_name FROM card_cache WHERE id = ?', ['legacy-card']),
      { game: 'unsupported', language: 'English', printed_name: null });

    // 4. Missing lang parameter returns 400
    const resMissing = await fetch(`${baseUrl}/cards/mtg-neo-1/printing`);
    assert.strictEqual(resMissing.status, 400);

    // 5. Nonexistent card returns 404
    const resNotFound = await fetch(`${baseUrl}/cards/mtg-nonexistent/printing?lang=ja`);
    assert.strictEqual(resNotFound.status, 404);

    const unsupported = await fetch(`${baseUrl}/cards/unsupported-1/printing?lang=ja`);
    assert.strictEqual(unsupported.status, 400);
    const mismatched = await fetch(`${baseUrl}/cards/mtg-neo-1/printing?lang=ja&game=unsupported`);
    assert.strictEqual(mismatched.status, 400);

    await db.run(`INSERT INTO card_cache (id, name, set_id, number, game, language)
      VALUES ('mtg-lea-1', 'Black Lotus', 'lea', '1', 'mtg', 'English')`);
    const unavailable = await fetch(`${baseUrl}/cards/mtg-lea-1/printing?lang=ja`);
    assert.strictEqual(unavailable.status, 404, 'an unavailable translation must not relabel an English printing');
    const unchanged = await fetch(`${baseUrl}/cards/mtg-lea-1/printing?lang=en`);
    assert.strictEqual(unchanged.status, 200);
    assert.strictEqual((await unchanged.json()).language, 'English');

    console.log('cardprinting.test.js: all assertions passed');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
