const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { gzipSync } = require('zlib');

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-scryfall-catalog-'));
  process.env.DB_PATH = path.join(dir, 'user.db');
  const catalogPath = `${process.env.DB_PATH}.scryfall-bulk.sqlite`;
  const modulePath = require.resolve('../src/scryfallBulk');
  let bulk = require(modulePath);
  const card = (index, overrides = {}) => ({
    object: 'card', id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    name: 'Forest', set: 'abc', collector_number: '1', lang: 'en',
    prices: { usd: '1.23' }, ...overrides
  });
  const cards = [
    card(1),
    card(2, { lang: 'ja' }),
    card(3, { name: 'Fire // Ice', collector_number: '2', card_faces: [{ name: 'Fire' }, { name: 'Ice' }] }),
    card(4, { name: 'Éowyn', set: 'def', collector_number: '4' }),
    card(5, { set: 'xyz', collector_number: '9' }),
    card(6, { name: 'Variant', collector_number: '6' }),
    card(7, { name: 'Variant', collector_number: '7' }),
    card(8, { name: 'Foreign Exclusive', collector_number: '8', lang: 'ja' })
  ];
  let payload = gzipSync(cards.map(raw => JSON.stringify(raw)).join('\n') + '\n');
  let info = {
    object: 'bulk_data', type: 'default_cards', updated_at: '2026-09-22T09:00:00Z',
    jsonl_download_uri: 'https://data.scryfall.io/default-cards/fixture.jsonl.gz',
    compressed_size: payload.length
  };
  let downloads = 0;
  const fakeGet = async url => {
    if (url === '/bulk-data/default_cards') return { data: info };
    assert.strictEqual(url, info.jsonl_download_uri);
    downloads++;
    return { data: Readable.from((function* () {
      for (let offset = 0; offset < payload.length; offset += 37) yield payload.subarray(offset, offset + 37);
    })()) };
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = message => warnings.push(message);
  try {
    const missing = { name: 'Forest', set_id: 'abc', number: '1' };
    bulk.client.get = async () => { throw new Error('Local lookup must not download'); };
    const absent = await bulk.resolveRows([missing]);
    assert.deepStrictEqual(absent.pairs, []);
    assert.strictEqual(absent.unmatchedRows[0], missing);
    assert.ok(warnings.some(message => message.includes('falling back to API')));
    await assert.rejects(fs.access(catalogPath), { code: 'ENOENT' });

    bulk.client.get = fakeGet;
    const first = bulk.refresh();
    assert.strictEqual(bulk.refresh(), first, 'concurrent refreshes share one download/build');
    assert.deepStrictEqual(await first, { updated: true, updated_at: info.updated_at, count: cards.length });
    assert.strictEqual(downloads, 1);
    await assert.rejects(fs.access(process.env.DB_PATH), { code: 'ENOENT' });

    // Reload the module to prove the persisted catalog, not an in-memory map,
    // serves imports and remembers the already downloaded upstream generation.
    delete require.cache[modulePath];
    bulk = require(modulePath);
    bulk.client.get = fakeGet;
    assert.strictEqual((await bulk.refresh()).updated, false);
    assert.strictEqual(downloads, 1);
    assert.strictEqual((await bulk.refresh({ force: true })).updated, true);
    assert.strictEqual(downloads, 2, 'forcing the same generation downloads it again');

    let releaseMetadata;
    bulk.client.get = url => url === '/bulk-data/default_cards'
      ? new Promise(resolve => { releaseMetadata = () => resolve({ data: info }); })
      : fakeGet(url);
    const checking = bulk.refresh();
    const forced = bulk.refresh({ force: true });
    const alsoForced = bulk.refresh({ force: true });
    bulk.client.get = fakeGet;
    releaseMetadata();
    assert.strictEqual((await checking).updated, false);
    assert.strictEqual((await forced).updated, true, 'forced requests must not settle for an unchanged check');
    assert.strictEqual((await alsoForced).updated, true);
    assert.strictEqual(downloads, 3, 'concurrent forced requests share one actual download');

    const beforeForcedFailure = await fs.readFile(catalogPath);
    const goodPayload = payload;
    payload = payload.subarray(0, payload.length - 8);
    await assert.rejects(bulk.refresh({ force: true }));
    assert.deepStrictEqual(await fs.readFile(catalogPath), beforeForcedFailure, 'failed forced download keeps the previous catalog');
    payload = goodPayload;
    bulk.client.get = async () => { throw new Error('Local lookup must work offline'); };
    const hits = [
      { id: `mtg-${cards[1].id}`, name: 'Wrong name', set_id: 'wrong', number: '99' },
      { name: 'Forest', set_id: 'ABC', number: '1' },
      { name: 'Forest', set_id: 'abc', number: '1', language: 'Japanese' },
      { name: 'Ice', set_id: 'abc' },
      { name: 'Fire' },
      { name: 'ÉOWYN' },
      { name: 'Forest', set_id: 'xyz' },
      { name: 'Foreign Exclusive' },
      { name: 'Forest', set_id: 'abc', number: '1', printing: 'Holofoil' }
    ];
    const misses = [
      { id: 'mtg-99999999-9999-9999-9999-999999999999', name: 'Forest', set_id: 'abc', number: '1' },
      { name: 'Forest', set_id: 'wrong', number: '1' },
      { name: 'Forest', set_id: 'abc', number: '999' },
      { name: 'Fores', set_id: 'abc' },
      { name: 'Forest' },
      { name: 'Variant', set_id: 'abc' },
      { name: 'Forest', set_id: 'abc', number: '1', language: 'French' },
      { name: 'Foreign Exclusive', language: 'English' }
    ];
    const matched = await bulk.resolveRows([...hits, ...misses]);
    assert.deepStrictEqual(matched.pairs.map(pair => pair.raw), [cards[1], cards[0], cards[1], cards[2], cards[2], cards[3], cards[4], cards[7], cards[0]]);
    matched.pairs.forEach((pair, index) => assert.strictEqual(pair.row, hits[index]));
    assert.deepStrictEqual(matched.unmatchedRows, misses);
    matched.unmatchedRows.forEach((row, index) => assert.strictEqual(row, misses[index]));

    bulk.client.get = fakeGet;
    const published = await fs.readFile(catalogPath);
    info = { ...info, updated_at: '2026-09-23T09:00:00Z' };
    const validGzip = payload;
    for (const invalid of [
      validGzip.subarray(0, validGzip.length - 8), // complete JSON but missing gzip trailer
      gzipSync(`${JSON.stringify(cards[0])}\n{broken JSON}\n`),
      gzipSync(''),
      gzipSync('{"object":"card"}\n')
    ]) {
      payload = invalid;
      info.compressed_size = payload.length;
      await assert.rejects(bulk.refresh());
      assert.deepStrictEqual(await fs.readFile(catalogPath), published, 'failed refresh preserves the published catalog byte for byte');
      assert.strictEqual((await bulk.resolveRows([missing])).pairs[0].raw.id, cards[0].id);
    }
    info.jsonl_download_uri = 'https://example.com/default-cards/fixture.jsonl.gz';
    const beforeUntrusted = downloads;
    await assert.rejects(bulk.refresh(), /Untrusted/);
    assert.strictEqual(downloads, beforeUntrusted, 'untrusted metadata URL is never requested');

    // A subsequent successful refresh replaces the old generation and readers
    // open the new file rather than a retained connection to the old catalog.
    const newer = card(9, { prices: { usd: '9.87' } });
    payload = gzipSync(JSON.stringify(newer) + '\n');
    info = { ...info, jsonl_download_uri: 'https://data.scryfall.io/default-cards/fixture.jsonl.gz', compressed_size: payload.length };
    const reading = bulk.resolveRows(Array(200).fill(missing));
    assert.strictEqual((await bulk.refresh()).updated, true);
    const duringReplacement = await reading;
    assert.strictEqual(duringReplacement.pairs.length, 200, 'replacement does not close an active reader');
    assert.strictEqual(new Set(duringReplacement.pairs.map(pair => pair.raw.id)).size, 1, 'one lookup uses one catalog generation');
    assert.deepStrictEqual((await bulk.resolveRows([missing])).pairs[0].raw, newer);
    await fs.writeFile(catalogPath, 'not a SQLite catalog');
    const corrupted = await bulk.resolveRows([missing]);
    assert.deepStrictEqual(corrupted.pairs, []);
    assert.strictEqual(corrupted.unmatchedRows[0], missing);
    assert.strictEqual((await bulk.refresh()).updated, true, 'same upstream generation repairs corrupt local storage');
    assert.deepStrictEqual((await bulk.resolveRows([missing])).pairs[0].raw, newer);
    assert.deepStrictEqual(await fs.readdir(dir), [path.basename(catalogPath)], 'temporary builds are cleaned on success and failure');
  } finally {
    console.warn = originalWarn;
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log('Scryfall persistent bulk catalog self-check passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
