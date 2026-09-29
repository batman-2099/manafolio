// Runnable checks for marketplace deep links.
//
// Search URLs must never masquerade as product links. Scryfall affiliate URLs
// can wrap either kind, and a missing product ID must not become a name search.
//
// The fix is to key on TCGplayer's product id instead of a URL: an id exists only
// when the card is genuinely listed. This checks the id wins, and that the
// backfill arithmetic that recovers 100,054 ids from already-cached URLs picks the
// product form and leaves the search form alone.
//
// No framework — plain node + assert. Run: `node test/marketplacelinks.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-mplinks-${process.pid}.db`);

// Real values, copied out of backend/database/manafolio.db — a hand-written URL
// would only prove the test agrees with itself.
const AFFILIATE_PRODUCT =
  'https://partner.tcgplayer.com/c/4931599/1830156/21018?subId1=api&u=https%3A%2F%2Fwww.tcgplayer.com%2Fproduct%2F706216%3Fpage%3D1';
const AFFILIATE_SEARCH =
  'https://partner.tcgplayer.com/c/4931599/1830156/21018?subId1=api&u=https%3A%2F%2Fwww.tcgplayer.com%2Fsearch%2Fmagic%2Fproduct%3FproductLineName%3Dmagic%26q%3DChristine%2BChapel%252C%2BCombat%2BMedic%26view%3Dgrid';

