const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');

const tmpDb = path.join(os.tmpdir(), `manafolio-deck-record-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const deckRouter = require('../src/routes/decks');

async function request(method, route, id, body = {}, userId = 1) {
  const handler = deckRouter.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack[0].handle;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler({ params: { id }, body, user: { id: userId } }, res);
  return res;
}
const record = (id, result, delta = 1, userId = 1) => request('patch', '/:id/record', id, { result, delta }, userId);
const counts = id => db.get('SELECT wins, losses FROM decks WHERE id = ?', [id]);

async function testRecord() {
  try {
    // Start with the pre-record schema and a real saved deck to exercise upgrades.
    await db.run(`CREATE TABLE decks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT, checked_out INTEGER DEFAULT 0, checked_out_at DATETIME,
      game TEXT DEFAULT 'mtg', inventory_type TEXT DEFAULT 'collection', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const physical = (await db.run(`INSERT INTO decks (name, description, user_id, checked_out, checked_out_at) VALUES ('Physical', 'Existing description', 1, 1, '2026-09-22')`)).lastID;
    await db.run(`CREATE TABLE notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT DEFAULT '', body TEXT DEFAULT '',
      pinned INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run("INSERT INTO notes (user_id, title, body, pinned) VALUES (1, 'Legacy note', 'Keep this standalone note', 1)");
    const standaloneNotes = await db.all('SELECT * FROM notes');
    await db.initDb();
    assert.deepStrictEqual(await db.get('SELECT notes, description FROM decks WHERE id = ?', [physical]),
      { notes: '', description: 'Existing description' }, 'upgrades add empty notes without repurposing description');
    assert.deepStrictEqual(await db.all('SELECT * FROM notes'), standaloneNotes, 'migration preserves standalone notes unchanged');
    assert.deepStrictEqual(await counts(physical), { wins: 0, losses: 0 });
    assert.strictEqual((await db.get('SELECT sleeved FROM decks WHERE id = ?', [physical])).sleeved, 0, 'upgraded decks start unsleeved');
    assert.deepStrictEqual(await db.get('SELECT card_back_color, card_back_image FROM decks WHERE id = ?', [physical]),
      { card_back_color: null, card_back_image: null }, 'upgraded decks use the default back');
    const created = await request('post', '/', null, { name: 'Arena', inventory_type: 'arena' });
    assert.strictEqual(created.statusCode, 201);
    const arena = created.body.id;
    assert.deepStrictEqual(await counts(arena), { wins: 0, losses: 0 });
    const legacy = (await db.run(`INSERT INTO decks (name, game, user_id) VALUES ('Legacy', 'unsupported', 1)`)).lastID;
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('record-card', 'Record Card', 'mtg')`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (?, 'record-card', 2, 1)`, [physical]);
    const metadataBefore = await db.get('SELECT * FROM decks WHERE id = ?', [physical]);
    const cardsBefore = await db.all('SELECT * FROM deck_cards');

    assert.strictEqual((await record(physical, 'win', -1)).statusCode, 400);
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => record(physical, 'win')));
    assert.ok(concurrent.every(res => res.statusCode === 200));
    assert.deepStrictEqual(concurrent.map(res => res.body.wins).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1), 'atomic responses must represent every increment exactly once');
    assert.deepStrictEqual((await record(physical, 'loss')).body, { wins: 20, losses: 1 });
    assert.deepStrictEqual((await record(physical, 'win', -1)).body, { wins: 19, losses: 1 });
    assert.deepStrictEqual((await record(arena, 'loss')).body, { wins: 0, losses: 1 });
    assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [physical]), { ...metadataBefore, wins: 19, losses: 1 }, 'recording must not alter metadata or checkout state');
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards'), cardsBefore);

    const beforeInvalid = await counts(physical);
    for (const body of [null, [], {}, { result: 'draw', delta: 1 }, { result: 'win', delta: '1' }, { result: 'win', delta: true }, { result: 'win', delta: 0 }, { result: 'win', delta: 0.5 }, { result: ['win'], delta: 1 }, { result: 'win', delta: 1, wins: 100 }]) {
      assert.strictEqual((await request('patch', '/:id/record', physical, body)).statusCode, 400);
    }
    assert.strictEqual((await record(physical, 'win', 1, 2)).statusCode, 404);
    assert.strictEqual((await record(physical, 'loss', -1, 2)).statusCode, 404);
    assert.strictEqual((await record(legacy, 'win')).statusCode, 404);
    assert.strictEqual((await record(999999, 'win')).statusCode, 404);
    assert.deepStrictEqual(await counts(physical), beforeInvalid);
    assert.deepStrictEqual(await counts(legacy), { wins: 0, losses: 0 });

    const listed = await request('get', '/', null);
    assert.deepStrictEqual(listed.body.map(deck => [deck.id, deck.wins, deck.losses]).sort((a, b) => a[0] - b[0]), [[physical, 19, 1], [arena, 0, 1]]);
    const detail = await request('get', '/:id', physical);
    assert.deepStrictEqual([detail.body.wins, detail.body.losses], [19, 1]);
    const duplicate = await request('post', '/:id/duplicate', physical);
    assert.strictEqual(duplicate.statusCode, 201);
    assert.deepStrictEqual(await counts(duplicate.body.id), { wins: 0, losses: 0 }, 'a copy starts its own record');
    assert.deepStrictEqual(await counts(physical), { wins: 19, losses: 1 });

    await db.run('UPDATE decks SET losses = 2147483646 WHERE id = ?', [arena]);
    const upper = await Promise.all([record(arena, 'loss'), record(arena, 'loss')]);
    assert.deepStrictEqual(upper.map(res => res.statusCode).sort(), [200, 400]);
    assert.deepStrictEqual(await counts(arena), { wins: 0, losses: 2147483647 });
    const lower = await Promise.all([record(physical, 'loss', -1), record(physical, 'loss', -1)]);
    assert.deepStrictEqual(lower.map(res => res.statusCode).sort(), [200, 400]);
    assert.deepStrictEqual(await counts(physical), { wins: 19, losses: 0 });
    const beforeSleeves = await db.get('SELECT * FROM decks WHERE id = ?', [physical]);
    const beforeSleeveCards = await db.all('SELECT * FROM deck_cards ORDER BY deck_id, card_id');
    for (const sleeved of [1, 2, 0, 3]) {
      const response = await request('patch', '/:id/sleeved', physical, { sleeved });
      assert.strictEqual(response.statusCode, 200);
      assert.deepStrictEqual(response.body, { sleeved });
      assert.strictEqual((await request('get', '/:id', physical)).body.sleeved, sleeved);
    }
    for (const body of [null, [], {}, { sleeved: -1 }, { sleeved: 4 }, { sleeved: 1.5 }, { sleeved: '1' }, { sleeved: true }, { sleeved: null }, { sleeved: 2, user_id: 2 }]) {
      assert.strictEqual((await request('patch', '/:id/sleeved', physical, body)).statusCode, 400);
    }
    assert.strictEqual((await request('patch', '/:id/sleeved', physical, { sleeved: 0 }, 2)).statusCode, 404);
    assert.strictEqual((await request('patch', '/:id/sleeved', legacy, { sleeved: 1 })).statusCode, 404);
    assert.strictEqual((await request('patch', '/:id/sleeved', 999999, { sleeved: 1 })).statusCode, 404);
    assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [physical]), { ...beforeSleeves, sleeved: 3 }, 'sleeves only change the owned deck sleeve state');
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards ORDER BY deck_id, card_id'), beforeSleeveCards);
    assert.strictEqual((await request('get', '/', null)).body.find(deck => deck.id === physical).sleeved, 3);
    assert.strictEqual((await request('get', '/:id', arena)).body.sleeved, 0, 'other decks keep their own selection');
    const sleevedCopy = await request('post', '/:id/duplicate', physical);
    assert.strictEqual(sleevedCopy.statusCode, 201);
    assert.strictEqual((await request('get', '/:id', sleevedCopy.body.id)).body.sleeved, 3);
    await db.initDb();
    const reloaded = new sqlite3.Database(tmpDb);
    try {
      const persisted = await new Promise((resolve, reject) => reloaded.get('SELECT wins, losses FROM decks WHERE id = ?', [physical], (error, row) => error ? reject(error) : resolve(row)));
      assert.deepStrictEqual(persisted, { wins: 19, losses: 0 }, 'records survive initialization and a fresh database connection');
      const sleeves = await new Promise((resolve, reject) => reloaded.get('SELECT sleeved FROM decks WHERE id = ?', [physical], (error, row) => error ? reject(error) : resolve(row)));
      assert.strictEqual(sleeves.sleeved, 3, 'sleeves survive initialization and a fresh database connection');
    } finally {
      await new Promise(resolve => reloaded.close(resolve));
    }
    const beforeBack = await db.get('SELECT * FROM decks WHERE id = ?', [physical]);
    const back = body => request('patch', '/:id/card-back', physical, body);
    assert.deepStrictEqual((await back({ color: '#aBc123', image: null })).body, { card_back_color: '#ABC123', card_back_image: null });
    assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [physical]),
      { ...beforeBack, card_back_color: '#ABC123' }, 'card backs leave draft content, sleeves and records untouched');
    for (const body of [null, [], {}, { color: '#fff', image: null }, { color: 1, image: null },
      { color: null }, { color: '#abcdef', image: 'x' }, { color: null, image: null, user_id: 2 },
      { color: null, image: 'https://example.com/back.png' }, { color: null, image: 'data:image/png;base64,YmFk' },
      { color: null, image: 'data:image/svg+xml;base64,PHN2Zy8+' }, { color: null, image: 'x'.repeat(700001) }]) {
      assert.strictEqual((await back(body)).statusCode, 400);
    }
    assert.strictEqual((await request('patch', '/:id/card-back', physical, { color: null, image: null }, 2)).statusCode, 404);
    assert.strictEqual((await request('patch', '/:id/card-back', legacy, { color: null, image: null })).statusCode, 404);
    const sharp = require('sharp');
    for (const format of ['png', 'jpeg', 'webp']) {
      const input = await sharp({ create: { width: 976, height: 1360, channels: 3, background: '#123456' } }).toFormat(format).toBuffer();
      const saved = await back({ color: null, image: `data:image/${format};base64,${input.toString('base64')}` });
      assert.strictEqual(saved.statusCode, 200);
      assert.strictEqual(saved.body.card_back_color, null);
      const metadata = await sharp(Buffer.from(saved.body.card_back_image.split(',')[1], 'base64')).metadata();
      assert.deepStrictEqual([metadata.format, metadata.width, metadata.height], ['webp', 488, 680]);
      assert.strictEqual((await request('get', '/:id', physical)).body.card_back_image, saved.body.card_back_image);
    }
    const oversized = await sharp({ create: { width: 5001, height: 4000, channels: 3, background: '#123456' } }).png().toBuffer();
    assert.strictEqual((await back({ color: null, image: `data:image/png;base64,${oversized.toString('base64')}` })).statusCode, 400);
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#123456' } }).png().toBuffer();
    assert.strictEqual((await back({ color: null, image: `data:image/jpeg;base64,${png.toString('base64')}` })).statusCode, 400);
    const customCopy = await request('post', '/:id/duplicate', physical);
    assert.strictEqual((await request('get', '/:id', customCopy.body.id)).body.card_back_image,
      (await request('get', '/:id', physical)).body.card_back_image);
    assert.deepStrictEqual((await back({ color: null, image: null })).body, { card_back_color: null, card_back_image: null });
  } finally {
    await new Promise(resolve => db.dbConnection.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testRecord()
  .then(() => console.log('Deck record self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
