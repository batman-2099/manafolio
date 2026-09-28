const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-container-import-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const scryfallApi = require('../src/scryfallApi');
const importRouter = require('../src/routes/importExport');
const importContainer = importRouter.stack.find(layer => layer.route?.path === '/import-container').route.stack[0].handle;
const moveContainer = importRouter.stack.find(layer => layer.route?.path === '/import-container/move').route.stack[0].handle;

async function invoke(handler, body, userId = 1) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler({ body, user: { id: userId } }, res);
  return res;
}

const request = (name, data) => invoke(importContainer, { name, data });

async function testContainerImport() {
  const originalBulkFetch = scryfallApi.bulkFetchByIdentifier;
  try {
    await db.initDb();
    await db.run("INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-token')");
    const stored = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Existing box', 'Box', 1)")).lastID;
    const privateBox = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Private box', 'Box', 2)")).lastID;
    for (const number of ['1', '2', '3', '4', 'other']) {
      await db.run('INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)', [`mtg-${number}`, `Card ${number}`, 'mtg']);
    }
    const add = (number, quantity, printing = 'Normal', location = null, list = 'collection', missing = 0, user = 1) => db.run(`
      INSERT INTO collection (card_id, quantity, printing, location_id, list_type, missing, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [`mtg-${number}`, quantity, printing, location, list, missing, user]);
    await add('1', 6);
    await add('2', 9, 'Holofoil');
    await add('2', 2);
    await add('2', 3, 'Normal', stored);
    await add('2', 2, 'Normal', stored);
    await add('2', 1, 'Normal', stored, 'collection', 1);
    await add('2', 4, 'Holofoil', stored);
    await add('2', 7, 'Normal', null, 'arena');
    await add('2', 8, 'Normal', null, 'wishlist');
    await add('2', 100, 'Normal', null, 'collection', 0, 2);
    await add('2', 101, 'Normal', privateBox, 'collection', 0, 2);
    // Even a cross-owner location reference must not leak its name or ID.
    await add('2', 102, 'Normal', privateBox);
    await add('3', 2, 'Holofoil');
    await add('other', 20);
    const inventory = () => db.all(`
      SELECT user_id, card_id, printing, list_type, missing, SUM(quantity) AS quantity
      FROM collection GROUP BY user_id, card_id, printing, list_type, missing
      ORDER BY user_id, card_id, printing, list_type, missing
    `);
    const originalInventory = await inventory();
    const originalPrivate = await db.all('SELECT * FROM collection WHERE user_id = 2 ORDER BY id');
    const originalCache = await db.all('SELECT * FROM card_cache ORDER BY id');
    scryfallApi.bulkFetchByIdentifier = async rows => ({
      // Real resolver pairs retain input row identity, but local/API results can reorder.
      pairs: rows.filter(row => row.set_id === 'TST').reverse().map(row => ({ row, card: { id: `mtg-${row.number}` } })),
      notFound: 0
    });

    const res = await request('Reviewed box', `3 Split stack (TST) 1
1 Split stack (TST) 1
5 Partial stack (TST) 2
2 Other finish (TST) 3
1 Other finish (TST) 3 *F*
2 Not owned (TST) 4
4 Unknown card (BAD) 99
2 Unknown card (BAD) 99`);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.name, 'Reviewed box');
    assert.strictEqual(res.body.requested, 20);
    assert.strictEqual(res.body.count, 11);
    assert.strictEqual(res.body.missing, 9);
    assert.deepStrictEqual(res.body.items.map(({ name, set_code, collector_number, printing, requested, moved, unmoved, status }) =>
      [name, set_code, collector_number, printing, requested, moved, unmoved, status]), [
      ['Split stack', 'TST', '1', 'Normal', 4, 4, 0, 'resolved'],
      ['Partial stack', 'TST', '2', 'Normal', 5, 5, 0, 'resolved'],
      ['Other finish', 'TST', '3', 'Any', 3, 2, 1, 'resolved'],
      ['Not owned', 'TST', '4', 'Normal', 2, 0, 2, 'resolved'],
      ['Unknown card', 'BAD', '99', 'Normal', 6, 0, 6, 'unresolved']
    ]);
    assert.deepStrictEqual(res.body.items.map(item => [item.card_id, item.movable]), [
      ['mtg-1', 0], ['mtg-2', 0], ['mtg-3', 0], ['mtg-4', 0], [null, 0]
    ]);
    assert.deepStrictEqual(res.body.items.map(item => item.moved_finishes), [
      [{ printing: 'Normal', quantity: 4 }],
      [{ printing: 'Normal', quantity: 2 }, { printing: 'Holofoil', quantity: 3 }],
      [{ printing: 'Holofoil', quantity: 2 }],
      [], []
    ], 'one report per resolved card counts actual finishes once, preferring the requested finish');
    const location = (location_id, location_name, list_type, printing, quantity, missing = 0) =>
      ({ location_id, location_name, list_type, printing, quantity, missing });
    assert.deepStrictEqual(res.body.items.map(item => item.locations), [
      [location(null, null, 'collection', 'Normal', 2)],
      [
        location(null, null, 'arena', 'Normal', 7),
        location(null, null, 'collection', 'Holofoil', 6),
        location(null, null, 'wishlist', 'Normal', 8),
        location(stored, 'Existing box', 'collection', 'Holofoil', 4),
        location(stored, 'Existing box', 'collection', 'Normal', 5),
        location(stored, 'Existing box', 'collection', 'Normal', 1, 1)
      ],
      [], [], []
    ]);
    assert.deepStrictEqual(await inventory(), originalInventory, 'moving never changes owned quantities or inventory types');
    assert.deepStrictEqual(await db.all('SELECT * FROM collection WHERE user_id = 2 ORDER BY id'), originalPrivate);
    assert.deepStrictEqual(await db.all('SELECT * FROM card_cache ORDER BY id'), originalCache);
    const cards = await db.all('SELECT card_id, quantity, printing, location_id, compartment_id, position FROM collection WHERE location_id = ? ORDER BY position', [res.body.id]);
    assert.deepStrictEqual(cards.map(card => [card.card_id, card.printing]), [
      ...Array.from({ length: 4 }, () => ['mtg-1', 'Normal']),
      ['mtg-2', 'Normal'], ['mtg-2', 'Normal'],
      ...Array.from({ length: 3 }, () => ['mtg-2', 'Holofoil']),
      ['mtg-3', 'Holofoil'], ['mtg-3', 'Holofoil']
    ]);
    assert.ok(cards.every(card => card.quantity === 1 && card.compartment_id && card.location_id === res.body.id));
    assert.deepStrictEqual(cards.map(card => card.position), cards.map((_, index) => (index + 1) * 1000));
    assert.deepStrictEqual(await db.get('SELECT name, type, game FROM locations WHERE id = ?', [res.body.id]),
      { name: 'Reviewed box', type: 'Box', game: 'mtg' });
    assert.strictEqual((await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [res.body.id])).capacity, 11);

    const empty = await request('Empty box', '2 Not owned (TST) 4');
    assert.strictEqual(empty.statusCode, 201, 'a resolved import still creates an empty box when no copies are eligible');
    assert.strictEqual(empty.body.count, 0);
    assert.strictEqual(empty.body.missing, 2);
    assert.deepStrictEqual(empty.body.items[0].locations, []);
    assert.strictEqual((await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [empty.body.id])).capacity, 1);

    const beforeUnresolved = await db.all('SELECT * FROM locations ORDER BY id');
    const unresolved = await request('Unresolved box', '2 Unknown card (BAD) 99\n3 Unknown card (BAD) 99 *F*');
    assert.strictEqual(unresolved.statusCode, 400);
    assert.strictEqual(unresolved.body.id, null);
    assert.strictEqual(unresolved.body.requested, 5);
    assert.strictEqual(unresolved.body.count, 0);
    assert.strictEqual(unresolved.body.missing, 5);
    assert.deepStrictEqual(unresolved.body.items.map(item => [item.printing, item.requested, item.moved, item.unmoved, item.status, item.locations]),
      [['Normal', 2, 0, 2, 'unresolved', []], ['Holofoil', 3, 0, 3, 'unresolved', []]]);
    assert.deepStrictEqual(await db.all('SELECT * FROM locations ORDER BY id'), beforeUnresolved);
    assert.deepStrictEqual(await inventory(), originalInventory);

    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('mtg-5', 'Reserved stack', 'mtg')");
    const source = (await db.run("INSERT INTO locations (name, type, user_id) VALUES ('Source', 'Box', 1)")).lastID;
    const sourceCompartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 30)', [source])).lastID;
    const lockedBox = (await db.run("INSERT INTO locations (name, type, locked, user_id) VALUES ('Locked', 'Box', 1, 1)")).lastID;
    const lockedCompartment = (await db.run('INSERT INTO compartments (location_id, idx, capacity, locked) VALUES (?, 2, 30, 1)', [source])).lastID;
    const before = (await add('other', 1, 'Normal', source)).lastID;
    const stack = (await add('5', 7, 'Normal', source)).lastID;
    const after = (await add('other', 1, 'Normal', source)).lastID;
    for (const [index, id] of [before, stack, after].entries()) {
      await db.run('UPDATE collection SET compartment_id = ?, position = ? WHERE id = ?', [sourceCompartment, (index + 1) * 1000, id]);
    }
    await db.run(`
      UPDATE collection SET condition = 'Lightly Played', language = 'German', purchase_price = 4.25,
        favorite = 1, is_trade = 1, added_at = '2099-01-01', notes = 'Keep provenance', grader = 'PSA',
        grade = 9, market_value = 50, market_value_source = 'manual', market_value_at = '2026-09-20'
      WHERE id = ?
    `, [stack]);
    const originalStack = await db.get('SELECT * FROM collection WHERE id = ?', [stack]);
    await add('5', 1);
    await add('5', 11, 'Holofoil', lockedBox);
    const lockedEntry = (await add('5', 12, 'Normal', source)).lastID;
    await db.run('UPDATE collection SET compartment_id = ? WHERE id = ?', [lockedCompartment, lockedEntry]);
    await add('5', 13, 'Holofoil', null, 'collection', 1);
    await add('5', 14, 'Normal', null, 'arena');
    await add('5', 15, 'Normal', null, 'wishlist');
    await add('5', 16, 'Holofoil', source);
    await add('5', 17, 'Normal', privateBox, 'collection', 0, 2);
    await add('5', 18, 'Normal', privateBox);
    const wrongGame = (await add('5', 19)).lastID;
    await db.run("UPDATE collection SET game = 'unsupported' WHERE id = ?", [wrongGame]);
    const certifiedStack = (await add('5', 20, 'Holofoil')).lastID;
    await db.run("UPDATE collection SET grader = 'PSA', cert_number = 'legacy-cert' WHERE id = ?", [certifiedStack]);
    const foreignReference = (await add('other', 1, 'Normal', source, 'collection', 0, 2)).lastID;
    await db.run('UPDATE collection SET compartment_id = ?, position = 1500 WHERE id = ?', [sourceCompartment, foreignReference]);
    const protectedRows = () => db.all(`SELECT * FROM collection WHERE user_id = 2
      OR (card_id = 'mtg-5' AND (id IN (?, ?, ?) OR missing = 1 OR list_type != 'collection'
        OR location_id IN (?, ?))) ORDER BY id`,
    [lockedEntry, wrongGame, certifiedStack, lockedBox, privateBox]);
    const protectedBefore = await protectedRows();
    const deck = (await db.run("INSERT INTO decks (name, user_id, checked_out) VALUES ('In play', 1, 1)")).lastID;
    await db.run("INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, 'mtg-5', 8)", [deck]);
    const deckBefore = await db.get('SELECT * FROM decks WHERE id = ?', [deck]);
    const deckCardsBefore = await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [deck]);
    const inventoryBeforeMove = await inventory();
    const review = await request('Move reviewed box', '10 Reserved stack (TST) 5');
    assert.strictEqual(review.statusCode, 201);
    assert.deepStrictEqual([review.body.items[0].moved, review.body.items[0].unmoved, review.body.items[0].movable], [1, 9, 9],
      'all finishes of checked-out copies can change storage; locks, missing, other owners, other games and nonphysical lists stay excluded');
    const originalCapacity = await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [review.body.id]);
    const payload = { location_id: review.body.id, card_id: 'mtg-5', printing: 'Normal', requested: 10 };
    const move = (body = payload, user = 1) => invoke(moveContainer, body, user);
    const counts = response => [response.body.moved, response.body.unmoved, response.body.movable];
    await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [source]);
    const stale = await move();
    assert.strictEqual(stale.statusCode, 200);
    assert.deepStrictEqual(counts(stale), [1, 9, 0], 'source eligibility is recomputed, not trusted from the review');
    await db.run('UPDATE locations SET locked = 0 WHERE id = ?', [source]);
    const concurrent = await Promise.all([move(), move()]);
    assert.ok(concurrent.every(response => response.statusCode === 200));
    assert.deepStrictEqual(concurrent.map(counts), [[10, 0, 0], [10, 0, 0]],
      'concurrent requests fill the desired total once, not an additional quantity each');
    assert.deepStrictEqual(concurrent.map(response => response.body.moved_finishes), Array(2).fill([
      { printing: 'Normal', quantity: 8 }, { printing: 'Holofoil', quantity: 2 }
    ]));
    assert.strictEqual((await db.get('SELECT location_id FROM collection WHERE id = ?', [stack])).location_id, review.body.id,
      'checked-out copies move without returning the deck');
    const metadata = ({ id, quantity, location_id, compartment_id, position, ...rest }) => rest;
    const splitCopies = await db.all("SELECT * FROM collection WHERE location_id = ? AND language = 'German' ORDER BY position", [review.body.id]);
    assert.strictEqual(splitCopies.length, 7);
    assert.ok(splitCopies.every(copy => copy.quantity === 1));
    assert.deepStrictEqual(splitCopies.map(metadata), Array(7).fill(metadata(originalStack)), 'splitting retains every copy metadata field');
    assert.deepStrictEqual(await inventory(), inventoryBeforeMove);
    const placed = await db.all('SELECT position FROM collection WHERE location_id = ? ORDER BY position', [review.body.id]);
    assert.deepStrictEqual(placed.map(row => row.position), Array.from({ length: 10 }, (_, index) => (index + 1) * 1000));
    assert.deepStrictEqual(await db.get('SELECT capacity FROM compartments WHERE location_id = ?', [review.body.id]), originalCapacity,
      'moving more copies preserves the chosen container limit so overflow remains visible');
    assert.deepStrictEqual(await db.get('SELECT * FROM decks WHERE id = ?', [deck]), deckBefore);
    assert.deepStrictEqual(await db.all('SELECT * FROM deck_cards WHERE deck_id = ?', [deck]), deckCardsBefore);
    assert.deepStrictEqual(counts(await move()), [10, 0, 0]);
    assert.deepStrictEqual(await db.all('SELECT id, position FROM collection WHERE compartment_id = ? AND user_id = 1 ORDER BY position', [sourceCompartment]),
      [{ id: before, position: 1000 }, { id: after, position: 2000 }], 'source order is retained without holes');
    const afterMove = await db.all('SELECT * FROM collection ORDER BY id');
    assert.deepStrictEqual(counts(await move()), [10, 0, 0]);
    const lowered = await move({ ...payload, requested: 3 });
    assert.deepStrictEqual(counts(lowered), [3, 0, 0], 'a lowered target never moves cards back or adds copies');
    assert.deepStrictEqual(lowered.body.moved_finishes, [{ printing: 'Normal', quantity: 3 }]);
    const foilFirst = await move({ ...payload, printing: 'Holofoil', requested: 3 });
    assert.deepStrictEqual(counts(foilFirst), [3, 0, 0]);
    assert.deepStrictEqual(foilFirst.body.moved_finishes,
      [{ printing: 'Holofoil', quantity: 2 }, { printing: 'Normal', quantity: 1 }],
      'a capped report counts actual destination finishes, preferring the requested finish');
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), afterMove, 'retries are idempotent');
    assert.deepStrictEqual(await inventory(), inventoryBeforeMove);
    assert.deepStrictEqual(await protectedRows(), protectedBefore, 'ineligible and foreign-owned rows are unchanged, including placement');

    assert.strictEqual((await move(payload, 2)).statusCode, 404, 'another owner cannot target this container');
    assert.strictEqual((await move({ ...payload, card_id: 'unknown' })).statusCode, 404);
    for (const invalid of [0, -1, 1.5, '10', 2147483648, Number.MAX_SAFE_INTEGER]) {
      assert.strictEqual((await move({ ...payload, requested: invalid })).statusCode, 400);
    }
    assert.strictEqual((await move({ ...payload, printing: 'Unsupported finish' })).statusCode, 400);
    for (const [field, value, original] of [
      ['locked', 1, 0], ['type', 'Binder', 'Box'], ['sort_order', 'name', 'custom'],
      ['rule_type', 'set', 'any'], ['game', 'unsupported', 'mtg'], ['allow_stacking', 1, 0]
    ]) {
      await db.run(`UPDATE locations SET ${field} = ? WHERE id = ?`, [value, review.body.id]);
      assert.strictEqual((await move()).statusCode, 409, `changed destination ${field} is rejected`);
      await db.run(`UPDATE locations SET ${field} = ? WHERE id = ?`, [original, review.body.id]);
    }
    await db.run('UPDATE compartments SET locked = 1 WHERE location_id = ?', [review.body.id]);
    assert.strictEqual((await move()).statusCode, 409);
    await db.run('UPDATE compartments SET locked = 0 WHERE location_id = ?', [review.body.id]);
    await db.run(`UPDATE compartments SET rule_config = '{"sets":["blocked"]}' WHERE location_id = ?`, [review.body.id]);
    assert.strictEqual((await move()).statusCode, 409);
    await db.run('UPDATE compartments SET rule_config = NULL WHERE location_id = ?', [review.body.id]);
    const noCompartment = (await db.run(`INSERT INTO locations (name, type, sort_order, game, user_id)
      VALUES ('No compartment', 'Box', 'custom', 'mtg', 1)`)).lastID;
    assert.strictEqual((await move({ ...payload, location_id: noCompartment })).statusCode, 409);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), afterMove);

    for (const number of ['7', '8', '9']) {
      await db.run('INSERT INTO card_cache (id, name, game) VALUES (?, ?, ?)', [`mtg-${number}`, 'Mixed finishes', 'mtg']);
    }
    await add('7', 1, 'Holofoil');
    await add('7', 1);
    const foilStack = (await add('7', 5, 'Holofoil', source)).lastID;
    await db.run("UPDATE collection SET condition = 'Moderately Played', language = 'French', notes = 'Keep foil provenance' WHERE id = ?", [foilStack]);
    const foilStackBefore = await db.get('SELECT * FROM collection WHERE id = ?', [foilStack]);
    await add('7', 3, 'Normal', source);
    const anotherPrinting = (await add('8', 20, 'Holofoil')).lastID;
    const anotherPrintingBefore = await db.get('SELECT * FROM collection WHERE id = ?', [anotherPrinting]);
    const mixedInventory = await inventory();
    const mixed = await request('Mixed finish box', `2 Mixed finishes (TST) 7
1 Mixed finishes (TST) 7 *F*
2 Mixed finishes (TST) 7 *F*`);
    assert.strictEqual(mixed.statusCode, 201);
    assert.deepStrictEqual([mixed.body.requested, mixed.body.count, mixed.body.missing], [5, 2, 3]);
    assert.deepStrictEqual(mixed.body.items.map(item =>
      [item.card_id, item.printing, item.requested, item.moved, item.unmoved, item.movable]),
    [['mtg-7', 'Any', 5, 2, 3, 3]], 'mixed requests aggregate once, regardless of reordered resolver pairs');
    assert.deepStrictEqual(mixed.body.items[0].moved_finishes,
      [{ printing: 'Holofoil', quantity: 1 }, { printing: 'Normal', quantity: 1 }]);
    const anyPayload = { location_id: mixed.body.id, card_id: 'mtg-7', printing: 'Any', requested: 5 };
    const anyConcurrent = await Promise.all([move(anyPayload), move(anyPayload)]);
    assert.ok(anyConcurrent.every(response => response.statusCode === 200));
    assert.deepStrictEqual(anyConcurrent.map(counts), [[5, 0, 0], [5, 0, 0]]);
    assert.deepStrictEqual(anyConcurrent.map(response => response.body.moved_finishes), Array(2).fill([
      { printing: 'Holofoil', quantity: 4 }, { printing: 'Normal', quantity: 1 }
    ]), 'Any uses source order without a finish preference and counts all destination finishes toward its cap');
    const splitFoilCopies = await db.all("SELECT * FROM collection WHERE location_id = ? AND language = 'French'", [mixed.body.id]);
    assert.deepStrictEqual(splitFoilCopies.map(metadata), Array(3).fill(metadata(foilStackBefore)),
      'fallback splitting retains the finish and all source metadata');
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [foilStack])).quantity, 2);
    assert.deepStrictEqual(await db.get('SELECT * FROM collection WHERE id = ?', [anotherPrinting]), anotherPrintingBefore,
      'same-name cards from another exact printing stay untouched');
    const afterAnyMove = await db.all('SELECT * FROM collection ORDER BY id');
    const anyRetry = await move(anyPayload);
    assert.deepStrictEqual(anyRetry.body, anyConcurrent[0].body);
    const anyLowered = await move({ ...anyPayload, requested: 1 });
    assert.deepStrictEqual(counts(anyLowered), [1, 0, 0]);
    assert.strictEqual(anyLowered.body.moved_finishes.reduce((total, finish) => total + finish.quantity, 0), 1);
    assert.deepStrictEqual(await db.all('SELECT * FROM collection ORDER BY id'), afterAnyMove);
    assert.deepStrictEqual(await inventory(), mixedInventory);

    const normalFallback = (await add('9', 3)).lastID;
    await db.run("UPDATE collection SET notes = 'Normal provenance', language = 'Japanese' WHERE id = ?", [normalFallback]);
    const normalBefore = await db.get('SELECT * FROM collection WHERE id = ?', [normalFallback]);
    await add('9', 1, 'Holofoil');
    const foilRequest = await request('Foil preference box', '2 Mixed finishes (TST) 9 *F*');
    assert.strictEqual(foilRequest.statusCode, 201);
    assert.deepStrictEqual(foilRequest.body.items[0].moved_finishes,
      [{ printing: 'Holofoil', quantity: 1 }, { printing: 'Normal', quantity: 1 }]);
    const foilPlaced = await db.all('SELECT * FROM collection WHERE location_id = ? ORDER BY position', [foilRequest.body.id]);
    assert.deepStrictEqual(foilPlaced.map(copy => copy.printing), ['Holofoil', 'Normal'],
      'a requested foil takes precedence over older normal copies before falling back');
    assert.deepStrictEqual(metadata(foilPlaced[1]), metadata(normalBefore));
    assert.strictEqual((await db.get('SELECT quantity FROM collection WHERE id = ?', [normalFallback])).quantity, 2);
    const beforeOverflow = await db.all('SELECT * FROM locations ORDER BY id');
    assert.strictEqual((await request('Overflow box', '2147483647 Mixed finishes (TST) 7\n1 Mixed finishes (TST) 7 *F*')).statusCode, 400);
    assert.deepStrictEqual(await db.all('SELECT * FROM locations ORDER BY id'), beforeOverflow,
      'the per-card aggregate must remain within the Move request quantity limit');

    // The unique slab identity can travel intact, but cannot be duplicated from a legacy stack.
    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('mtg-6', 'Certified copy', 'mtg')");
    const slab = (await add('6', 1, 'Normal', source)).lastID;
    await db.run("UPDATE collection SET grader = 'PSA', cert_number = 'single-cert', notes = 'Unique slab' WHERE id = ?", [slab]);
    const slabBefore = await db.get('SELECT * FROM collection WHERE id = ?', [slab]);
    const slabMove = await move({ ...payload, card_id: 'mtg-6', requested: 1 });
    assert.deepStrictEqual(counts(slabMove), [1, 0, 0]);
    assert.deepStrictEqual(metadata(await db.get('SELECT * FROM collection WHERE id = ?', [slab])), metadata(slabBefore));

    // A failed append must restore decremented sources, positions, capacity and inserts.
    const rollbackStack = (await add('6', 3, 'Normal', source)).lastID;
    const snapshot = async () => ({
      cards: await db.all('SELECT * FROM collection ORDER BY id'),
      compartments: await db.all('SELECT * FROM compartments ORDER BY id')
    });
    const beforeFailure = await snapshot();
    await db.run(`CREATE TEMP TRIGGER fail_import_copy BEFORE INSERT ON collection
      WHEN NEW.location_id = ${review.body.id} AND NEW.card_id = 'mtg-6'
      BEGIN SELECT RAISE(ABORT, 'private database failure'); END`);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const failed = await move({ ...payload, card_id: 'mtg-6', requested: 3 });
      assert.strictEqual(failed.statusCode, 500);
      assert.ok(!failed.body.error.includes('private database failure'), 'database errors are not disclosed');
      assert.deepStrictEqual(await snapshot(), beforeFailure);
      await db.run('DROP TRIGGER fail_import_copy');
      await db.run(`CREATE TEMP TRIGGER fail_import_update BEFORE UPDATE OF quantity ON collection
        WHEN OLD.id = ${rollbackStack} BEGIN SELECT RAISE(ROLLBACK, 'already rolled back'); END`);
      assert.strictEqual((await move({ ...payload, card_id: 'mtg-6', requested: 3 })).statusCode, 500);
      await db.run('DROP TRIGGER fail_import_update');
      assert.deepStrictEqual(await snapshot(), beforeFailure, 'a failed rollback does not poison the query queue');
      assert.deepStrictEqual(counts(await move({ ...payload, card_id: 'mtg-6', requested: 3 })), [3, 0, 0]);
    } finally {
      console.error = originalConsoleError;
    }

    // A nontransaction write queued during rollback must commit outside that transaction.
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const rollback = db.withTransaction(async () => {
      await db.run("UPDATE collection SET notes = 'Rolled back' WHERE id = ?", [before]);
      enter();
      await released;
      throw new Error('Rollback isolation check');
    });
    await entered;
    const independentWrite = db.run("UPDATE collection SET notes = 'Independent write' WHERE id = ?", [before]);
    release();
    await assert.rejects(rollback, /Rollback isolation check/);
    await independentWrite;
    assert.strictEqual((await db.get('SELECT notes FROM collection WHERE id = ?', [before])).notes, 'Independent write');
    await db.withTransaction(async () => {
      await assert.rejects(db.withTransaction(async () => {}), /Nested transactions are not supported/);
      await db.run("UPDATE collection SET notes = 'Outer transaction survived' WHERE id = ?", [before]);
    });
    assert.strictEqual((await db.get('SELECT notes FROM collection WHERE id = ?', [before])).notes, 'Outer transaction survived');
  } finally {
    scryfallApi.bulkFetchByIdentifier = originalBulkFetch;
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testContainerImport()
  .then(() => console.log('ManaBox container import self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
