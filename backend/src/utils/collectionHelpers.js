// Shared helpers for the collection/storage/import routes. Kept in one neutral
// module so the split route files (collection, storage, importExport) never have
// to import each other.
const db = require('../db');
const { recommendSlot, compartmentLabel, locationAcceptsCard, STACK_KEY_SQL } = require('./compartmentSort');
const { rebalanceCompartmentPositions } = require('./priceHelpers');

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

async function physicalCardEntries(userId, cardId = null, legacyCheckout = false) {
  return db.all(`
    SELECT c.id AS entry_id, c.card_id, c.quantity, c.position, c.location_id, c.compartment_id,
      c.printing, c.language, c.condition, c.game,
      cc.name AS card_name, cc.printed_name, cc.set_name, cc.number,
      su.name AS storage_unit_name,
      l.name AS location_name, l.type AS location_type, cp.label AS compartment_label, cp.idx AS compartment_idx
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id
    LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
    LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = c.user_id
    LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
    WHERE c.user_id = ? AND c.list_type = 'collection' AND (? OR COALESCE(c.missing, 0) = 0)
      AND c.quantity > 0 AND c.game = cc.game AND (? IS NULL OR c.card_id = ?)
      AND (c.location_id IS NULL OR (l.id IS NOT NULL AND l.inventory_type = 'collection'))
      AND (c.compartment_id IS NULL OR cp.id IS NOT NULL)
    ORDER BY c.card_id, (c.location_id IS NOT NULL) DESC, c.added_at DESC, c.id ${legacyCheckout ? 'ASC' : 'DESC'}
  `, [userId, legacyCheckout ? 1 : 0, cardId, cardId]);
}

function sourceEntries(entries, card, game) {
  const matching = entries.filter(entry => entry.card_id === card.card_id && entry.game === game);
  if (card.source_entry_id == null) return matching;
  const lead = matching.find(entry => entry.entry_id === card.source_entry_id);
  if (!lead) return [];
  return [lead, ...matching.filter(entry => entry.entry_id !== lead.entry_id
    && entry.location_id === lead.location_id && entry.compartment_id === lead.compartment_id)];
}

// New checkouts retain exact entries. Legacy checkouts are allocated once at
// startup; the fallback also supports old backups without allocation records.
async function checkedOutSources(userId) {
  const sources = await db.all(`
    SELECT a.* FROM deck_card_allocations a JOIN decks d ON d.id = a.deck_id
    WHERE d.user_id = ? AND d.checked_out = 1 AND d.inventory_type = 'collection'
  `, [userId]);
  const legacy = await db.all(`
    SELECT dc.*, d.game FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
    WHERE d.user_id = ? AND d.checked_out = 1 AND d.inventory_type = 'collection'
      AND dc.quantity > 0 AND NOT EXISTS (
        SELECT 1 FROM deck_card_allocations a WHERE a.deck_id = dc.deck_id AND a.card_id = dc.card_id
      )
    ORDER BY (dc.source_entry_id IS NOT NULL) DESC, d.id, dc.card_id
  `, [userId]);
  if (!legacy.length) return sources;
  const entries = await physicalCardEntries(userId, null, true);
  const allocated = new Map();
  for (const row of sources) allocated.set(row.entry_id, (allocated.get(row.entry_id) || 0) + row.quantity);
  for (const card of legacy) {
    let needed = card.quantity;
    for (const entry of sourceEntries(entries, card, card.game)) {
      if (needed <= 0) break;
      const take = Math.min(needed, Math.max(0, entry.quantity - (allocated.get(entry.entry_id) || 0)));
      if (!take) continue;
      sources.push({ deck_id: card.deck_id, card_id: card.card_id, entry_id: entry.entry_id, quantity: take });
      allocated.set(entry.entry_id, (allocated.get(entry.entry_id) || 0) + take);
      needed -= take;
    }
  }
  return sources;
}

async function checkedOutAllocation(userId, excludeDeckId = null) {
  const allocated = new Map();
  for (const source of await checkedOutSources(userId)) {
    if (Number(excludeDeckId) === source.deck_id) continue;
    allocated.set(source.entry_id, (allocated.get(source.entry_id) || 0) + source.quantity);
  }
  return allocated;
}

