// A copy recorded in another language must reference that language's PRINTING.
//
// The card is picked in whatever language the search ran in, but the copy's language
// is chosen separately — Quick Add's dropdown, or a scan the English catalog
// answered. Both used to leave the collection row pointing at the English printing,
// so a card filed as Japanese still showed its English name, art and price: the
// localized name lives on the printing (card_cache.printed_name), not on the copy.
//
// cardApi.printingInLanguage swaps to a localized printing. Scryfall is stubbed
// to check dispatch and missing-printing behavior without network requests.
const assert = require('assert');

process.env.DB_PATH = ':memory:';

(async () => {
  const cardApi = require('../src/utils/cardApi');
  const scryfall = require('../src/scryfallApi');
  const languages = require('../src/utils/languages');
  const db = require('../src/db');
  await db.initDb();

  // Scryfall's language form of the card endpoint: /cards/:set/:number/:lang.
  scryfall.client.get = async (url) => {
    const m = url.match(/^\/cards\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, set, number, lang] = m;
    if (set === 'lea') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: `${set}-${number}-${lang}`, lang,
        name: 'Lightning Bolt', printed_name: '稲妻',
        set, set_name: 'Kamigawa', collector_number: number,
        image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` },
        rarity: 'common', prices: {},
      },
    };
  };

  const english = { id: 'mtg-abc', game: 'mtg', set_id: 'neo', number: '1', language: 'English' };

  // The point of the fix: a Japanese copy of an English-searched Magic card lands on
  // the Japanese printing, which is the row that carries the Japanese name.
  const ja = await cardApi.printingInLanguage(english, 'Japanese');
  assert.ok(ja, 'a Japanese printing should resolve');
  assert.strictEqual(ja.language, 'Japanese');
  assert.strictEqual(ja.printed_name, '稲妻', 'the localized name comes with it');
  assert.notStrictEqual(ja.id, english.id, 'a different printing means a different row');

  // Same language as the printing: nothing to swap, and no request to pay for.
  assert.strictEqual(await cardApi.printingInLanguage(english, 'English'), null);
  assert.strictEqual(await cardApi.printingInLanguage({ ...english, language: 'Japanese' }, 'ja'), null,
    'a code and its display name are the same language');

  // Never printed in that language: keep the card the user picked.
  assert.strictEqual(
    await cardApi.printingInLanguage({ ...english, set_id: 'lea' }, 'Japanese'), null);

  // Set ids are stored prefixed in places; the printing lookup wants the bare code.
  const prefixed = await cardApi.printingInLanguage({ ...english, set_id: 'mtg-neo' }, 'Japanese');
  assert.strictEqual(prefixed && prefixed.set_id, 'neo', 'the mtg- prefix must not reach Scryfall');

  // Every language in the table, not just Japanese: the swap resolves through
  // utils/languages, so Scryfall's own spelling (such as zht)
  // is looked up per row rather than assumed to be the canonical code. A language
  // whose codes were mistyped would silently stop localizing, which reads exactly
  // like "the name is still in English".
  for (const l of languages.LANGUAGES.filter(x => x.code !== 'en')) {
    const mtg = await cardApi.printingInLanguage(english, l.name);
    assert.ok(mtg, `${l.name}: a Magic printing should resolve`);
    assert.strictEqual(mtg.language, l.name, `${l.name}: row tagged with the language asked for`);
    assert.ok(mtg.id.endsWith(`-${l.scryfall}`), `${l.name}: asked Scryfall for ${l.scryfall}`);
  }

  const providerGet = scryfall.client.get;
  const outage = Object.assign(new Error('Fixture provider outage'), { response: { status: 503 } });
  scryfall.client.get = async () => { throw outage; };
  await assert.rejects(cardApi.printingInLanguage({ ...english, number: '2' }, 'Japanese'),
    error => error === outage, 'provider outages are not missing printings');
  scryfall.client.get = providerGet;
  await db.run(`CREATE TEMP TRIGGER reject_localized_cache BEFORE INSERT ON card_cache
    WHEN NEW.id = 'mtg-neo-2-ja' BEGIN SELECT RAISE(ABORT, 'Fixture cache failure'); END`);
  await assert.rejects(cardApi.printingInLanguage({ ...english, number: '2' }, 'Japanese'),
    /Fixture cache failure/, 'persistence failures cannot silently retain the original printing');
  await db.run('DROP TRIGGER reject_localized_cache');

  const { lastID: userId } = await db.run(
    "INSERT INTO users (username, password_hash, share_token) VALUES ('language-fixture', 'unused', 'language-fixture')");
  await db.run(`INSERT INTO card_cache (id, name, game, set_id, number, language)
    VALUES ('mtg-original', 'Original printing', 'mtg', 'neo', '2', 'English')`);
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/api', require('../src/routes/collection'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    scryfall.client.get = async () => { throw outage; };
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/collection`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_id: 'mtg-original', language: 'Japanese', quantity: 1 })
    });
    assert.strictEqual(response.status, 500);
    assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM collection')).count, 0,
      'failed localization must not add a copy under the original identity');
  } finally {
    scryfall.client.get = providerGet;
    await new Promise(resolve => server.close(resolve));
  }

  console.log('addcardlang.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
