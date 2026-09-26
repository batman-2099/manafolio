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
    const physical = (await db.run(`INSERT INTO decks (name, user_id, checked_out, checked_out_at) VALUES ('Physical', 1, 1, '2026-09-22')`)).lastID;
    await db.initDb();
    assert.deepStrictEqual(await counts(physical), { wins: 0, losses: 0 });
    const created = await request('post', '/', null, { name: 'Arena', inventory_type: 'arena' });
    assert.strictEqual(created.statusCode, 201);
    const arena = created.body.id;
    assert.deepStrictEqual(await counts(arena), { wins: 0, losses: 0 });
    const legacy = (await db.run(`INSERT INTO decks (name, game, user_id) VALUES ('Legacy', 'lorcana', 1)`)).lastID;
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
    await db.initDb();
    const reloaded = new sqlite3.Database(tmpDb);
    try {
      const persisted = await new Promise((resolve, reject) => reloaded.get('SELECT wins, losses FROM decks WHERE id = ?', [physical], (error, row) => error ? reject(error) : resolve(row)));
      assert.deepStrictEqual(persisted, { wins: 19, losses: 0 }, 'records survive initialization and a fresh database connection');
    } finally {
      await new Promise(resolve => reloaded.close(resolve));
    }
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