// List status uses usable inventory, not the return guide (which keeps archived sources).
async function deckMissingCards(decks, userId) {
  const missing = new Map(decks.map(deck => [deck.id, 0]));
  if (!decks.length) return missing;
  const cards = await db.all(`SELECT dc.* FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
    WHERE d.user_id = ? AND d.game = 'mtg' AND dc.quantity > 0`, [userId]);
  const entriesByCard = new Map();
  for (const entry of await physicalCardEntries(userId)) {
    if (!entriesByCard.has(entry.card_id)) entriesByCard.set(entry.card_id, []);
    entriesByCard.get(entry.card_id).push(entry);
  }
  const allocated = new Map();
  const ownAllocations = new Map();
  for (const source of await checkedOutSources(userId)) {
    allocated.set(source.entry_id, (allocated.get(source.entry_id) || 0) + source.quantity);
    if (!ownAllocations.has(source.deck_id)) ownAllocations.set(source.deck_id, new Map());
    const own = ownAllocations.get(source.deck_id);
    own.set(source.entry_id, (own.get(source.entry_id) || 0) + source.quantity);
  }
  const nonphysical = new Map();
  for (const row of await db.all(`SELECT c.list_type, c.card_id, SUM(c.quantity) AS quantity
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id AND cc.game = c.game
    WHERE c.user_id = ? AND c.list_type IN ('arena', 'graveyard') AND c.game = 'mtg' AND c.quantity > 0
    GROUP BY c.list_type, c.card_id`, [userId])) {
    nonphysical.set(`${row.list_type}:${row.card_id}`, row.quantity);
  }
  const decksById = new Map(decks.map(deck => [deck.id, deck]));
  for (const card of cards) {
    const deck = decksById.get(card.deck_id);
    if (!deck) continue;
    let available = 0;
    if (deck.inventory_type === 'arena' || deck.inventory_type === 'graveyard') {
      available = nonphysical.get(`${deck.inventory_type}:${card.card_id}`) || 0;
    } else {
      const entries = entriesByCard.get(card.card_id) || [];
      const candidates = deck.checked_out
        ? entries.filter(entry => entry.game === deck.game)
        : sourceEntries(entries, card, deck.game);
      for (const entry of candidates) {
        const own = ownAllocations.get(deck.id)?.get(entry.entry_id) || 0;
        const usable = Math.max(0, entry.quantity - (allocated.get(entry.entry_id) || 0) + own);
        // A checked-out deck cannot silently replace an archived reserved copy.
        available += deck.checked_out ? Math.min(own, usable) : usable;
        if (available >= card.quantity) break;
      }
    }
    missing.set(deck.id, missing.get(deck.id) + Math.max(0, card.quantity - available));
  }
  return missing;
}

function sourcePlacement(entry) {
  return {
    ...entry,
    location_name: entry.location_name || 'Unassigned Pile',
    compartment_display: entry.compartment_idx != null
      ? compartmentLabel({ label: entry.compartment_label, idx: entry.compartment_idx }, entry.location_type)
      : entry.compartment_label,
    position: entry.location_id == null ? null : entry.position
  };
}

async function deckCardSources(userId, deckId, cardId, sourceEntryId = null) {
  const allocated = await checkedOutAllocation(userId, deckId);
  const groups = new Map();
  for (const entry of await physicalCardEntries(userId, cardId)) {
    if (entry.game !== 'mtg') continue;
    const key = `${entry.location_id}:${entry.compartment_id}`;
    let group = groups.get(key);
    if (!group) {
      group = { entry_id: entry.entry_id, location_id: entry.location_id, compartment_id: entry.compartment_id,
        location_name: entry.location_name || 'Unassigned Pile',
        storage_unit_name: entry.storage_unit_name,
        compartment_display: sourcePlacement(entry).compartment_display,
        position: entry.location_id == null ? null : entry.position, quantity: 0, available: 0, entry_count: 0 };
      groups.set(key, group);
    }
    if (entry.entry_id === sourceEntryId) group.entry_id = sourceEntryId;
    group.quantity += entry.quantity;
    group.available += Math.max(0, entry.quantity - (allocated.get(entry.entry_id) || 0));
    if (++group.entry_count > 1) group.position = null;
  }
  return [...groups.values()];
}

async function validateDeckSource(userId, deckId, cardId, quantity, sourceEntryId, { mode = 'addition', savedSourceEntryId = null } = {}) {
  if (sourceEntryId == null) return;
  const deck = await db.get('SELECT inventory_type FROM decks WHERE id = ? AND user_id = ?', [deckId, userId]);
  if (!deck || (deck.inventory_type || 'collection') !== 'collection') {
    throw Object.assign(new Error('Only Physical decks can select physical sources'), { status: 400 });
  }
  if (mode === 'draft') {
    // Saved preferences can outlive inventory, including deleted-entry restore tombstones.
    if (sourceEntryId === savedSourceEntryId) return;
    const source = await db.get(`SELECT id FROM collection
      WHERE id = ? AND user_id = ? AND card_id = ? AND list_type = 'collection' AND game = 'mtg'`,
    [sourceEntryId, userId, cardId]);
    if (!source) {
      throw Object.assign(new Error('Selected source must belong to this card in your Physical inventory.'), { status: 400 });
    }
    return;
  }
  const source = (await deckCardSources(userId, deckId, cardId, sourceEntryId)).find(entry => entry.entry_id === sourceEntryId);
  if (!source || source.available < quantity) {
    throw Object.assign(new Error('Selected source is unavailable or does not have enough copies. Choose another source or Automatic.'), { status: 400 });
  }
}

