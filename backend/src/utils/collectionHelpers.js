// Shared helpers for the collection/storage/import routes. Kept in one neutral
// module so the split route files (collection, storage, importExport) never have
// to import each other.
const db = require('../db');
const { recommendSlot, compartmentLabel, locationAcceptsCard, STACK_KEY_SQL } = require('./compartmentSort');

// Default compartment plan by container type — used when a caller doesn't
// specify one at creation time (see POST /locations).
function defaultCompartmentPlan(type) {
  if (type === 'Binder') return { count: 10, capacity: 9 };
  if (type === 'Toploader Binder') return { count: 8, capacity: 4 };
  if (type === 'Box') return { count: 2, capacity: 400 };
  if (type === 'Toploader Box') return { count: 1, capacity: 100 };
  if (type === 'Graded Slab Box') return { count: 1, capacity: 40 };
  if (type === 'Display Shelf / Stand') return { count: 1, capacity: 10 };
  if (type === 'Deck Box') return { count: 1, capacity: 60 };
  if (type === 'Tin / Case') return { count: 1, capacity: 200 };
  return { count: 1, capacity: 500 };
}

// How many copies of each collection entry are physically pulled for a
// checked-out deck. Sums required quantity per card across all of the user's
// checked-out decks, then allocates greedily onto their owned entries using the
// same ordering the checkout locator uses (located copies first, newest first),
// so storage greys out the same copies the wizard told them to grab.
async function checkedOutAllocation(userId, excludeDeckId = null) {
  const entries = await db.all(`
    WITH required AS (
      SELECT dc.card_id, SUM(dc.quantity) AS req
      FROM deck_cards dc
      JOIN decks d ON dc.deck_id = d.id
      WHERE d.user_id = ? AND d.checked_out = 1 AND d.inventory_type = 'collection' AND (? IS NULL OR d.id != ?)
      GROUP BY dc.card_id
    )
    SELECT c.id AS entry_id, c.card_id, c.quantity, r.req
    FROM collection c
    JOIN required r ON r.card_id = c.card_id
    WHERE c.user_id = ? AND c.list_type = 'collection'
    ORDER BY c.card_id, (c.location_id IS NOT NULL) DESC, c.added_at DESC
  `, [userId, excludeDeckId, excludeDeckId, userId]);
  const alloc = new Map();
  let cardId;
  let need = 0;
  for (const entry of entries) {
    if (entry.card_id !== cardId) {
      cardId = entry.card_id;
      need = entry.req;
    }
    if (need <= 0) continue;
    const take = Math.min(entry.quantity, need);
    need -= take;
    alloc.set(entry.entry_id, take);
  }
  return alloc;
}

function assertStorageInventory(location, listType = 'collection') {
  if ((location.inventory_type || 'collection') !== listType) {
    throw Object.assign(new Error('Cards and containers must belong to the same inventory.'), { status: 400 });
  }
}

// Resolves where a card should actually land.
async function resolveCompartmentAndPosition(opts) {
  const {
    locationId: locId,
    compartmentId,
    position,
    userId: uId,
    cardId: cId,
    printing,
    language,
    listType = 'collection',
    quantity = 1,
    excludeEntryId
  } = opts;

  if (compartmentId !== undefined && compartmentId !== null) {
    const compartment = await db.get(`
      SELECT c.id, c.idx, c.label, c.capacity, l.id as loc_id, l.type as loc_type, l.name as loc_name, l.allow_stacking, l.inventory_type
      FROM compartments c JOIN locations l ON c.location_id = l.id
      WHERE c.id = ? AND l.user_id = ?
    `, [compartmentId, uId]);
    if (!compartment) throw Object.assign(new Error('Invalid compartment'), { status: 400 });
    assertStorageInventory(compartment, listType);
    if (locId && Number(locId) !== compartment.loc_id) throw Object.assign(new Error('Compartment does not belong to this container'), { status: 400 });

    // On a stacking container the slot count is what fills up, not the card count.
    let countQuery = `SELECT ${compartment.allow_stacking ? `COUNT(DISTINCT ${STACK_KEY_SQL})` : 'SUM(quantity)'} as cnt FROM collection WHERE compartment_id = ? AND user_id = ? AND COALESCE(list_type, 'collection') = ?`;
    let countParams = [compartmentId, uId, listType];
    if (excludeEntryId) {
      countQuery += ` AND id != ?`;
      countParams.push(excludeEntryId);
    }
    const countRow = await db.get(countQuery, countParams);
    if ((countRow.cnt || 0) + (compartment.allow_stacking ? 1 : quantity) > compartment.capacity) {
      throw Object.assign(new Error('COMPARTMENT_FULL'), { status: 400 });
    }

    const label = `${compartmentLabel(compartment, compartment.loc_type)} (in ${compartment.loc_name})`;
    if (position !== undefined) return { compartment_id: compartmentId, position, label, location_id: compartment.loc_id };
    return { compartment_id: compartmentId, position: ((countRow?.cnt || 0) + 1) * 1000, label, location_id: compartment.loc_id };
  }
  if (!locId) {
    return { compartment_id: null, position: position !== undefined ? position : 0 };
  }

  const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [locId, uId]);
  if (!location) throw Object.assign(new Error('Invalid location ID'), { status: 400 });
  assertStorageInventory(location, listType);

  let cardMetadata = await db.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [cId]);
  if (!cardMetadata) cardMetadata = { name: cId || '', types: [] };
  // card_cache has no id column selected above, and a stacking container matches
  // a copy against its twin by card id — so carry it on explicitly.
  cardMetadata.card_id = cId;
  cardMetadata.list_type = listType;
  cardMetadata.quantity = quantity;
  cardMetadata.entry_id = excludeEntryId;
  cardMetadata.printing = printing || 'Normal';
  cardMetadata.language = language || 'English';
  try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

  if (!locationAcceptsCard(location, cardMetadata)) {
    return { compartment_id: null, position: 0, rejected: true };
  }

  const recommended = await recommendSlot(db, location, cardMetadata);
  if (!recommended) return { compartment_id: null, position: 0, full: true };
  return { compartment_id: recommended.compartment_id, position: recommended.position, location_id: recommended.location_id, label: recommended.label };
}

