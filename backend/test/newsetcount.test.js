// newSetCount is the number behind the Admin panel's "N sets not downloaded yet"
// warning, and it used to be a correlated NOT EXISTS over card_cache: one full
// scan of the table per set in `sets`, because LOWER() on both sides of the
// comparison makes idx_card_cache_set_num unusable. With an MTG catalog built
// (1,047 sets, 126k cached rows) that measured 9.6s with 50 sets uncached and 28s
// with 400 — on the app's single sqlite3 connection, so every other request
// queued behind it and the Admin page 504'd, taking Users and the dashboard with
// it. That is #49.
//
// Two things are checked here. The counting rules, which are fiddly enough to
// break silently while still returning a plausible number: the `sets` table
// prefixes ids ("mtg-fdn") and card_cache holds the bare code ("fdn"), the
// comparison is case-insensitive, sets with no printed total do not count, and
// sets already known to have no upstream data (set_data_gaps) are excluded. And
// the cost, with a budget generous enough not to be flaky on a slow runner but
// far below the seconds the old shape took.
//
// No framework — plain node + assert. Run: `node test/newsetcount.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-newsetcount-${process.pid}.db`);
process.env.CV_MODEL_DIR = `${process.env.DB_PATH}.models`;
const db = require('../src/db');
const catalog = require('../src/catalog');
const { newSetCount } = catalog;
const cardSets = require('../src/cardSets');

// Big enough that a per-set scan of card_cache is unmistakably slower than one
// pass, small enough to seed in a second. The real install is 1,047 x 104k.
const NSETS = 300;
const UNCACHED = 60;          // sets with no cards at all -> the answer
const GAPPED = 5;             // of those, known-empty upstream -> excluded
const CARDS = 20000;

async function main() {
  await db.initDb();

  const codes = Array.from({ length: NSETS }, (_, i) => `s${i.toString(36)}`);
  const covered = codes.slice(0, NSETS - UNCACHED);

  await db.withTransaction(async () => {
    for (const c of codes) {
      // Mixed case in the set table, because Scryfall codes are not all lower and
      // the comparison has to survive that.
      await db.run(`INSERT INTO sets (id, name, total, game) VALUES (?, ?, ?, ?)`,
        [`mtg-${c.toUpperCase()}`, `Set ${c}`, 250, 'mtg']);
    }
    // A set with no printed total is not a set anyone can download; it must not
    // be counted as missing.
    await db.run(`INSERT INTO sets (id, name, total, game) VALUES (?, ?, ?, ?)`,
      ['mtg-empty', 'No total', 0, 'mtg']);

    for (let i = 0; i < CARDS; i++) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, ?, ?)`,
        [`mtg-c${i}`, `Card ${i}`, covered[i % covered.length], String(i % 250), 'mtg', 'English']
      );
    }
    // Another game and another language in the same table: neither may be counted,
    // and both are rows the old query scanned on every single set.
    for (let i = 0; i < 2000; i++) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, ?, ?)`,
        [`unsupported-c${i}`, `Card ${i}`, `A${i % 50}`, String(i), 'unsupported', 'English']
      );
    }
    for (const c of codes.slice(NSETS - UNCACHED)) {
      await db.run(
        `INSERT INTO card_cache (id, name, set_id, number, game, language) VALUES (?, ?, ?, ?, ?, ?)`,
        [`mtg-es-${c}`, `Carta ${c}`, c, '1', 'mtg', 'Spanish']
      );
    }
  });

  // 1. The count itself: every set with a printed total and no English cards.
  const t0 = Date.now();
  assert.strictEqual(await newSetCount('mtg', 'English'), UNCACHED,
    'a set with no cards cached in this language is a set not downloaded yet');
  const ms = Date.now() - t0;

  // 2. Cost, which is the actual regression guard: every assertion here passes
  //    against the old query too, because the rewrite changed only how the answer
  //    is computed. On this fixture the old shape measured 1,305ms and the new one
  //    12ms. 500ms sits between them with 40x of slack for a slow runner, and a
  //    real install is 3x the sets and 6x the rows, where the gap is 9.6s vs 80ms.
  assert.ok(ms < 500, `newSetCount took ${ms}ms — the per-set scan of card_cache is back`);

  // 3. Spanish has one card in each of the sets English is missing, and nothing in
  //    the rest. Scoping to the language is the whole reason this takes a `lang`:
  //    measuring Spanish against the English cache reported English's gaps.
  assert.strictEqual(await newSetCount('mtg', 'Spanish'), NSETS - UNCACHED,
    'each language is measured against its own cached cards');

  // 4. Sets a build already found to have no data upstream are not "not downloaded
  //    yet" — they are sets that cannot be downloaded, and counting them told the
  //    user to rebuild forever. Stored lower case; the set table has them upper.
  await db.withTransaction(async () => {
    for (const c of codes.slice(NSETS - UNCACHED, NSETS - UNCACHED + GAPPED)) {
      await db.run(
        `INSERT INTO set_data_gaps (game, language, set_id) VALUES (?, ?, ?)`,
        ['mtg', 'English', c]
      );
    }
  });
  assert.strictEqual(await newSetCount('mtg', 'English'), UNCACHED - GAPPED,
    'a set with no upstream data must not be reported as missing');

  // Unsupported stored identities remain untouched, but cannot become catalogs.
  await assert.rejects(newSetCount('unsupported', 'English'), /Unsupported game/);
  await assert.rejects(catalog.setCounts('unsupported'), /Unsupported game/);
  assert.throws(() => catalog.start('unsupported'), /Unsupported game/);
  assert.throws(() => catalog.binPath('unsupported'), /Unsupported game/);
  assert.throws(() => catalog.metaPath('unsupported'), /Unsupported game/);
  await assert.rejects(cardSets.listAllSets('unsupported'), /Unsupported game/);
  await assert.rejects(cardSets.cacheSetCards('unsupported', 's1'), /Unsupported game/);
  assert.ok((await catalog.list()).every(row => row.game === 'mtg'));
  assert.strictEqual((await db.get("SELECT COUNT(*) n FROM card_cache WHERE game = 'unsupported'")).n, 2000);

  console.log(`newsetcount.test.js: catalog counting and unsupported-game boundaries passed (count took ${ms}ms)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
