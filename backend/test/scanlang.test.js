// A scanned card must come back in the language being scanned.
//
// Card ART is identical in every language, so the scanner matches a Japanese card
// against whatever catalog exists (English, for most installs) and gets the
// ENGLISH printing back. The scan route re-expresses that answer via
// getPrintingInLang; without it a Japanese scan filed an English printing, with
// English art and an English name, no matter what Card Language was set to.
//
// Scryfall is stubbed: this checks the lookup asks for the right thing and
// classifies the answer correctly, not that Scryfall is up.
const assert = require('assert');

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `manafolio-scanlang-${process.pid}.db`
);

(async () => {
  const scryfall = require('../src/scryfallApi');
  const db = require('../src/db');
  await db.initDb();

  const requested = [];
  // The card endpoint's language form: /cards/:code/:number/:lang.
  scryfall.client.get = async (url) => {
    requested.push(url);
    const m = url.match(/^\/cards\/([^/]+)\/([^/]+)\/([^/?]+)/);
    if (!m) throw Object.assign(new Error('unexpected url'), { response: { status: 404 } });
    const [, set, number, lang] = m;
    // Alpha was never printed outside English — the real 404 case.
    if (set === 'lea') throw Object.assign(new Error('not found'), { response: { status: 404 } });
    return {
      data: {
        id: `${set}-${number}-${lang}`, lang,
        name: 'Ancestral Katana', printed_name: lang === 'ja' ? '祖先の刀' : 'Katana der Ahnen',
        set, set_name: 'Kamigawa: Neon Dynasty', collector_number: number,
        image_uris: { normal: `https://cards.scryfall.io/${lang}.jpg` },
        rarity: 'common', prices: {},
      },
    };
  };

  const ja = await scryfall.getPrintingInLang('neo', '1', 'Japanese');
  assert.ok(ja, 'a Japanese printing should resolve');
  assert.strictEqual(ja.language, 'Japanese', 'row must be tagged Japanese');
  assert.strictEqual(ja.printed_name, '祖先の刀', 'printed_name carries the localized name');
  assert.match(ja.image_url, /ja\.jpg$/, 'art must be the Japanese printing');

  // English is already what the catalog returns: no request, nothing to switch to.
  const before = requested.length;
  assert.strictEqual(await scryfall.getPrintingInLang('neo', '1', 'English'), null);
  assert.strictEqual(requested.length, before, 'English must not cost a request');

  // Never printed in that language: null, so the caller keeps the English card
  // rather than showing nothing.
  assert.strictEqual(await scryfall.getPrintingInLang('lea', '1', 'Japanese'), null);

  // Second call for the same printing is served from card_cache.
  const cachedAt = requested.length;
  const again = await scryfall.getPrintingInLang('neo', '1', 'Japanese');
  assert.strictEqual(again.printed_name, '祖先の刀');
  assert.strictEqual(requested.length, cachedAt, 'cached printing must not re-request');

  // An unavailable translation from the Magic scan route
  // remains an English printing and requires review, never a relabelled copy.
  const router = require('../src/routes/collection');
  const scanLayer = router.stack.find(l => l.route && l.route.path === '/scan-match');
  const scanMatch = scanLayer.route.stack[scanLayer.route.stack.length - 1].handle;
  const cvScan = require('../src/cvScan');
  cvScan.isBuilt = () => true;
  let setCode = 'lea';
  cvScan.match = async () => ({
    verified: false, candidates: [{ cardId: `mtg-${setCode}-1-en`, score: 0.91 }],
    quality: { blurry: false, glare: false },
  });
  scryfall.getCardById = async () => ({
    id: `mtg-${setCode}-1-en`, name: 'Ancestral Katana', set_id: setCode, number: '1',
    language: 'English', image_url: 'https://cards.scryfall.io/en.jpg',
  });
  const scan = async (lang) => {
    let body;
    await scanMatch(
      { body: { image: 'x'.repeat(200), lang }, user: {}, query: {} },
      { json: value => { body = value; }, status() { return this; } },
    );
    return body;
  };
  const fallback = await scan('ja');
  assert.strictEqual(fallback.candidates[0].card.language, 'English');
  assert.strictEqual(fallback.candidates[0].card.langFallback, 'Japanese');
  assert.strictEqual(fallback.safety.autoAddSafe, false);
  assert.ok(fallback.safety.reasons.includes('language_fallback'));
  assert.strictEqual(fallback.lang, 'en');

  const english = await scan('en');
  assert.strictEqual(english.candidates[0].card.langFallback, undefined);
  assert.strictEqual(english.safety.context.languageFallback, false);
  assert.strictEqual(english.safety.autoAddSafe, true);

  setCode = 'neo';
  const translated = await scan('ja');
  assert.strictEqual(translated.candidates[0].card.language, 'Japanese');
  assert.strictEqual(translated.candidates[0].card.id, ja.id);
  assert.strictEqual(translated.safety.context.languageFallback, false);
  assert.strictEqual(translated.safety.autoAddSafe, true);
  assert.strictEqual(translated.lang, 'ja');

  console.log('scanlang.test.js: provider languages and scan fallback assertions passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