async function describePlacement(database, entryId, userId) {
  const row = await database.get(`
    SELECT c.compartment_id, c.position, c.location_id,
           cp.idx, cp.label, l.type as loc_type, l.name as loc_name
    FROM collection c
    JOIN compartments cp ON c.compartment_id = cp.id
    JOIN locations l ON cp.location_id = l.id
    WHERE c.id = ? AND c.user_id = ?
  `, [entryId, userId]);
  if (!row) return null;
  const seq = Math.max(1, Math.round((row.position || 0) / 1000));
  const label = `${compartmentLabel(row, row.loc_type)}, Pos ${seq} (in ${row.loc_name})`;
  return { location_id: row.location_id, compartment_id: row.compartment_id, position: row.position, label };
}

function normalizeRuleConfig(rule_config) {
  if (rule_config === undefined || rule_config === null || rule_config === '') return null;
  if (typeof rule_config === 'string') { JSON.parse(rule_config); return rule_config; }
  return JSON.stringify(rule_config);
}

// One physical card = one row. Split any legacy stacked entry (quantity > 1)
// into that many single-card rows so every copy takes its own storage slot,
// gets its own popup, and can be added to a deck individually. Idempotent:
// once run there are no quantity>1 rows, so a re-run is a no-op.
// ponytail: split copies keep the original's compartment with fractional
// position offsets (same as the add path). A page that overflows its capacity
// shows extra pockets; a manual re-sort redistributes if desired.
async function splitStackedEntries(database) {
  const dbClient = database || db;
  const stacked = await dbClient.all(`SELECT * FROM collection WHERE quantity > 1`);
  if (stacked.length === 0) return 0;
  let created = 0;
  for (const e of stacked) {
    const copies = e.quantity;
    await dbClient.run(`UPDATE collection SET quantity = 1 WHERE id = ?`, [e.id]);
    for (let i = 1; i < copies; i++) {
      await dbClient.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, favorite, list_type, game
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        e.card_id, e.user_id, e.condition, e.printing, e.language, e.purchase_price,
        e.location_id, e.compartment_id, (e.position || 0) + i * 0.001, e.is_trade, e.favorite, e.list_type, e.game
      ]);
      created++;
    }
  }
  return created;
}

// The rows the collection view stacks together with this one: same card, same
// printing details, same list. Ordered as trim candidates — unplaced copies
// first, then newest — so a copy already filed into a binder is the last one
// removed. The edited row itself is excluded: it is never the row deleted.
async function stackSiblings(dbClient, userId, row, entryId) {
  return dbClient.all(`
    SELECT id, quantity FROM collection
    WHERE user_id = ? AND card_id = ? AND condition = ? AND printing = ?
      AND language = ? AND list_type = ? AND id != ?
    ORDER BY (location_id IS NULL) DESC, id DESC
  `, [userId, row.card_id, row.condition, row.printing, row.language, row.list_type, entryId]);
}

// Make the number of copies this stack represents equal `target`, keeping the
// edited row. The quantity field in the card popup is absolute — "how many of
// these I own" — and the stacked collection view sums the identical rows into
// that one number, so the edit has to reconcile the whole group both ways.
// Growing inserts single-card rows (one physical card = one row, mirroring the
// edited row's placement); shrinking removes the trim candidates first and only
// then reduces the edited row's own quantity, which a legacy stacked row can
// still have above 1. Returns the net change in copies.
async function setStackQuantity(database, userId, entryId, target) {
  const dbClient = database || db;
  const row = await dbClient.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [entryId, userId]);
  if (!row) return 0;
  const siblings = await stackSiblings(dbClient, userId, row, entryId);

  const start = (row.quantity || 1) + siblings.reduce((n, s) => n + (s.quantity || 1), 0);
  let current = start;

  for (let i = 0; current < target; i++, current++) {
    await dbClient.run(`
      INSERT INTO collection (
        card_id, user_id, quantity, condition, printing, language, purchase_price,
        location_id, compartment_id, position, is_trade, favorite, list_type, game
      ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      row.card_id, userId, row.condition, row.printing, row.language, row.purchase_price,
      row.location_id, row.compartment_id, (row.position || 0) + (i + 1) * 0.001,
      row.is_trade, row.favorite, row.list_type, row.game
    ]);
  }

  for (const s of siblings) {
    if (current <= target) break;
    const have = s.quantity || 1;
    const drop = Math.min(have, current - target);
    current -= drop;
    if (drop >= have) {
      await dbClient.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [s.id, userId]);
    } else {
      await dbClient.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [drop, s.id, userId]);
    }
  }

  if (current > target) {
    await dbClient.run(`UPDATE collection SET quantity = ? WHERE id = ? AND user_id = ?`, [target, entryId, userId]);
    current = target;
  }

  return current - start;
}

module.exports = {
  defaultCompartmentPlan,
  checkedOutAllocation,
  assertStorageInventory,
  resolveCompartmentAndPosition,
  describePlacement,
  normalizeRuleConfig,
  splitStackedEntries,
  setStackQuantity,
};
