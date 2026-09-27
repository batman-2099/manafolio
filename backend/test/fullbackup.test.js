const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-full-backup-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const importExportRouter = require('../src/routes/importExport');
const exportBackup = importExportRouter.stack.find(layer => layer.route?.path === '/export' && layer.route.methods.get).route.stack[0].handle;
const importHandler = importExportRouter.stack.find(layer => layer.route?.path === '/import' && layer.route.methods.post).route.stack[0].handle;
const importBackup = (req, res) => importHandler({ ...req, accepts: () => 'application/json' }, res);

async function testFullBackup() {
  try {
    await db.initDb();
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('backup-card', 'Backup Card', 'mtg')`);
    const location = await db.run(`INSERT INTO locations (name, type, user_id, sleeved) VALUES ('Backup Box', 'Box', 1, 3)`);
    const compartment = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 100)`, [location.lastID]);
    await db.run(`INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, 'mtg')`, [compartment.lastID]);
    await db.run(`INSERT INTO collection (card_id, location_id, compartment_id, position, game, user_id) VALUES ('backup-card', ?, ?, 1000, 'mtg', 1)`, [location.lastID, compartment.lastID]);
    const deck = await db.run(`INSERT INTO decks (name, game, format, commander_card_id, checked_out, wins, losses, sleeved, user_id) VALUES ('Backup Deck', 'mtg', 'Commander / EDH', 'backup-card', 1, 7, 3, 3, 1)`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES (?, 'backup-card', 2, 1)`, [deck.lastID]);
    await db.run(`INSERT INTO decks (name, game, inventory_type, wins, losses, user_id) VALUES ('Arena Deck', 'mtg', 'arena', 2, 5, 1)`);
    const { normalizeCardBack } = require('../src/utils/cardBack');
    const png = await require('sharp')({ create: { width: 64, height: 90, channels: 3, background: '#123456' } }).png().toBuffer();
    const customBack = await normalizeCardBack({ color: null, image: `data:image/png;base64,${png.toString('base64')}` });
    await db.run('UPDATE decks SET card_back_image = ? WHERE id = ?', [customBack.card_back_image, deck.lastID]);
    await db.run(`UPDATE decks SET card_back_color = '#ABC123' WHERE name = 'Arena Deck'`);

    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      json(body) { this.body = body; return this; }
    };
    await exportBackup({ query: { format: 'backup' }, user: { id: 1 } }, res);

    assert.strictEqual(res.headers['Content-Type'], 'application/json');
    assert.strictEqual(res.body.format, 'manafolio-backup');
    assert.strictEqual(res.body.version, 1);
    assert.deepStrictEqual(res.body.collection.map(card => [card.card_id, card.position]), [['backup-card', 1000]]);
    assert.ok(res.body.locations.some(row => row.id === location.lastID && row.name === 'Backup Box'));
    assert.strictEqual(res.body.locations.find(row => row.id === location.lastID).sleeved, 3);
    assert.ok(res.body.compartments.some(row => row.id === compartment.lastID && row.idx === 1 && row.capacity === 100));
    assert.ok(res.body.compartment_assignments.some(row => row.compartment_id === compartment.lastID && row.filter_value === 'mtg'));
    assert.deepStrictEqual(res.body.decks.map(deck => [deck.name, deck.checked_out, deck.wins, deck.losses]), [['Backup Deck', 1, 7, 3], ['Arena Deck', 0, 2, 5]]);
    assert.strictEqual(res.body.decks[0].commander_card_id, 'backup-card');
    assert.deepStrictEqual(res.body.decks.map(deck => deck.sleeved), [3, 0]);
    assert.deepStrictEqual(res.body.deck_cards.map(card => [card.card_id, card.quantity, card.checked_out]), [['backup-card', 2, 1]]);
    assert.deepStrictEqual(res.body.card_cache.map(card => card.id), ['backup-card']);

    await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('discard-card', 'Discard Card', 'mtg')`);
    const discardedLocation = await db.run(`INSERT INTO locations (name, type, user_id) VALUES ('Discard Box', 'Box', 1)`);
    await db.run(`INSERT INTO collection (card_id, location_id, game, user_id) VALUES ('discard-card', ?, 'mtg', 1)`, [discardedLocation.lastID]);
    const discardedDeck = await db.run(`INSERT INTO decks (name, game, user_id) VALUES ('Discard Deck', 'mtg', 1)`);
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'discard-card', 1)`, [discardedDeck.lastID]);

    const restoreRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await importBackup({ body: { format: 'backup', data: res.body }, user: { id: 1 } }, restoreRes);

    assert.strictEqual(restoreRes.statusCode, 200);
    assert.strictEqual(restoreRes.body.cards, 1);
    assert.strictEqual(restoreRes.body.locations, res.body.locations.length);
    assert.strictEqual(restoreRes.body.decks, 2);
    assert.deepStrictEqual(await db.all(`SELECT card_id, position FROM collection WHERE user_id = 1 ORDER BY id`), [{ card_id: 'backup-card', position: 1000 }]);
    assert.strictEqual((await db.get(`SELECT COUNT(*) AS count FROM locations WHERE user_id = 1 AND name = 'Discard Box'`)).count, 0);
    assert.strictEqual((await db.get("SELECT sleeved FROM locations WHERE user_id = 1 AND name = 'Backup Box'")).sleeved, 3);
    assert.deepStrictEqual(await db.all(`SELECT name, checked_out, commander_card_id, inventory_type, wins, losses, sleeved FROM decks WHERE user_id = 1 ORDER BY id`), [
      { name: 'Backup Deck', checked_out: 1, commander_card_id: 'backup-card', inventory_type: 'collection', wins: 7, losses: 3, sleeved: 3 },
      { name: 'Arena Deck', checked_out: 0, commander_card_id: null, inventory_type: 'arena', wins: 2, losses: 5, sleeved: 0 }
    ]);
    assert.deepStrictEqual(await db.all(`SELECT card_id, quantity, checked_out FROM deck_cards`), [{ card_id: 'backup-card', quantity: 2, checked_out: 1 }]);
    assert.deepStrictEqual(await db.all('SELECT card_back_color, card_back_image FROM decks WHERE user_id = 1 ORDER BY id'),
      [customBack, { card_back_color: '#ABC123', card_back_image: null }], 'backup restores custom image bytes and colors');

    const invalidBackup = { ...res.body, decks: [{ ...res.body.decks[0], commander_card_id: 'discard-card' }] };
    const invalidRes = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    await importBackup({ body: { format: 'backup', data: invalidBackup }, user: { id: 1 } }, invalidRes);
    assert.ok(invalidRes.statusCode >= 400, 'a commander outside its deck must make the backup invalid');
    assert.strictEqual((await db.get(`SELECT commander_card_id FROM decks WHERE user_id = 1`)).commander_card_id, 'backup-card', 'invalid backups must not replace existing data');

    const beforeUnsupported = await Promise.all(['card_cache', 'collection', 'locations', 'decks', 'deck_cards'].map(table => db.all(`SELECT * FROM ${table}`)));
    for (const table of ['card_cache', 'collection', 'locations', 'decks']) {
      const unsupported = structuredClone(res.body);
      unsupported[table][0].game = 'unsupported';
      invalidRes.statusCode = 200;
      await importBackup({ body: { format: 'backup', data: unsupported }, user: { id: 1 } }, invalidRes);
      assert.strictEqual(invalidRes.statusCode, 400, `${table}: unsupported backups must be rejected as a whole`);
      assert.deepStrictEqual(await Promise.all(['card_cache', 'collection', 'locations', 'decks', 'deck_cards'].map(table => db.all(`SELECT * FROM ${table}`))),
        beforeUnsupported, 'unsupported backups must not modify current data');
    }

    const beforeInvalidRecord = await db.all(`SELECT * FROM decks WHERE user_id = 1 ORDER BY id`);
    for (const key of ['wins', 'losses']) {
      for (const value of [-1, 0.5, '1', null, true, 2147483648]) {
        const invalid = { ...res.body, decks: [{ ...res.body.decks[0], [key]: value }] };
        invalidRes.statusCode = 200;
        await importBackup({ body: { format: 'backup', data: invalid }, user: { id: 1 } }, invalidRes);
        assert.strictEqual(invalidRes.statusCode, 400, `${key} must reject ${JSON.stringify(value)}`);
        assert.deepStrictEqual(await db.all(`SELECT * FROM decks WHERE user_id = 1 ORDER BY id`), beforeInvalidRecord, 'malformed records must not replace existing decks');
      }
    }
    for (const sleeved of [-1, 4, 0.5, '1', null, true]) {
      const invalid = { ...res.body, decks: res.body.decks.map(deck => ({ ...deck, sleeved })) };
      invalidRes.statusCode = 200;
      await importBackup({ body: { format: 'backup', data: invalid }, user: { id: 1 } }, invalidRes);
      assert.strictEqual(invalidRes.statusCode, 400);
      assert.deepStrictEqual(await db.all(`SELECT * FROM decks WHERE user_id = 1 ORDER BY id`), beforeInvalidRecord, 'invalid sleeve values must not replace saved decks');
    }
    const backupTables = ['card_cache', 'collection', 'locations', 'compartments', 'compartment_assignments', 'decks', 'deck_cards', 'deck_card_allocations'];
    const beforeInvalidSleeves = await Promise.all(backupTables.map(table => db.all(`SELECT * FROM ${table}`)));
    for (const sleeved of [-1, 4, 0.5, '1', null, true]) {
      const invalid = structuredClone(res.body);
      invalid.locations.find(row => row.id === location.lastID).sleeved = sleeved;
      invalidRes.statusCode = 200;
      await importBackup({ body: { format: 'backup', data: invalid }, user: { id: 1 } }, invalidRes);
      assert.strictEqual(invalidRes.statusCode, 400);
      assert.deepStrictEqual(await Promise.all(backupTables.map(table => db.all(`SELECT * FROM ${table}`))),
        beforeInvalidSleeves, 'invalid container sleeves must reject the entire backup without changing identities or placements');
    }
    for (const value of [
      { card_back_color: '#fff', card_back_image: null },
      { card_back_color: '#123456', card_back_image: customBack.card_back_image },
      { card_back_color: null, card_back_image: 'javascript:alert(1)' },
      { card_back_color: null, card_back_image: 'data:image/webp;base64,YmFk' },
      { card_back_color: null, card_back_image: 'x'.repeat(700001) }
    ]) {
      const invalid = structuredClone(res.body);
      Object.assign(invalid.decks[0], value);
      invalidRes.statusCode = 200;
      await importBackup({ body: { format: 'backup', data: invalid }, user: { id: 1 } }, invalidRes);
      assert.strictEqual(invalidRes.statusCode, 400);
      assert.deepStrictEqual(await db.all('SELECT * FROM decks WHERE user_id = 1 ORDER BY id'), beforeInvalidRecord);
    }

    // Backups made before commander support remain valid.
    delete res.body.decks[0].commander_card_id;
    for (const location of res.body.locations) {
      delete location.inventory_type;
      delete location.sleeved;
    }
    await importBackup({ body: { format: 'backup', data: res.body }, user: { id: 1 } }, restoreRes);
    assert.strictEqual(restoreRes.statusCode, 200);
    assert.strictEqual((await db.get(`SELECT commander_card_id FROM decks WHERE user_id = 1`)).commander_card_id, null);
    assert.ok((await db.all('SELECT inventory_type FROM locations WHERE user_id = 1')).every(row => row.inventory_type === 'collection'));
    assert.ok((await db.all('SELECT sleeved FROM locations WHERE user_id = 1')).every(row => row.sleeved === 0));

    // Older backups do not carry deck records.
    for (const deck of res.body.decks) {
      delete deck.wins;
      delete deck.losses;
      delete deck.sleeved;
      delete deck.card_back_color;
      delete deck.card_back_image;
    }
    await importBackup({ body: { format: 'backup', data: res.body }, user: { id: 1 } }, restoreRes);
    assert.strictEqual(restoreRes.statusCode, 200);
    assert.deepStrictEqual(await db.all(`SELECT wins, losses FROM decks WHERE user_id = 1 ORDER BY id`), [
      { wins: 0, losses: 0 }, { wins: 0, losses: 0 }
    ]);
    assert.deepStrictEqual(await db.all('SELECT sleeved FROM decks WHERE user_id = 1 ORDER BY id'), [{ sleeved: 0 }, { sleeved: 0 }]);
    assert.deepStrictEqual(await db.all('SELECT card_back_color, card_back_image FROM decks WHERE user_id = 1 ORDER BY id'),
      [{ card_back_color: null, card_back_image: null }, { card_back_color: null, card_back_image: null }]);
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testFullBackup()
  .then(() => console.log('Complete backup self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
