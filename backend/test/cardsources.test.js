// Regression test for issue #29: the global MTG index build died with
// `TypeError: Invalid URL` because Scryfall's /bulk-data entries dropped
// `download_uri`/`size` in favour of `jsonl_download_uri`/`compressed_size`, so
// axios was handed `undefined` as a URL. Covers the field resolution, the
// gzip-vs-plain sniff, and a full gatherMtg run against today's schema.
// No framework — plain node + assert. Run: `node test/cardsources.test.js`
const assert = require('assert');
const zlib = require('zlib');
const { Readable } = require('stream');

const { makeHttp, gatherMtg, resolveBulkEntry, streamCardObjects } = require('../scripts/cardSources');

// The shape Scryfall actually returns today (trimmed to the relevant fields).
const CURRENT_INDEX = [
  { object: 'bulk_data', type: 'oracle_cards', jsonl_download_uri: 'https://data.scryfall.io/oracle-cards/x.jsonl.gz', compressed_size: 24502774 },
  { object: 'bulk_data', type: 'unique_artwork', jsonl_download_uri: 'https://data.scryfall.io/unique-artwork/y.jsonl.gz', compressed_size: 37377979 },
  { object: 'bulk_data', type: 'default_cards', jsonl_download_uri: 'https://data.scryfall.io/default-cards/z.jsonl.gz', compressed_size: 99 },
];

// The shape it returned before the rename, which must still work.
const LEGACY_INDEX = [
  { object: 'bulk_data', type: 'unique_artwork', download_uri: 'https://archive.scryfall.com/json/old.json', size: 1234567 },
];

const CARDS = [
  { name: 'Sol Ring', set: 'ltr', collector_number: '123', image_uris: { normal: 'https://img/sol-normal.jpg', small: 'https://img/sol-small.jpg' } },
  // No top-level image_uris: a modal DFC contributes one row per face.
  { name: 'Brutal Cathar // Moonrage Brute', set: 'mid', collector_number: '7', card_faces: [
    { image_uris: { normal: 'https://img/cathar-a.jpg' } },
    { image_uris: { normal: 'https://img/cathar-b.jpg' } },
  ] },
  // Duplicate image URL — must be deduped away.
  { name: 'Sol Ring', set: 'ltr', collector_number: '123', image_uris: { normal: 'https://img/sol-normal.jpg' } },
  // Only `small` available: still usable.
  { name: 'Opt', set: 'dmu', collector_number: '58', image_uris: { small: 'https://img/opt-small.jpg' } },
  // No images at all: contributes nothing rather than an undefined img.
  { name: 'Placeholder', set: 'xxx', collector_number: '1' },
];

const jsonl = (cards) => cards.map(c => JSON.stringify(c)).join('\n') + '\n';

// An axios adapter serving the bulk index and the bulk file. `body` is whatever
// bytes the file download should produce, so a test can hand over gzip or plain.
function stubAdapter(index, body) {
  return async (config) => {
    const ok = (data) => ({ status: 200, statusText: 'OK', headers: {}, config, data });
    if (config.url.includes('/bulk-data')) return ok({ object: 'list', data: index });
    return ok(Readable.from([Buffer.from(body)]));
  };
}

function httpWith(index, body) {
  const http = makeHttp();
  http.defaults.adapter = stubAdapter(index, body);
  return http;
}

async function collect(gen) { const out = []; for await (const x of gen) out.push(x); return out; }