// The pull list and checkout share this plan. A return reads the recorded
// entries, including missing copies, instead of allocating different cards.
async function deckLocations(deck, userId) {
  if ((deck.inventory_type || 'collection') !== 'collection') {
    throw Object.assign(new Error('Only Physical decks have physical card locations'), { status: 400 });
  }
  const cards = await db.all(`SELECT dc.*, cc.name, cc.printed_name FROM deck_cards dc
    JOIN card_cache cc ON cc.id = dc.card_id WHERE dc.deck_id = ? AND dc.quantity > 0`, [deck.id]);
  const entries = deck.checked_out
    ? await db.all(`
        SELECT c.id AS entry_id, c.card_id, c.position, c.location_id, c.compartment_id,
          cc.name AS card_name, cc.printed_name, cc.set_name, cc.number,
          su.name AS storage_unit_name,
          l.name AS location_name, l.type AS location_type, cp.label AS compartment_label, cp.idx AS compartment_idx
        FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
        LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = c.user_id
        LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
        WHERE c.user_id = ?
      `, [userId])
    : await physicalCardEntries(userId);
  const allocated = deck.checked_out ? null : await checkedOutAllocation(userId, deck.id);
  const actual = deck.checked_out ? (await checkedOutSources(userId)).filter(row => row.deck_id === deck.id) : [];
  return cards.map(card => {
    let needed = card.quantity;
    const locations = [];
    const candidates = deck.checked_out ? entries.filter(entry => entry.card_id === card.card_id) : sourceEntries(entries, card, deck.game);
    for (const entry of candidates) {
      if (needed <= 0) break;
      let take;
      if (deck.checked_out) {
        take = actual.find(row => row.card_id === card.card_id && row.entry_id === entry.entry_id)?.quantity || 0;
      } else {
        const available = Math.max(0, entry.quantity - (allocated.get(entry.entry_id) || 0));
        take = Math.min(needed, available);
      }
      if (!take) continue;
      needed -= take;
      locations.push({ ...sourcePlacement(entry), take, card_name: entry.printed_name || entry.card_name });
    }
    return { card_id: card.card_id, card_name: card.printed_name || card.name,
      source_entry_id: card.source_entry_id, required: card.quantity,
      found: card.quantity - needed, missing: needed, locations };
  });
}

async function reserveDeckSources(deck, userId) {
  const plan = await deckLocations(deck, userId);
  const missing = plan.filter(card => card.missing > 0);
  if (missing.length) {
    throw Object.assign(new Error(missing.some(card => card.source_entry_id != null)
      ? 'Selected source is unavailable or does not have enough copies. Choose another source or Automatic.'
      : 'Not enough cards available to check out this deck.'),
    { status: 400, details: missing.map(card => `Missing ${card.missing}x ${card.card_name}`) });
  }
  for (const card of plan) {
    for (const location of card.locations) {
      await db.run(`INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)`,
        [deck.id, card.card_id, location.entry_id, location.take]);
    }
  }
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
  if (!recommended) return { compartment_id: null, position: 0, rejected: true };
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

// The caller holds a transaction. Reuse whole single copies, split only the
// selected quantity from legacy stacks, and leave remaining source copies intact.
async function moveContainerCopies(userId, locationId, compartmentId, entries, quantity) {
  if (quantity <= 0 || entries.length === 0) return;
  await rebalanceCompartmentPositions(db, compartmentId, userId);
  const occupied = await db.get(
    `SELECT COUNT(*) AS count FROM collection WHERE compartment_id = ? AND user_id = ?`,
    [compartmentId, userId]
  );
  let slot = occupied.count;
  const sources = new Set();
  for (const entry of entries) {
    if (quantity <= 0) break;
    const copies = Math.min(quantity, entry.available);
    quantity -= copies;
    const originalUsed = copies === entry.quantity;
    if (originalUsed) {
      await db.run(`
        UPDATE collection SET quantity = 1, location_id = ?, compartment_id = ?, position = ?
        WHERE id = ? AND user_id = ?
      `, [locationId, compartmentId, ++slot * 1000, entry.id, userId]);
    } else {
      await db.run(`UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?`, [copies, entry.id, userId]);
    }
    for (let copy = originalUsed ? 1 : 0; copy < copies; copy++) {
      await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          favorite, is_trade, list_type, game, added_at, notes, grader, grade,
          cert_number, market_value, market_value_source, market_value_at, missing,
          location_id, compartment_id, position
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        entry.card_id, userId, entry.condition, entry.printing, entry.language, entry.purchase_price,
        entry.favorite, entry.is_trade, entry.list_type, entry.game, entry.added_at, entry.notes, entry.grader,
        entry.grade, entry.cert_number, entry.market_value, entry.market_value_source, entry.market_value_at, entry.missing,
        locationId, compartmentId, ++slot * 1000
      ]);
    }
    if (entry.compartment_id) sources.add(entry.compartment_id);
  }
  for (const source of sources) await rebalanceCompartmentPositions(db, source, userId);
}
module.exports = {
  defaultCompartmentPlan,
  physicalCardEntries,
  sourceEntries,
  moveContainerCopies,
  checkedOutAllocation,
  checkedOutSources,
  deckMissingCards,
  deckCardSources,
  validateDeckSource,
  deckLocations,
  reserveDeckSources,
  assertStorageInventory,
  resolveCompartmentAndPosition,
  describePlacement,
  normalizeRuleConfig,
  setStackQuantity,
};
