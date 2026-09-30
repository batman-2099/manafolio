const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const sharp = require('sharp');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-storage-units-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { authenticateToken } = require('../src/middleware/auth');

async function main() {
  let server;
  try {
    // Existing containers migrate in place without requiring a storage unit.
    await db.run(`CREATE TABLE locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
      sort_order TEXT, foil_sorting TEXT, rule_type TEXT DEFAULT 'any', rule_config TEXT,
      game TEXT DEFAULT 'mtg'
    )`);
    const legacy = await db.run("INSERT INTO locations (name, type) VALUES ('Existing box', 'Box')");
    await db.run(`CREATE TABLE storage_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK(length(trim(name)) > 0)
    )`);
    await db.run('PRAGMA foreign_keys = OFF');
    await db.run("INSERT INTO storage_units (user_id, name) VALUES (1, 'Legacy unit')");
    await db.run('PRAGMA foreign_keys = ON');
    await db.initDb();
    const starter = await db.get('SELECT * FROM locations WHERE user_id = 1 ORDER BY id LIMIT 1');
    assert.strictEqual(starter.storage_unit_id, null);
    assert.strictEqual(starter.id, legacy.lastID);
    assert.strictEqual(starter.name, 'Existing box');
    await db.initDb();
    assert.deepStrictEqual(await db.get('SELECT * FROM locations WHERE id = ?', [starter.id]), starter);
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-share')");
    await db.run("INSERT INTO sessions (token, user_id, expires_at) VALUES ('owner-session', 1, '2999-01-01'), ('other-session', 2, '2999-01-01')");
    await db.run("UPDATE users SET share_enabled = 1, share_locations = 1, share_token = 'owner-share' WHERE id = 1");

    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/shared', require('../src/routes/shared'));
    app.use('/api/admin', require('../src/routes/admin'));
    app.use('/api', authenticateToken, require('../src/routes/storage'), require('../src/routes/collection'), require('../src/routes/importExport'));
    app.use('/api/decks', authenticateToken, require('../src/routes/decks'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function request(method, suffix, body, user = 1, status = 200) {
      const response = await fetch(`${base}/${suffix}`, { method,
        headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user === 1 ? 'owner' : 'other'}-session` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json();
      assert.strictEqual(response.status, status, `${method} ${suffix}: ${JSON.stringify(result)}`);
      return result;
    }
    const createUnit = (name, user = 1) => request('POST', 'storage-units', { name }, user, 201);
    const createLocation = (name, unit, inventory_type = 'collection', user = 1) => request('POST', 'locations', {
      name, type: 'Box', storage_unit_id: unit, inventory_type, compartmentPlan: { count: 1, capacity: 40 }
    }, user);
    await request('GET', 'storage-units', undefined, null, 401);
    assert.deepStrictEqual(await request('GET', 'storage-units'), [
      { id: 1, name: 'Legacy unit', type: 'Other', container_count: 0, cover_card_id: null, cover_image: null, cover: null }
    ]);
    await request('DELETE', 'storage-units/1');
    for (const type of ['Cabinet', 'Shelf', 'Drawer', 'Storage Bin / Tote', 'Carrying Case', 'Bag / Backpack', 'Other']) {
      const unit = await request('POST', 'storage-units', { name: 'Typed unit', type }, 1, 201);
      assert.strictEqual(unit.type, type);
      await request('PUT', `storage-units/${unit.id}`, { name: 'Renamed unit' });
      assert.deepStrictEqual(await request('GET', 'storage-units'), [
        { id: unit.id, name: 'Renamed unit', type, container_count: 0, cover_card_id: null, cover_image: null, cover: null }
      ]);
      await request('PUT', `storage-units/${unit.id}`, { name: 'Changed unit', type: 'Other' });
      await request('PUT', `storage-units/${unit.id}`, { name: 'Changed unit', type });
      assert.strictEqual((await request('GET', 'storage-units'))[0].type, type);
      await request('DELETE', `storage-units/${unit.id}`);
    }
    for (const name of ['', '   ', 12, null]) await request('POST', 'storage-units', { name }, 1, 400);
    const first = await createUnit('  Cabinet  ');
    const second = await createUnit('Closet');
    const foreign = await createUnit('Other private unit', 2);
    assert.strictEqual(first.name, 'Cabinet');
    assert.strictEqual(first.type, 'Other');
    for (const type of ['', 'cabinet', 'Box', null, 1, {}, []]) {
      await request('POST', 'storage-units', { name: 'Invalid unit', type }, 1, 400);
      await request('PUT', `storage-units/${first.id}`, { name: 'Invalid unit', type }, 1, 400);
    }
    const box = await createLocation('Stored box', first.id);
    const archived = await createLocation('Archived box', first.id, 'graveyard');
    const loose = await createLocation('Loose box');
    const foreignBox = await createLocation('Foreign box', foreign.id, 'collection', 2);
    assert.deepStrictEqual(await request('GET', 'storage-units'), [
      { id: first.id, name: 'Cabinet', type: 'Other', container_count: 2, cover_card_id: null, cover_image: null, cover: null },
      { id: second.id, name: 'Closet', type: 'Other', container_count: 0, cover_card_id: null, cover_image: null, cover: null }
    ]);
    assert.deepStrictEqual(await request('GET', 'storage-units', undefined, 2), [{ ...foreign, container_count: 1 }]);
    for (const suffix of [`storage-units/${foreign.id}`, 'storage-units/999999']) {
      await request('PUT', suffix, { name: 'Not yours' }, 1, 404);
      await request('DELETE', suffix, undefined, 1, 404);
      await request('GET', `${suffix}/cover-choices`, undefined, 1, 404);
      await request('PUT', suffix, { cover_card_id: null }, 1, 404);
    }
    await request('PUT', `locations/${foreignBox.id}`, { storage_unit_id: first.id }, 1, 404);
    for (const storage_unit_id of [foreign.id, 999999]) {
      await request('POST', 'locations', { name: 'Rejected', type: 'Box', storage_unit_id }, 1, 404);
      await request('PUT', `locations/${box.id}`, { storage_unit_id }, 1, 404);
    }
    for (const storage_unit_id of [0, -1, '1', 1.5, {}, []]) {
      await request('POST', 'locations', { name: 'Rejected', type: 'Box', storage_unit_id }, 1, 400);
      await request('PUT', `locations/${box.id}`, { storage_unit_id }, 1, 400);
    }
    await request('PUT', `storage-units/${first.id}`, { name: '  Private cabinet  ' });
    await request('PUT', `storage-units/${first.id}`, { name: ' ' }, 1, 400);
    assert.strictEqual((await request('GET', `locations/${box.id}`)).storage_unit_name, 'Private cabinet');
    assert.strictEqual((await request('GET', 'locations?inventory_type=graveyard'))[0].storage_unit_name, 'Private cabinet');
    assert.strictEqual((await request('GET', `locations/${loose.id}`)).storage_unit_name, null);

    const compartment = await db.get('SELECT id FROM compartments WHERE location_id = ?', [box.id]);
    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('mtg-unit-card', 'Unit Card', 'mtg')");
    const entry = (await db.run(`INSERT INTO collection (card_id, quantity, user_id, location_id, compartment_id, position,
      favorite, is_trade, notes, missing, printing, language, purchase_price)
      VALUES ('mtg-unit-card', 3, 1, ?, ?, 2750, 1, 1, 'Keep copy metadata', 0, 'Holofoil', 'Japanese', 8.5)`, [box.id, compartment.id])).lastID;
    const deck = (await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('Reserved deck', 1, 1)")).lastID;
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id) VALUES (?, 'mtg-unit-card', 1, ?)", [deck, entry]);
    await db.run("INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, 'mtg-unit-card', ?, 1)", [deck, entry]);
    await db.run('UPDATE locations SET locked = 1, allow_stacking = 1, sleeved = 3 WHERE id = ?', [box.id]);
    await db.run('UPDATE compartments SET locked = 1 WHERE id = ?', [compartment.id]);
    const contents = async () => ({
      cards: await db.all('SELECT * FROM collection ORDER BY id'),
      compartments: await db.all('SELECT * FROM compartments ORDER BY id'),
      decks: await db.all('SELECT * FROM decks ORDER BY id'),
      definitions: await db.all('SELECT * FROM deck_cards ORDER BY deck_id, card_id'),
      reservations: await db.all('SELECT * FROM deck_card_allocations ORDER BY deck_id, card_id, entry_id')
    });
    const cover = { card_id: 'mtg-unit-card', name: 'Unit Card', game: 'mtg', image_url: 'https://example.com/unit.jpg' };
    const unitSummary = async id => (await request('GET', 'storage-units')).find(unit => unit.id === id);
    assert.deepStrictEqual(await request('GET', `storage-units/${first.id}/cover-choices`), []);
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: cover.card_id }, 1, 400);
    await db.run('UPDATE card_cache SET image_url = ? WHERE id = ?', [cover.image_url, cover.card_id]);
    const coverContents = await contents();
    const coverLocations = await db.all('SELECT * FROM locations ORDER BY id');
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: cover.card_id });
    await request('PUT', `storage-units/${first.id}`, { type: 'Other' });
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover);
    assert.strictEqual((await unitSummary(first.id)).cover_card_id, cover.card_id);
    assert.deepStrictEqual(await request('GET', `storage-units/${first.id}/cover-choices`), [cover]);
    const imageUri = (bytes, format = 'png') => `data:image/${format};base64,${bytes.toString('base64')}`;
    const png = await sharp({ create: { width: 1400, height: 700, channels: 3, background: '#123456' } }).png().toBuffer();
    const jpeg = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#654321' } }).withMetadata().jpeg().toBuffer();
    await request('PUT', `storage-units/${first.id}`, { cover_image: imageUri(png) });
    const uploaded = await unitSummary(first.id);
    assert.strictEqual(uploaded.cover_card_id, null);
    assert.deepStrictEqual(uploaded.cover, { card_id: null, name: uploaded.name, game: 'mtg', image_url: uploaded.cover_image });
    const uploadedMetadata = await sharp(Buffer.from(uploaded.cover_image.split(',')[1], 'base64')).metadata();
    assert.strictEqual(uploadedMetadata.format, 'webp');
    assert.deepStrictEqual([uploadedMetadata.width, uploadedMetadata.height], [980, 490]);
    await request('PUT', `storage-units/${first.id}`, { name: 'Uploaded cabinet', type: 'Shelf' });
    assert.strictEqual((await unitSummary(first.id)).cover_image, uploaded.cover_image);
    assert.strictEqual((await unitSummary(first.id)).cover.name, 'Uploaded cabinet');
    await request('PUT', `storage-units/${first.id}`, { cover_image: imageUri(jpeg, 'jpeg') });
    const replacement = await unitSummary(first.id);
    assert.notStrictEqual(replacement.cover_image, uploaded.cover_image);
    const replacementMetadata = await sharp(Buffer.from(replacement.cover_image.split(',')[1], 'base64')).metadata();
    assert.deepStrictEqual([replacementMetadata.width, replacementMetadata.height], [80, 120]);
    for (const key of ['exif', 'icc', 'xmp', 'orientation']) assert.strictEqual(replacementMetadata[key], undefined);
    const overPixels = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: '#000000' } }).png().toBuffer();
    const animatedGif = Buffer.from('47494638396101000100800000000000ffffff21f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex');
    const animatedWebp = await sharp(animatedGif, { animated: true }).webp().toBuffer();
    assert.strictEqual((await sharp(animatedWebp).metadata()).pages, 2);
    const animationChunk = Buffer.alloc(20);
    animationChunk.writeUInt32BE(8);
    animationChunk.write('acTL', 4);
    animationChunk.writeUInt32BE(2, 8);
    const apng = Buffer.concat([png.subarray(0, 33), animationChunk, png.subarray(33)]);
    const invalidImages = [null, {}, '', 'https://example.com/private.jpg', 'data:image/svg+xml;base64,PHN2Zy8+',
      'data:image/png;base64,YmFk', imageUri(png, 'jpeg'), imageUri(png.subarray(0, 40)),
      imageUri(overPixels), imageUri(animatedWebp, 'webp'), imageUri(apng), 'x'.repeat(700001)];
    for (const cover_image of invalidImages) {
      await request('PUT', `storage-units/${first.id}`, { name: 'Must not change', type: 'Other', cover_image }, 1, 400);
      assert.deepStrictEqual(await unitSummary(first.id), replacement, 'invalid image updates are atomic');
    }
    await request('PUT', `storage-units/${first.id}`, { cover_image: uploaded.cover_image, cover_card_id: null }, 1, 400);
    assert.deepStrictEqual(await unitSummary(first.id), replacement);
    await request('PUT', `storage-units/${foreign.id}`, { cover_image: uploaded.cover_image }, 1, 404);
    assert.strictEqual((await request('GET', 'storage-units', undefined, 2))[0].cover_image, null);
    await db.run(`CREATE TRIGGER reject_unit_image BEFORE UPDATE ON storage_units
      WHEN NEW.id = ${first.id} BEGIN SELECT RAISE(ABORT, 'reject image update'); END`);
    const logError = console.error;
    console.error = () => {};
    try {
      await request('PUT', `storage-units/${first.id}`, { name: 'Must not change', cover_image: uploaded.cover_image }, 1, 500);
      assert.deepStrictEqual(await unitSummary(first.id), replacement);
    } finally {
      console.error = logError;
      await db.run('DROP TRIGGER reject_unit_image');
    }
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: cover.card_id });
    assert.strictEqual((await unitSummary(first.id)).cover_image, null);
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover);
    await request('PUT', `storage-units/${first.id}`, { cover_image: uploaded.cover_image });
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: null });
    assert.strictEqual((await unitSummary(first.id)).cover_image, null);
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover);
    await request('PUT', `storage-units/${first.id}`, { name: 'Private cabinet', type: 'Other', cover_card_id: cover.card_id });
    for (const cover_card_id of ['absent', '', 1, {}, []]) {
      await request('PUT', `storage-units/${first.id}`, { cover_card_id }, 1, 400);
    }
    await request('PUT', `storage-units/${second.id}`, { cover_card_id: cover.card_id }, 1, 400);
    assert.deepStrictEqual(await contents(), coverContents, 'cover changes preserve copies, placements, locks and reservations');
    assert.deepStrictEqual(await db.all('SELECT * FROM locations ORDER BY id'), coverLocations);
    const archivedCover = { card_id: 'unit-archive', name: 'Archive image', game: 'mtg', image_url: 'https://example.com/archive.jpg' };
    for (const [id, game, image] of [
      [archivedCover.card_id, 'mtg', archivedCover.image_url], ['unit-foreign', 'mtg', cover.image_url],
      ['unit-wrong-inventory', 'mtg', cover.image_url], ['unit-wrong-game', 'pokemon', cover.image_url],
    ]) await db.run('INSERT INTO card_cache (id, name, game, image_url) VALUES (?, ?, ?, ?)', [id, id === archivedCover.card_id ? archivedCover.name : id, game, image]);
    const temporaryEntries = [];
    for (const [cardId, userId, locationId, listType] of [
      [archivedCover.card_id, 1, archived.id, 'graveyard'], [archivedCover.card_id, 1, archived.id, 'graveyard'],
      ['unit-foreign', 2, box.id, 'collection'], ['unit-wrong-inventory', 1, archived.id, 'collection'],
      ['unit-wrong-game', 1, box.id, 'collection'],
    ]) temporaryEntries.push((await db.run(`INSERT INTO collection (card_id, user_id, location_id, list_type, added_at)
      VALUES (?, ?, ?, ?, '2099-01-01')`, [cardId, userId, locationId, listType])).lastID);
    assert.deepStrictEqual(await request('GET', `storage-units/${first.id}/cover-choices`), [archivedCover, cover], 'choices deduplicate and enforce scope');
    for (const cover_card_id of ['unit-foreign', 'unit-wrong-inventory', 'unit-wrong-game']) {
      await request('PUT', `storage-units/${first.id}`, { cover_card_id }, 1, 400);
    }
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover, 'chosen cover wins over newer cards');
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: null });
    assert.strictEqual((await unitSummary(first.id)).cover_card_id, null);
    assert.deepStrictEqual((await unitSummary(first.id)).cover, archivedCover, 'automatic cover includes archived containers');
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: archivedCover.card_id });
    await request('PUT', `locations/${archived.id}`, { storage_unit_id: second.id });
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover, 'moving the selected container falls back');
    assert.strictEqual((await unitSummary(first.id)).cover_card_id, archivedCover.card_id);
    await request('PUT', `locations/${archived.id}`, { storage_unit_id: first.id });
    await db.run("DELETE FROM collection WHERE card_id = 'unit-wrong-inventory'");
    await request('POST', `locations/${archived.id}/transfer`, { inventory_type: 'collection' });
    assert.deepStrictEqual((await unitSummary(first.id)).cover, archivedCover, 'restoring a contained container preserves its eligible cover');
    await request('POST', `locations/${archived.id}/transfer`, { inventory_type: 'graveyard' });
    assert.deepStrictEqual((await unitSummary(first.id)).cover, archivedCover, 'archiving a contained container preserves its eligible cover');
    await db.run('UPDATE card_cache SET image_url = NULL WHERE id = ?', [archivedCover.card_id]);
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover, 'losing the selected image falls back');
    await db.run('UPDATE card_cache SET image_url = ? WHERE id = ?', [archivedCover.image_url, archivedCover.card_id]);
    await db.run("UPDATE collection SET list_type = 'collection' WHERE card_id = ?", [archivedCover.card_id]);
    assert.deepStrictEqual((await unitSummary(first.id)).cover, cover, 'out-of-inventory cards cannot remain covers');
    for (const id of temporaryEntries) await db.run('DELETE FROM collection WHERE id = ?', [id]);
    await request('PUT', `storage-units/${first.id}`, { cover_card_id: cover.card_id });
    const before = await contents();
    const originalBox = await db.get('SELECT * FROM locations WHERE id = ?', [box.id]);
    await request('PUT', `locations/${box.id}`, { storage_unit_id: second.id });
    assert.deepStrictEqual(await db.get('SELECT * FROM locations WHERE id = ?', [box.id]), { ...originalBox, storage_unit_id: second.id });
    assert.strictEqual((await unitSummary(first.id)).cover, null);
    assert.deepStrictEqual((await unitSummary(second.id)).cover, cover);
    await request('PUT', `locations/${box.id}`, {});
    assert.strictEqual((await request('GET', `locations/${box.id}`)).storage_unit_id, second.id, 'omission preserves membership');
    assert.strictEqual((await request('GET', 'collection'))[0].storage_unit_name, 'Closet');
    assert.strictEqual((await request('GET', `decks/${deck}/locations`))[0].locations[0].storage_unit_name, 'Closet');
    assert.strictEqual((await request('GET', `decks/${deck}/cards/mtg-unit-card/sources`)).sources[0].storage_unit_name, 'Closet');
    await request('PUT', `locations/${box.id}`, { storage_unit_id: null });
    assert.strictEqual((await request('GET', `locations/${box.id}`)).storage_unit_id, null);
    await request('PUT', `locations/${box.id}`, { storage_unit_id: first.id });
    assert.deepStrictEqual(await contents(), before, 'physical grouping never changes inventory, locks, slots, copy metadata or reservations');
    for (const suffix of [`shared/owner-share/containers/${box.id}`, 'shared/owner-share']) {
      const shared = await request('GET', suffix, undefined, null);
      assert.ok(!JSON.stringify(shared).includes('Private cabinet'));
      assert.ok(!JSON.stringify(shared).includes('storage_unit'), 'public responses never expose unit data');
    }

    await db.run(`CREATE TRIGGER reject_unit_detach BEFORE UPDATE OF storage_unit_id ON locations
      WHEN OLD.id = ${box.id} AND NEW.storage_unit_id IS NULL BEGIN SELECT RAISE(ABORT, 'test detach failure'); END`);
    try {
      await request('DELETE', `storage-units/${first.id}`, undefined, 1, 500);
      assert.strictEqual((await request('GET', `locations/${archived.id}`)).storage_unit_id, first.id);
      assert.strictEqual((await request('GET', `locations/${box.id}`)).storage_unit_id, first.id);
      assert.strictEqual((await request('GET', 'storage-units')).find(unit => unit.id === first.id).container_count, 2);
    } finally {
      await db.run('DROP TRIGGER reject_unit_detach');
    }
    await request('DELETE', `storage-units/${first.id}`);
    for (const id of [box.id, archived.id]) assert.strictEqual((await request('GET', `locations/${id}`)).storage_unit_id, null);
    assert.deepStrictEqual(await contents(), before, 'deletion detaches containers without deleting or changing their contents');
    await request('PUT', `locations/${box.id}`, { storage_unit_id: second.id });
    await request('PUT', `locations/${archived.id}`, { storage_unit_id: second.id });
    const empty = await createUnit('Empty unit');
    await request('PUT', `storage-units/${second.id}`, { name: second.name, type: 'Cabinet' });
    await request('PUT', `storage-units/${empty.id}`, { name: empty.name, type: 'Bag / Backpack' });
    await request('PUT', `storage-units/${second.id}`, { cover_card_id: cover.card_id });
    await request('PUT', `storage-units/${empty.id}`, { cover_image: uploaded.cover_image });
    const backupImage = (await unitSummary(empty.id)).cover_image;
    const backup = await request('GET', 'export?format=backup');
    assert.deepStrictEqual(backup.storage_units, [
      { id: second.id, name: 'Closet', type: 'Cabinet', cover_card_id: cover.card_id, cover_image: null },
      { id: empty.id, name: 'Empty unit', type: 'Bag / Backpack', cover_card_id: null, cover_image: backupImage }
    ]);
    assert.strictEqual(backup.locations.find(location => location.id === box.id).storage_unit_id, second.id);
    const foreignBefore = await db.get('SELECT * FROM locations WHERE id = ?', [foreignBox.id]);
    for (const storage_units of [null, {}, [{ id: second.id, name: '' }], [{ id: second.id, name: 'A' }, { id: second.id, name: 'B' }]]) {
      await request('POST', 'import', { format: 'backup', data: { ...backup, storage_units } }, 1, 400);
    }
    for (const type of ['Box', null, 1, {}]) {
      const invalidTypeBackup = structuredClone(backup);
      invalidTypeBackup.storage_units[0].type = type;
      await request('POST', 'import', { format: 'backup', data: invalidTypeBackup }, 1, 400);
    }
    for (const cover_card_id of [1, {}, []]) {
      const invalidCoverBackup = structuredClone(backup);
      invalidCoverBackup.storage_units[0].cover_card_id = cover_card_id;
      await request('POST', 'import', { format: 'backup', data: invalidCoverBackup }, 1, 400);
    }
    const unitsBeforeBadBackup = await request('GET', 'storage-units');
    for (const cover_image of invalidImages.filter(image => image !== null)) {
      const invalidImageBackup = structuredClone(backup);
      invalidImageBackup.storage_units[1].cover_image = cover_image;
      await request('POST', 'import', { format: 'backup', data: invalidImageBackup }, 1, 400);
      assert.deepStrictEqual(await request('GET', 'storage-units'), unitsBeforeBadBackup);
    }
    const conflictingImageBackup = structuredClone(backup);
    conflictingImageBackup.storage_units[1].cover_card_id = cover.card_id;
    await request('POST', 'import', { format: 'backup', data: conflictingImageBackup }, 1, 400);
    const badReference = structuredClone(backup);
    badReference.locations.find(location => location.id === box.id).storage_unit_id = foreign.id;
    await request('POST', 'import', { format: 'backup', data: badReference }, 1, 400);
    assert.deepStrictEqual(await contents(), before);
    await request('POST', 'import', { format: 'backup', data: backup });
    const restoredUnits = await request('GET', 'storage-units');
    assert.deepStrictEqual(restoredUnits.map(({ name, type, container_count }) => ({ name, type, container_count })), [
      { name: 'Closet', type: 'Cabinet', container_count: 2 }, { name: 'Empty unit', type: 'Bag / Backpack', container_count: 0 }
    ]);
    assert.strictEqual(restoredUnits.find(unit => unit.name === 'Closet').cover_card_id, cover.card_id);
    assert.deepStrictEqual(restoredUnits.find(unit => unit.name === 'Closet').cover, cover);
    const restoredUpload = restoredUnits.find(unit => unit.name === 'Empty unit');
    assert.strictEqual(restoredUpload.cover_image, backupImage, 'backup preserves normalized WebP bytes');
    assert.deepStrictEqual(restoredUpload.cover, { card_id: null, name: 'Empty unit', game: 'mtg', image_url: backupImage });
    const restoredBox = (await request('GET', 'locations')).find(location => location.name === 'Stored box');
    assert.strictEqual(restoredBox.storage_unit_id, restoredUnits.find(unit => unit.name === 'Closet').id);
    assert.notStrictEqual(restoredBox.storage_unit_id, second.id, 'restore remaps unit identities');
    assert.strictEqual(restoredBox.locked, 1);
    const restoredCard = await db.get('SELECT * FROM collection WHERE user_id = 1');
    const originalCard = before.cards[0];
    assert.deepStrictEqual({ ...restoredCard, id: originalCard.id, location_id: originalCard.location_id, compartment_id: originalCard.compartment_id }, originalCard);
    assert.strictEqual((await db.get('SELECT entry_id FROM deck_card_allocations')).entry_id, restoredCard.id);
    assert.strictEqual((await db.get('SELECT location_id FROM compartments WHERE id = ?', [restoredCard.compartment_id])).location_id, restoredBox.id);
    assert.deepStrictEqual(await db.get('SELECT * FROM locations WHERE id = ?', [foreignBox.id]), foreignBefore);
    const legacyTypeBackup = structuredClone(backup);
    for (const unit of legacyTypeBackup.storage_units) {
      delete unit.type;
      delete unit.cover_card_id;
      delete unit.cover_image;
    }
    await request('POST', 'import', { format: 'backup', data: legacyTypeBackup });
    assert.deepStrictEqual((await request('GET', 'storage-units')).map(({ name, type, container_count }) => ({ name, type, container_count })), [
      { name: 'Closet', type: 'Other', container_count: 2 }, { name: 'Empty unit', type: 'Other', container_count: 0 }
    ]);
    assert.ok((await request('GET', 'storage-units')).every(unit => unit.cover_card_id === null && unit.cover_image === null));
    assert.deepStrictEqual((await request('GET', 'storage-units')).find(unit => unit.name === 'Closet').cover, cover);

    const oldBackup = structuredClone(backup);
    delete oldBackup.storage_units;
    for (const location of oldBackup.locations) delete location.storage_unit_id;
    await request('POST', 'import', { format: 'backup', data: oldBackup });
    assert.deepStrictEqual(await request('GET', 'storage-units'), []);
    assert.ok((await db.all('SELECT storage_unit_id FROM locations WHERE user_id = 1')).every(location => location.storage_unit_id === null));
    assert.deepStrictEqual(await request('GET', 'storage-units', undefined, 2), [{ ...foreign, container_count: 1 }]);
    const retained = await createUnit('Owner retained');
    await request('DELETE', 'admin/users/2');
    assert.deepStrictEqual(await db.all('SELECT * FROM storage_units WHERE user_id = 2'), []);
    assert.strictEqual(await db.get('SELECT id FROM locations WHERE id = ?', [foreignBox.id]), undefined);
    assert.deepStrictEqual(await request('GET', 'storage-units'), [retained]);
    assert.deepStrictEqual(await db.all('PRAGMA foreign_key_check'), []);
    console.log('Storage units: migration, ownership, state-preserving moves, atomic detach, privacy, backup and account cleanup passed');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
