const assert = require('assert');

process.env.DB_PATH = ':memory:';
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const { checkedOutAllocation } = require('../src/utils/collectionHelpers');
const collectionRouter = require('../src/routes/collection');
const getCollection = collectionRouter.stack.find(layer => layer.route?.path === '/collection' && layer.route.methods.get).route.stack[0].handle;

// Reference the pre-batching algorithm against the same SQLite rows, including
// timestamp ties and the allocation map's iteration order used by callers.
async function originalAllocation(userId, excludeDeckId = null) {
  const required = await db.all(`
    SELECT dc.card_id, SUM(dc.quantity) AS req
    FROM deck_cards dc JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id = ? AND d.checked_out = 1 AND d.inventory_type = 'collection' AND (? IS NULL OR d.id != ?)
    GROUP BY dc.card_id
  `, [userId, excludeDeckId, excludeDeckId]);
  const allocated = new Map();
  for (const { card_id, req } of required) {
    let need = req;
    const entries = await db.all(`
      SELECT id AS entry_id, quantity FROM collection
      WHERE user_id = ? AND list_type = 'collection' AND card_id = ?
      ORDER BY (location_id IS NOT NULL) DESC, added_at DESC
    `, [userId, card_id]);
    for (const entry of entries) {
      if (need <= 0) break;
      const take = Math.min(entry.quantity, need);
      need -= take;
      allocated.set(entry.entry_id, take);
    }
  }
  return allocated;
}

async function collection(userId, query = {}) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
  await getCollection({ query, user: { id: userId } }, res);
  assert.strictEqual(res.statusCode, 200);
  return res.body;
}

async function main() {
  try {
    await db.initDb();
    await db.run(`DELETE FROM locations`);
    await db.run(`INSERT INTO users (id, username, password_hash, share_token) VALUES
      (2, 'other', 'unused', 'other'), (3, 'empty', 'unused', 'empty')`);
    await db.run(`INSERT INTO locations (id, user_id, name, type) VALUES (1, 1, 'Binder', 'Binder'), (2, 2, 'Other binder', 'Binder')`);
    await db.run(`INSERT INTO card_cache (id, name, game) VALUES
      ('alpha', 'Alpha', 'mtg'), ('beta', 'Beta', 'mtg'), ('gamma', 'Gamma', 'mtg'), ('absent', 'Absent', 'mtg')`);
    await db.run(`INSERT INTO decks (id, user_id, name, checked_out, inventory_type) VALUES
      (1, 1, 'Zulu', 1, 'collection'), (2, 1, 'Echo', 1, 'collection'),
      (3, 1, 'Echo', 1, 'collection'), (4, 1, 'Draft', 0, 'collection'),
      (5, 1, 'Arena', 1, 'arena'), (6, 2, 'Private', 1, 'collection'),
      (7, 3, 'Empty', 1, 'collection')`);
    // Deliberately insert deck cards out of deck order; keep duplicate names.
    await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out) VALUES
      (3, 'alpha', 1, 0), (2, 'alpha', 2, 1), (1, 'alpha', 5, 0),
      (1, 'beta', 4, 0), (1, 'absent', 1, 0), (4, 'alpha', 99, 1),
      (4, 'gamma', 99, 1), (5, 'alpha', 99, 1), (6, 'alpha', 1, 1)`);
    await db.run(`INSERT INTO collection (id, user_id, card_id, quantity, location_id, added_at, list_type, missing) VALUES
      (101, 1, 'alpha', 10, NULL, '2026-09-01', 'collection', 0),
      (102, 1, 'alpha', 2, 1, '2026-01-01', 'collection', 0),
      (104, 1, 'alpha', 4, 1, '2026-02-01', 'collection', 0),
      (103, 1, 'alpha', 2, 1, '2026-02-01', 'collection', 1),
      (105, 1, 'alpha', 0, 1, '2026-03-01', 'collection', 0),
      (201, 1, 'beta', 1, 1, '2026-01-01', 'collection', 0),
      (202, 1, 'beta', 1, NULL, '2026-02-01', 'collection', 0),
      (203, 1, 'gamma', 5, 1, '2026-01-01', 'collection', 0),
      (300, 1, 'alpha', 99, NULL, '2026-09-01', 'arena', 0),
      (301, 1, 'alpha', 99, NULL, '2026-09-01', 'wishlist', 0),
      (302, 1, 'alpha', 99, NULL, '2026-09-01', 'graveyard', 0),
      (401, 2, 'alpha', 9, 2, '2026-09-01', 'collection', 0)`);

    const expected = new Map([[105, 0], [103, 2], [104, 4], [102, 2], [201, 1], [202, 1]]);
    assert.deepStrictEqual([...await checkedOutAllocation(1)], [...expected], 'located/newest/tied copies reserve greedily, even when missing; shortfalls cannot borrow another inventory');
    assert.deepStrictEqual([...await checkedOutAllocation(1, 1)], [[105, 0], [103, 2], [104, 1]], 'excluding the source deck releases only its reservations');
    for (const [userId, excluded] of [[1, null], [1, 1], [1, 2], [1, 5], [1, 6], [1, 999], [2, null], [3, null]]) {
      assert.deepStrictEqual([...await checkedOutAllocation(userId, excluded)], [...await originalAllocation(userId, excluded)]);
    }
    assert.deepStrictEqual([...await checkedOutAllocation(2)], [[401, 1]], 'other users reserve only their own copies');
    assert.deepStrictEqual([...await checkedOutAllocation(3)], [], 'an empty deck allocates nothing');

    // Exact strings, not sets: preserve duplicate deck names, ordering, nulls,
    // and the existing metadata across inventories (only allocation is physical).
    const originalNames = new Map((await db.all(`
      SELECT c.id,
        (SELECT GROUP_CONCAT(d.name, ', ') FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
         WHERE dc.card_id = c.card_id AND d.user_id = c.user_id AND d.checked_out = 1) AS deck_names
      FROM collection c
    `)).map(row => [row.id, row.deck_names]));
    for (const userId of [1, 2, 3]) {
      for (const list_type of ['collection', 'arena', 'wishlist', 'graveyard']) {
        const rows = await collection(userId, { list_type });
        const ids = await db.all(`SELECT id FROM collection WHERE user_id = ? AND list_type = ?`, [userId, list_type]);
        assert.deepStrictEqual(rows.map(row => row.entry_id).sort((a, b) => a - b), ids.map(row => row.id).sort((a, b) => a - b));
        for (const row of rows) {
          assert.strictEqual(row.deck_names, originalNames.get(row.entry_id));
          assert.strictEqual(row.checked_out_qty, list_type === 'collection' ? (userId === 1 ? expected.get(row.entry_id) || 0 : 1) : 0);
        }
      }
    }
    const physical = await collection(1);
    assert.strictEqual(physical.find(row => row.card_id === 'gamma').deck_names, null, 'unchecked decks do not label a card');
    assert.strictEqual(physical.find(row => row.card_id === 'alpha').deck_names, 'Zulu, Echo, Echo, Arena', 'deck-name metadata retains its original inventory-independent meaning');

    await db.run(`UPDATE decks SET checked_out = 0`);
    assert.deepStrictEqual([...await checkedOutAllocation(1)], []);
    assert.ok((await collection(1)).every(row => row.checked_out_qty === 0 && row.deck_names === null), 'checking in every deck clears reservations and labels');
    console.log('Collection allocation and deck-name SQLite regression passed');
  } finally {
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
