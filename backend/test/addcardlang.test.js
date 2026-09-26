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

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `manafolio-addcardlang-${process.pid}.db`
);

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

  console.log('addcardlang.test.js: all assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
