// ManaBox plaintext must preserve the exact set/collector printing needed for Scryfall.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseManaboxText } = require('../src/utils/csvMappers');

const cards = parseManaboxText(fs.readFileSync(path.join(__dirname, 'fixtures', 'manabox-collection.txt'), 'utf8'));
const card = (set, number, printing = 'Normal') => cards.find(c =>
  c.set_code === set && c.collector_number === number && c.printing === printing
);

assert.deepStrictEqual(card('PLS', '58'), {
  name: 'Caldera Kavu',
  set_code: 'PLS',
  collector_number: '58',
  quantity: 2,
  condition: 'Near Mint',
  printing: 'Normal',
  game: 'mtg'
});
assert.strictEqual(card('POR', '118').printing, 'Normal', 'non-foil annotation must not make a card foil');
assert.strictEqual(card('7ED', '339', 'Holofoil').quantity, 1, 'ManaBox foil markers must be retained');
assert.ok(cards.length > 0, 'the supplied ManaBox export must yield cards');
assert.deepStrictEqual(
  parseManaboxText('1 Spider-Suit (SPM) 176\n1 Spider-Suit (SPM) 176 *F*').map(item => item.printing),
  ['Normal', 'Holofoil'],
  'mixed foil copies must remain separate'
);

async function testImportRoute() {
  const os = require('os');
  const tmpDb = path.join(os.tmpdir(), `manafolio-manabox-test-${process.pid}.db`);
  process.env.DB_PATH = tmpDb;
  process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

  const db = require('../src/db');
  const scryfallApi = require('../src/scryfallApi');
  const importRouter = require('../src/routes/importExport');
  const previewHandler = importRouter.stack.find(layer => layer.route?.path === '/import/preview').route.stack[0].handle;
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  const originalCacheCards = scryfallApi.cacheCards;
  const originalAdapter = scryfallApi.client.defaults.adapter;
  const importHandler = importRouter.stack.find(layer => layer.route?.path === '/import').route.stack.at(-1).handle;
  const handler = (req, res) => importHandler({ ...req, accepts: () => 'application/json' }, res);

  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-00000000-0000-4000-8000-000000000031', 'Caldera Kavu', 'mtg']);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-00000000-0000-4000-8000-000000000032', 'Mountain', 'mtg']);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-00000000-0000-4000-8000-000000000033', 'Spider-Suit', 'mtg']);

    let cachedCards = [];
    let bulkCalls = [];
    const resolvedCard = (row) => ({
      id: row.name === 'Caldera Kavu' ? 'mtg-00000000-0000-4000-8000-000000000031'
        : row.name === 'Spider-Suit' ? 'mtg-00000000-0000-4000-8000-000000000033'
          : row.name === 'Mountain' ? 'mtg-00000000-0000-4000-8000-000000000032'
            : `mtg-${row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      name: row.name,
      game: 'mtg',
      image_url: `https://images.example/${row.name.toLowerCase().replace(/\s+/g, '-')}.jpg`
    });
    scryfallApi.bulkFetchByIdentifier = async (rows) => {
      bulkCalls.push(rows);
      return { cards: rows.map(resolvedCard), pairs: rows.map(row => ({ row, card: resolvedCard(row) })) };
    };
    scryfallApi.cacheCards = async (cards) => {
      cachedCards = cards;
      for (const card of cards) {
        await db.run(`INSERT OR IGNORE INTO card_cache (id, name, game, image_url) VALUES (?, ?, ?, ?)`, [card.id, card.name, card.game, card.image_url]);
        await db.run(`UPDATE card_cache SET image_url = ?, finishes = '["nonfoil","foil"]', promo_types = '[]' WHERE id = ?`, [card.image_url, card.id]);
      }
    };

    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    const preview = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    const data = '2 Caldera Kavu (PLS) 58\n1 Mountain (7ED) 339★ *F*\n1 Spider-Suit (SPM) 176\n1 Spider-Suit (SPM) 176 *F*';
    await previewHandler({ body: { format: 'manabox', data } }, preview);
    assert.deepStrictEqual(preview.body, { printings: 4, cards: 5, normal: 3, foils: 2 });
    await handler({
      body: { format: 'manabox', data },
      user: { id: 1 }
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.count, 4);
    assert.deepStrictEqual(await db.all(
      `SELECT card_id, quantity, printing, game FROM collection ORDER BY card_id, printing`
    ), [
      { card_id: 'mtg-00000000-0000-4000-8000-000000000031', quantity: 2, printing: 'Normal', game: 'mtg' },
      { card_id: 'mtg-00000000-0000-4000-8000-000000000032', quantity: 1, printing: 'Holofoil', game: 'mtg' },
      { card_id: 'mtg-00000000-0000-4000-8000-000000000033', quantity: 1, printing: 'Holofoil', game: 'mtg' },
      { card_id: 'mtg-00000000-0000-4000-8000-000000000033', quantity: 1, printing: 'Normal', game: 'mtg' }
    ]);
    const csvRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({
      body: { format: 'csv', data: 'Name,Set code,Card number,Quantity,Condition,Foil\nCaldera Kavu,PLS,58,1,near_mint,false' },
      user: { id: 1 }
    }, csvRes);
    assert.strictEqual(csvRes.statusCode, 200);
    assert.strictEqual(csvRes.body.count, 1);
    assert.deepStrictEqual(cachedCards, [{ id: 'mtg-00000000-0000-4000-8000-000000000031', name: 'Caldera Kavu', game: 'mtg', image_url: 'https://images.example/caldera-kavu.jpg' }]);
    assert.strictEqual((await db.get('SELECT image_url FROM card_cache WHERE id = ?', ['mtg-00000000-0000-4000-8000-000000000031'])).image_url, 'https://images.example/caldera-kavu.jpg');
    const arenaRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({
      body: { format: 'manabox', data: '1 Caldera Kavu (PLS) 58', list_type: 'arena' },
      user: { id: 1 }
    }, arenaRes);
    assert.strictEqual(arenaRes.statusCode, 200);
    assert.strictEqual((await db.get(`SELECT list_type FROM collection WHERE card_id = ? ORDER BY id DESC LIMIT 1`, ['mtg-00000000-0000-4000-8000-000000000031'])).list_type, 'arena');
    const manafolioCsv = [
      '"Card ID","Name","Set Name","Set ID","Card Number","Quantity","Condition","Printing","Language","Purchase Price","Game"',
      '"mtg-arena-comber","A-Brine Comber","","VOW","","1","Near Mint","Normal","English","0","mtg"',
      '"mtg-arena-lancer","A-Cobbled Lancer","","VOW","","1","Near Mint","Normal","English","0","mtg"',
      '"mtg-arena-charger","A-Cosmos Charger","","KHM","","1","Near Mint","Normal","English","0","mtg"'
    ].join('\n');
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)`, ['mtg-a-brine-comber', 'Stale CSV card', 'mtg']);
    const manafolioCsvRes = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({
      body: { format: 'internal', data: manafolioCsv, list_type: 'collection' },
      user: { id: 1 }
    }, manafolioCsvRes);
    assert.strictEqual(manafolioCsvRes.statusCode, 200);
    assert.strictEqual(manafolioCsvRes.body.count, 3);
    assert.deepStrictEqual(manafolioCsvRes.body.summary, {
      added: {
        cards: 3,
        copies: 3,
        items: [
          { name: 'A-Brine Comber', quantity: 1 },
          { name: 'A-Cobbled Lancer', quantity: 1 },
          { name: 'A-Cosmos Charger', quantity: 1 }
        ]
      },
      failed: { cards: 0, copies: 0, items: [] }
    });
    assert.deepStrictEqual(await db.get(
      `SELECT card_id, quantity, list_type, game FROM collection WHERE card_id = ?`,
      ['mtg-a-brine-comber']
    ), {
      card_id: 'mtg-a-brine-comber',
      quantity: 1,
      list_type: 'collection',
      game: 'mtg'
    });
    assert.strictEqual((await db.get(`SELECT game FROM card_cache WHERE id = ?`, ['mtg-a-brine-comber'])).game, 'mtg');
    assert.deepStrictEqual(bulkCalls.at(-1).map(row => [row.name, row.set_id, row.number]), [
      ['A-Brine Comber', 'VOW', undefined],
      ['A-Cobbled Lancer', 'VOW', undefined],
      ['A-Cosmos Charger', 'KHM', undefined]
    ]);
    const arenaCsv = [
      'Count,Name,Edition,Collector Number,Condition,Language,Foil,Tag',
      '1,A-Brine Comber,VOW,,Near Mint,English,,',
      '1,A-Cobbled Lancer,VOW,,Near Mint,English,,',
      '1,A-Cosmos Charger,KHM,,Near Mint,English,,'
    ].join('\n');
    const arenaPreview = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await previewHandler({ body: { format: 'internal', data: arenaCsv } }, arenaPreview);
    assert.strictEqual(arenaPreview.body.cards, 3);
    assert.strictEqual(arenaPreview.body.quantity, 3);
    assert.deepStrictEqual(arenaPreview.body.errors, []);
    assert.deepStrictEqual(arenaPreview.body.headers, ['Count', 'Name', 'Edition', 'Collector Number', 'Condition', 'Language', 'Foil', 'Tag']);
    const arenaImport = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { format: 'internal', data: arenaCsv, list_type: 'arena' }, user: { id: 1 } }, arenaImport);
    assert.strictEqual(arenaImport.body.count, 3);
    assert.deepStrictEqual(bulkCalls.at(-1).map(row => [row.name, row.set_id, row.number]), [
      ['A-Brine Comber', 'VOW', ''],
      ['A-Cobbled Lancer', 'VOW', ''],
      ['A-Cosmos Charger', 'KHM', '']
    ]);
    assert.strictEqual((await db.get(`SELECT list_type FROM collection WHERE card_id = ? ORDER BY id DESC LIMIT 1`, ['mtg-a-brine-comber'])).list_type, 'arena');
    const mappedCsv = 'Copies,Title,Expansion,No.,Finish\n2,Caldera Kavu,PLS,58,Foil';
    const mapping = { quantity: 'Copies', name: 'Title', set_code: 'Expansion', collector_number: 'No.', printing: 'Finish' };
    const mappedPreview = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await previewHandler({ body: { format: 'internal', data: mappedCsv, mapping } }, mappedPreview);
    assert.deepStrictEqual(mappedPreview.body, {
      headers: ['Copies', 'Title', 'Expansion', 'No.', 'Finish'],
      cards: 1,
      quantity: 2,
      errors: []
    });
    const mappedImport = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { format: 'internal', data: mappedCsv, mapping }, user: { id: 1 } }, mappedImport);
    assert.deepStrictEqual(mappedImport.body.summary.added, {
      cards: 1,
      copies: 2,
      items: [{ name: 'Caldera Kavu', quantity: 2 }]
    });
    assert.deepStrictEqual(bulkCalls.at(-1).map(row => [row.name, row.set_id, row.number, row.printing]), [['Caldera Kavu', 'PLS', '58', 'Holofoil']]);
    const englishId = 'mtg-00000000-0000-4000-8000-000000000031';
    const germanId = 'mtg-00000000-0000-4000-8000-000000000034';
    await db.run(`UPDATE card_cache SET language = 'English', set_id = 'pls', number = '58' WHERE id = ?`, [englishId]);
    await db.run(`INSERT INTO card_cache (id, name, game, language, printed_name, set_id, number)
      VALUES (?, 'Caldera Kavu', 'mtg', 'German', 'Caldera-Kavu', 'pls', '58')`, [germanId]);
    await db.run(`INSERT INTO card_cache (id, name, game, language, set_id, number)
      VALUES ('mtg-historical-kavu', 'Caldera Kavu', 'mtg', 'English', 'pls', '58')`);
    scryfallApi.bulkFetchByIdentifier = async rows => {
      const card = await db.get('SELECT * FROM card_cache WHERE id = ?', [englishId]);
      return { cards: [card], pairs: rows.map(row => ({ row, card })) };
    };
    const languageRequests = [];
    scryfallApi.client.defaults.adapter = async config => {
      languageRequests.push(config.url);
      assert.strictEqual(config.url, '/cards/pls/58/fr');
      throw Object.assign(new Error('Printing unavailable'), { response: { status: 404 } });
    };
    const importLanguage = async (format, data, expectedId, language, printing) => {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ body: { format, data }, user: { id: 1 } }, response);
      assert.strictEqual(response.statusCode, 200, JSON.stringify(response.body));
      assert.deepStrictEqual(await db.get('SELECT card_id, language, printing FROM collection ORDER BY id DESC LIMIT 1'),
        { card_id: expectedId, language, printing });
    };
    for (const printing of ['Normal', 'Holofoil']) {
      const headers = 'Card ID,Name,Set ID,Card Number,Quantity,Printing,Language\n';
      await importLanguage('internal', `${headers},Caldera Kavu,PLS,58,1,${printing},German`, germanId, 'German', printing);
      await importLanguage('internal', `${headers},Caldera Kavu,PLS,58,1,${printing},French`, englishId, 'French', printing);
      await importLanguage('csv', `Name,Set code,Card number,Quantity,Foil,Language\nCaldera Kavu,PLS,58,1,${printing === 'Holofoil'},German`,
        germanId, 'German', printing);
      await importLanguage('internal', `${headers}${englishId},Caldera Kavu,PLS,58,1,${printing},German`, englishId, 'German', printing);
      await importLanguage('json', [{ card_id: englishId, name: 'Caldera Kavu', quantity: 1, printing, language: 'German' }],
        englishId, 'German', printing);
      await importLanguage('json', [{ card_id: 'mtg-historical-kavu', name: 'Caldera Kavu', quantity: 1, printing, language: 'German' }],
        'mtg-historical-kavu', 'German', printing);
    }
    assert.deepStrictEqual(languageRequests, ['/cards/pls/58/fr', '/cards/pls/58/fr'],
      'unavailable translations keep the resolved printing; explicit UUIDs and JSON identities are not translated');
    scryfallApi.bulkFetchByIdentifier = async rows => {
      const card = resolvedCard(rows[0]);
      return {
        cards: [card],
        pairs: [{ row: rows[0], card }],
        unmatchedRows: rows.slice(1)
      };
    };
    const partialImport = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({
      body: { format: 'manabox', data: '2 Caldera Kavu (PLS) 58\n1 Not A Card (ABC) 1', list_type: 'collection' },
      user: { id: 1 }
    }, partialImport);
    assert.deepStrictEqual(partialImport.body.summary, {
      added: { cards: 1, copies: 2, items: [{ name: 'Caldera Kavu', quantity: 2 }] },
      failed: { cards: 1, copies: 1, items: [{ name: 'Not A Card', quantity: 1, set_code: 'ABC', collector_number: '1' }] }
    });
    const csvPreview = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await previewHandler({ body: { format: 'internal', data: manafolioCsv } }, csvPreview);
    assert.strictEqual(csvPreview.body.cards, 3);
    assert.strictEqual(csvPreview.body.quantity, 3);
    assert.deepStrictEqual(csvPreview.body.errors, []);
    const invalidPreview = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
    await previewHandler({ body: { format: 'internal', data: 'Card ID,Name,Quantity\n,,1' } }, invalidPreview);
    assert.deepStrictEqual(invalidPreview.body.errors, ['Row 2: Name is required.']);
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    scryfallApi.cacheCards = originalCacheCards;
    scryfallApi.client.defaults.adapter = originalAdapter;
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testImportRoute()
  .then(() => console.log('ManaBox parser and import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
