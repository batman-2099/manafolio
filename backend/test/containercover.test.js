const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-cover-${process.pid}.db`);
process.env.DEFAULT_ADMIN_PASSWORD = 'test-password';
const db = require('../src/db');
const router = require('../src/routes/storage');
const update = router.stack.find(layer => layer.route?.path === '/locations/:id' && layer.route.methods.put).route.stack[0].handle;
const list = router.stack.find(layer => layer.route?.path === '/locations' && layer.route.methods.get).route.stack[0].handle;
(async () => {
  try {
    await db.initDb();
    await db.run('DELETE FROM locations');
    const { lastID: id } = await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Cover test', 'Box', 1)");
    await db.run("INSERT INTO card_cache (id, name, game, image_url) VALUES ('mtg-cover', 'Forest', 'mtg', 'https://example.com/card.jpg')");
    await db.run("INSERT INTO collection (card_id, user_id, location_id, quantity, added_at) VALUES ('mtg-cover', 1, ?, 1, '2026-01-01')", [id]);
    const request = async (cover, userId = 1) => {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await update({ params: { id }, user: { id: userId }, body: { cover_card_id: cover } }, res);
      return res;
    };
    assert.equal((await request('mtg-cover')).statusCode, 200);
    assert.equal((await db.get('SELECT cover_card_id FROM locations WHERE id = ?', [id])).cover_card_id, 'mtg-cover');
    assert.equal((await request('absent')).statusCode, 400);
    assert.equal((await request('mtg-cover', 999)).statusCode, 404);
    assert.equal((await db.get('SELECT cover_card_id FROM locations WHERE id = ?', [id])).cover_card_id, 'mtg-cover');
    assert.equal((await request(null)).statusCode, 200);
    assert.equal((await db.get('SELECT cover_card_id FROM locations WHERE id = ?', [id])).cover_card_id, null);
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other-cover-user', 'test', 'other-cover-token')");
    const { lastID: archivedId } = await db.run("INSERT INTO locations (name, type, user_id, inventory_type) VALUES ('Archived', 'Box', 1, 'graveyard')");
    const { lastID: otherId } = await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Other user', 'Box', 2)");
    const { lastID: emptyId } = await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Empty', 'Box', 1)");
    const { lastID: compartmentId } = await db.run("INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 9)", [id]);
    for (const [cardId, game, image, userId, locationId, inventory, addedAt] of [
      ['newest', 'mtg', 'newest.jpg', 1, id, 'collection', '2026-02-01'],
      ['same-time', 'mtg', 'tie.jpg', 1, id, 'collection', '2026-02-01'],
      ['no-image', 'mtg', '', 1, id, 'collection', '2026-03-01'],
      ['wrong-game', 'lorcana', 'lorcana.jpg', 1, id, 'collection', '2026-04-01'],
      ['wrong-user', 'mtg', 'private.jpg', 2, id, 'collection', '2026-05-01'],
      ['wrong-inventory', 'mtg', 'arena.jpg', 1, id, 'arena', '2026-06-01'],
      ['archived', 'mtg', 'archive.jpg', 1, archivedId, 'graveyard', '2026-07-01'],
      ['other-location', 'mtg', 'other.jpg', 2, otherId, 'collection', '2026-08-01'],
    ]) {
      await db.run('INSERT INTO card_cache (id, name, game, image_url) VALUES (?, ?, ?, ?)', [cardId, cardId, game, image]);
      await db.run('INSERT INTO collection (card_id, user_id, location_id, compartment_id, list_type, added_at, quantity) VALUES (?, ?, ?, ?, ?, ?, 2)',
        [cardId, userId, locationId, cardId === 'newest' ? compartmentId : null, inventory, addedAt]);
    }
    const summaries = async (inventory = 'collection', userId = 1) => {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await list({ user: { id: userId }, query: { inventory_type: inventory } }, res);
      assert.equal(res.statusCode, 200);
      return res.body;
    };
    let locations = await summaries();
    assert.deepEqual(locations.map(location => location.id).sort((a, b) => a - b), [id, emptyId]);
    const fallback = { card_id: 'newest', name: 'newest', game: 'mtg', image_url: 'newest.jpg' };
    assert.deepEqual(locations.find(location => location.id === id).cover, fallback, 'newest usable image wins, preserving collection insertion order for ties');
    assert.equal(locations.find(location => location.id === emptyId).cover, null);
    assert.equal(locations.find(location => location.id === id).total_cards, 2);
    assert.equal(locations.find(location => location.id === id).total_capacity, 9);
    assert.equal(locations.find(location => location.id === id).compartment_count, 1);
    await request('mtg-cover');
    assert.deepEqual((await summaries()).find(location => location.id === id).cover,
      { card_id: 'mtg-cover', name: 'Forest', game: 'mtg', image_url: 'https://example.com/card.jpg' }, 'preferred cover overrides a newer card');
    for (const preferred of ['wrong-user', 'wrong-inventory', 'wrong-game', 'no-image', 'archived', 'absent']) {
      await db.run('UPDATE locations SET cover_card_id = ? WHERE id = ?', [preferred, id]);
      assert.deepEqual((await summaries()).find(location => location.id === id).cover, fallback, `invalid preferred cover ${preferred} cannot cross scope or suppress fallback`);
    }
    await request('mtg-cover');
    await db.run("UPDATE collection SET location_id = NULL WHERE card_id = 'mtg-cover'");
    assert.deepEqual((await summaries()).find(location => location.id === id).cover, fallback, 'moving the preferred card out restores fallback');
    locations = await summaries('graveyard');
    assert.deepEqual(locations.map(location => location.id), [archivedId]);
    assert.equal(locations[0].cover.card_id, 'archived');
    locations = await summaries('collection', 2);
    assert.deepEqual(locations.map(location => location.id), [otherId]);
    assert.equal(locations[0].cover.card_id, 'other-location');
    console.log('Container cover persistence, fallback order, summary counts and ownership/inventory/game scope checks passed');
  } finally {
    await new Promise(resolve => db.dbConnection.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + suffix, { force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