(async () => {
  // frontend/ is ESM ("type": "module"), so it loads by dynamic import from here.
  const links = await import(
    require('url').pathToFileURL(
      path.join(__dirname, '..', '..', 'frontend', 'src', 'utils', 'marketplaceLinks.js')
    ).href
  );

  // --- 1. The product id outranks the provider's URL ------------------------
  // Not a preference: the affiliate URL below wraps a real product page, and even
  // then the id form is the one that cannot silently become a search later.
  assert.strictEqual(
    links.tcgplayerUrl({ name: 'Sol Ring', tcgplayer_product_id: 706216, tcgplayer_url: AFFILIATE_SEARCH }),
    'https://www.tcgplayer.com/product/706216',
    'product id must win over a stored URL'
  );

  // --- 2. A non-English card with an id gets a working link -----------------
  // This is the case the old code could never serve: no Latin letters in the name,
  // so `searchable()` refused, so the button was hidden. The id does not care what
  // alphabet the name is in.
  assert.strictEqual(
    links.tcgplayerUrl({ name: '稲妻', tcgplayer_product_id: 517483 }),
    'https://www.tcgplayer.com/product/517483',
    'a Japanese printing with a product id must still link'
  );

  // --- 3. A stored URL is honoured only when it is a PRODUCT page -----------
  // The two forms differ by one character deep inside an affiliate redirect
  // ('%2Fproduct%2F' vs '%2Fproduct%3F'), which is why they were indistinguishable
  // to the old code and both got the label "View on TCGplayer".
  assert.strictEqual(
    links.tcgplayerUrl({ name: 'Sol Ring', tcgplayer_url: AFFILIATE_PRODUCT }),
    AFFILIATE_PRODUCT,
    'a stored product URL is a valid link'
  );
  assert.strictEqual(
    links.tcgplayerUrl({ name: 'Christine Chapel', tcgplayer_url: AFFILIATE_SEARCH }),
    null,
    'a stored SEARCH url must NOT be served as a link to the card'
  );

  // --- 3b. No name search dressed up as the card ----------------------------
  assert.strictEqual(
    links.tcgplayerUrl({ name: 'Lightning Bolt', game: 'mtg' }),
    null,
    'no id and no product URL must mean no link at all'
  );
  // The search is still available — as its own function, for the caller to label as
  // a search. Same card, different question.
  assert.ok(
    /\/search\//.test(links.searchUrl({ name: 'Lightning Bolt', game: 'mtg' })),
    'searchUrl still offers a search'
  );
  // But not for a name an English-indexing marketplace cannot match.
  assert.strictEqual(links.searchUrl({ name: '稲妻', game: 'mtg' }), null,
    'a localized-only name cannot be searched, so no search action either');

  // --- 3c. Cardmarket requires a product id --------------------------------
  // Cardmarket has no API and blocks automated requests, so an id is the only
  // evidence a URL points anywhere real.
  assert.strictEqual(
    links.cardmarketUrl({ name: 'Lightning Bolt', cardmarket_url: 'https://www.cardmarket.com/en/Magic/Products?idProduct=665247' }),
    'https://www.cardmarket.com/en/Magic/Products?idProduct=665247'
  );
  assert.strictEqual(
    links.cardmarketUrl({ name: 'Lightning Bolt', cardmarket_url: 'https://www.cardmarket.com/en/Magic/Products/Search?searchString=Lightning+Bolt' }),
    null,
    'a Cardmarket search URL must not be served as the card'
  );
  assert.strictEqual(links.cardmarketUrl({ name: 'Lightning Bolt' }), null);

  // --- 3d. priceSource reads the row, it does not infer --------------------
  assert.strictEqual(
    links.priceSource({ game: 'mtg', language: 'Japanese', price_trend: 12, price_source: 'scryfall', price_currency: 'USD' }),
    null,
    'a TCGplayer USD row needs no label — USD is the display currency'
  );
  // Scryfall quotes two marketplaces; EUR is Cardmarket's number, which is what a
  // non-English Magic printing usually has instead of a TCGplayer one.
  assert.deepStrictEqual(
    links.priceSource({ game: 'mtg', language: 'Japanese', price_trend: 9, price_source: 'scryfall', price_currency: 'EUR' }),
    { name: 'Cardmarket', currency: 'EUR' },
    'a EUR Scryfall price is Cardmarket, not TCGplayer'
  );
  // No price means no source. Labelling a $0.00 asserts a source that never answered.
  assert.strictEqual(
    links.priceSource({ game: 'mtg', language: 'Japanese', price_trend: 0, price_source: 'scryfall', price_currency: 'EUR' }),
    null,
    'an unpriced row must not name a source'
  );

  // --- 4. Zero and null are absent, not a product ---------------------------
  // The backfill CAST yields 0 for a URL with no digits where the id should be;
  // /product/0 is a 404, so a falsy id must never build a link.
  for (const pid of [0, null, undefined, '']) {
    assert.strictEqual(
      links.tcgplayerUrl({ name: '稲妻', tcgplayer_product_id: pid }),
      null,
      `product id ${JSON.stringify(pid)} must not produce a link`
    );
  }

  // --- 5. The backfill extracts the product form and skips the search form ---
  // Same substr/instr/CAST arithmetic as the migration in src/db.js, run through
  // SQLite itself rather than reimplemented in JS — an off-by-one in the skip
  // length is exactly the bug worth catching, and only the real engine proves it.
  const db = require('../src/db');
  await db.initDb();
  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, game, tcgplayer_url) VALUES (?,?,?,?), (?,?,?,?), (?,?,?,?)`,
    [
      'test-mplinks-product', 'Product Form', 'mtg', AFFILIATE_PRODUCT,
      'test-mplinks-search', 'Search Form', 'mtg', AFFILIATE_SEARCH,
      'test-mplinks-plain', 'Plain Form', 'mtg', 'https://www.tcgplayer.com/product/517483',
    ]
  );
  for (const [needle, skip] of [['%2Fproduct%2F', 13], ['/product/', 9]]) {
    await db.run(
      `UPDATE card_cache
          SET tcgplayer_product_id = CAST(substr(tcgplayer_url, instr(tcgplayer_url, ?) + ?) AS INTEGER)
        WHERE tcgplayer_product_id IS NULL
          AND instr(tcgplayer_url, ?) > 0
          AND CAST(substr(tcgplayer_url, instr(tcgplayer_url, ?) + ?) AS INTEGER) > 0`,
      [needle, skip, needle, needle, skip]
    );
  }
  const got = {};
  for (const r of await db.all(`SELECT id, tcgplayer_product_id p FROM card_cache WHERE id LIKE 'test-mplinks-%'`)) {
    got[r.id] = r.p;
  }
  assert.strictEqual(got['test-mplinks-product'], 706216, 'affiliate product URL yields its id');
  assert.strictEqual(got['test-mplinks-plain'], 517483, 'plain product URL yields its id');
  // The search URL contains '%2Fproduct%3F' — one character different from the
  // product form, and the whole reason the two patterns are matched literally
  // instead of by a loose 'product' search.
  assert.strictEqual(got['test-mplinks-search'], null, 'a search URL must extract no id');

  await db.run(`DELETE FROM card_cache WHERE id LIKE 'test-mplinks-%'`);
  console.log('marketplacelinks self-check passed');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