async function main() {
  // 1. Today's schema resolves to the JSONL URL and the compressed size.
  //    Before the fix both of these came back undefined.
  let r = resolveBulkEntry(CURRENT_INDEX, 'unique_artwork');
  assert.strictEqual(r.url, 'https://data.scryfall.io/unique-artwork/y.jsonl.gz');
  assert.strictEqual(r.bytes, 37377979);
  assert.strictEqual(r.urlField, 'jsonl_download_uri');

  // 2. The pre-rename schema still resolves, so a Scryfall revert won't break us.
  r = resolveBulkEntry(LEGACY_INDEX, 'unique_artwork');
  assert.strictEqual(r.url, 'https://archive.scryfall.com/json/old.json');
  assert.strictEqual(r.bytes, 1234567);
  assert.strictEqual(r.urlField, 'download_uri');

  // 3. A future rename must produce an actionable error naming both what we
  //    looked for and what was actually there — not `TypeError: Invalid URL`.
  assert.throws(
    () => resolveBulkEntry([{ type: 'unique_artwork', future_uri: 'https://x', future_size: 1 }], 'unique_artwork'),
    (e) => {
      assert.match(e.message, /jsonl_download_uri or download_uri/, 'names the fields we looked for');
      assert.match(e.message, /future_uri/, 'names the keys the entry actually had');
      assert.ok(!/Invalid URL/.test(e.message), 'must not be the opaque axios error');
      return true;
    },
  );

  // 4. A missing entry type reports what the index did contain.
  assert.throws(
    () => resolveBulkEntry(CURRENT_INDEX, 'rulings'),
    (e) => { assert.match(e.message, /no 'rulings' entry.*unique_artwork/s); return true; },
  );

  // 5. A malformed index is a clear error, not a crash on undefined.
  assert.throws(() => resolveBulkEntry(undefined, 'unique_artwork'), /saw: nothing/);

  // 6. Gzipped JSONL streams and parses — the format Scryfall now serves, with
  //    `Content-Type: application/gzip` and no `Content-Encoding` to trigger any
  //    automatic decompression.
  let http = httpWith(CURRENT_INDEX, zlib.gzipSync(Buffer.from(jsonl(CARDS))));
  let objs = await collect(streamCardObjects(http, 'https://data.scryfall.io/x.jsonl.gz'));
  assert.strictEqual(objs.length, CARDS.length);
  assert.strictEqual(objs[0].name, 'Sol Ring');

  // 7. Plain (un-gzipped) JSONL works too — the sniff is on magic bytes, not the
  //    filename or the URL.
  http = httpWith(CURRENT_INDEX, jsonl(CARDS));
  objs = await collect(streamCardObjects(http, 'https://data.scryfall.io/x.jsonl'));
  assert.strictEqual(objs.length, CARDS.length);

  // 8. The legacy single-JSON-array file parses as well: Scryfall wrote one
  //    object per line inside the brackets, so stripping them is enough.
  const arrayBody = '[\n' + CARDS.map(c => JSON.stringify(c)).join(',\n') + '\n]\n';
  http = httpWith(LEGACY_INDEX, arrayBody);
  objs = await collect(streamCardObjects(http, 'https://archive.scryfall.com/json/old.json'));
  assert.strictEqual(objs.length, CARDS.length);

  // 9. End to end: the exact call that threw in issue #29 now returns rows.
  http = httpWith(CURRENT_INDEX, zlib.gzipSync(Buffer.from(jsonl(CARDS))));
  const rows = await gatherMtg(http);
  const imgs = rows.map(x => x.img);
  assert.deepStrictEqual(imgs, [
    'https://img/sol-normal.jpg',   // `normal` preferred over `small`
    'https://img/cathar-a.jpg',     // one row per DFC face...
    'https://img/cathar-b.jpg',     // ...so either side scans
    'https://img/opt-small.jpg',    // `small` when that is all there is
  ], 'duplicate art deduped, imageless card dropped');
  assert.deepStrictEqual(rows[0], { name: 'Sol Ring', set: 'ltr', number: '123', img: 'https://img/sol-normal.jpg' });
  // A DFC's faces keep the card's identity so ORB verify can test each side.
  assert.strictEqual(rows[1].set, 'mid');
  assert.strictEqual(rows[1].number, '7');

  // 10. An empty stream is an explicit failure. Silently returning [] is how a
  //     build "succeeds" and then clobbers a working index with 0 cards.
  http = httpWith(CURRENT_INDEX, zlib.gzipSync(Buffer.from('')));
  await assert.rejects(() => gatherMtg(http), /yielded no cards/);

  console.log('cardsources.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
