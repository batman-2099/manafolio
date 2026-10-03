const express = require('express');
const db = require('../db');
const {
  recommendSlot,
  compartmentLabel,
  loadCompartments,
  locationAcceptsCard,
  compartmentAcceptsCard,
  sortCards,
  rebalanceCompartmentByScheme,
  STACK_KEY_SQL
} = require('../utils/compartmentSort');
const { defaultCompartmentPlan, normalizeRuleConfig, assertStorageInventory, checkedOutSources } = require('../utils/collectionHelpers');
const { normalizeMtgColorIdentity } = require('../utils/mtgColors');
const storageUnitTypes = require('../../../shared/storageUnitTypes.json');
const { normalizeUploadedImage } = require('../utils/uploadedImage');
const { createHash } = require('crypto');

const MANA_SYMBOLS = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G', Colorless: 'C' };

const router = express.Router();

// The card rows behind a list of collection entry ids, keyed by id.
//
// One query for the whole batch. Both batch endpoints below used to run this same
// SELECT once per entry inside their loop — filing 200 cards meant 200 round trips
// to fetch data one statement could return — and they carried two near-identical
// copies of the column list, which had already drifted apart (one aliased entry_id
// and selected image_url, the other did neither).
//
// Callers index this by id so they keep iterating entry_ids in the order the client
// sent: placement is sequential, each card filling the slot the one before it left.
async function loadEntries(entryIds, userId) {
  if (!entryIds.length) return new Map();
  const holes = entryIds.map(() => '?').join(',');
  const rows = await db.all(`
    SELECT c.id, c.id AS entry_id, c.card_id, c.quantity, c.printing, c.language, c.favorite, c.is_trade, c.list_type,
           cc.name, cc.printed_name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.supertype, cc.rarity, cc.image_url,
           cc.game, cc.cmc, cc.color_identity,
           cc.price_trend, cc.price_normal, cc.price_holofoil
    FROM collection c
    JOIN card_cache cc ON c.card_id = cc.id
    WHERE c.user_id = ? AND c.id IN (${holes})
  `, [userId, ...entryIds]);
  for (const r of rows) {
    try { r.types = JSON.parse(r.types || '[]'); } catch { r.types = []; }
  }
  return new Map(rows.map(r => [String(r.id), r]));
}

const UNIT_COVER_ROWS = `
  SELECT su.id AS storage_unit_id, su.cover_card_id, c.card_id, c.added_at, c.id AS entry_id,
         cc.name, cc.game, cc.image_url
  FROM storage_units su
  JOIN locations l ON l.storage_unit_id = su.id AND l.user_id = su.user_id
  JOIN collection c ON c.location_id = l.id AND c.user_id = su.user_id
    AND COALESCE(c.list_type, 'collection') = l.inventory_type
  JOIN card_cache cc ON cc.id = c.card_id
  WHERE su.user_id = ? AND l.inventory_type IN ('collection', 'graveyard')
    AND cc.game = 'mtg' AND cc.image_url IS NOT NULL AND cc.image_url != ''
`;

router.get('/storage-units', async (req, res) => {
  try {
    const units = await db.all(`
      WITH eligible_covers AS (${UNIT_COVER_ROWS}),
      ranked_covers AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY storage_unit_id
          ORDER BY CASE WHEN card_id = cover_card_id THEN 0 ELSE 1 END, added_at DESC, entry_id ASC
        ) AS cover_rank FROM eligible_covers
      )
      SELECT su.id, su.name, su.type, su.cover_card_id, su.cover_image, COUNT(l.id) AS container_count,
             cover.card_id AS resolved_cover_card_id, cover.name AS cover_name,
             cover.game AS cover_game, cover.image_url AS cover_image_url
      FROM storage_units su
      LEFT JOIN locations l ON l.storage_unit_id = su.id AND l.user_id = su.user_id
      LEFT JOIN ranked_covers cover ON cover.storage_unit_id = su.id AND cover.cover_rank = 1
      WHERE su.user_id = ?
      GROUP BY su.id ORDER BY su.name COLLATE NOCASE, su.id
    `, [req.user.id, req.user.id]);
    res.json(units.map(({ resolved_cover_card_id, cover_name, cover_game, cover_image_url, ...unit }) => ({
      ...unit,
      cover: unit.cover_image ? {
        card_id: null, name: unit.name, game: 'mtg', image_url: unit.cover_image,
      } : resolved_cover_card_id ? {
        card_id: resolved_cover_card_id, name: cover_name, game: cover_game, image_url: cover_image_url,
      } : null,
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve storage units' });
  }
});

router.get('/storage-units/:id/cover-choices', async (req, res) => {
  try {
    if (!await db.get('SELECT id FROM storage_units WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])) {
      return res.status(404).json({ error: 'Storage unit not found' });
    }
    res.json(await db.all(`
      WITH eligible_covers AS (${UNIT_COVER_ROWS})
      SELECT card_id, name, game, image_url FROM eligible_covers
      WHERE storage_unit_id = ?
      GROUP BY card_id ORDER BY name COLLATE NOCASE, card_id
    `, [req.user.id, req.params.id]));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve storage unit cover choices' });
  }
});

router.post('/storage-units', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Storage unit name is required' });
  const type = req.body.type === undefined ? 'Other' : req.body.type;
  if (!storageUnitTypes.includes(type)) return res.status(400).json({ error: 'Invalid storage unit type' });
  try {
    const result = await db.run('INSERT INTO storage_units (user_id, name, type) VALUES (?, ?, ?)', [req.user.id, name, type]);
    res.status(201).json({ id: result.lastID, name, type, container_count: 0, cover_card_id: null, cover_image: null, cover: null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create storage unit' });
  }
});

router.put('/storage-units/:id', async (req, res) => {
  const name = req.body.name === undefined ? undefined : typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name !== undefined && !name) return res.status(400).json({ error: 'Storage unit name is required' });
  const { type, cover_card_id, cover_image } = req.body;
  if (type !== undefined && !storageUnitTypes.includes(type)) return res.status(400).json({ error: 'Invalid storage unit type' });
  try {
    if (!await db.get('SELECT id FROM storage_units WHERE id = ? AND user_id = ?', [req.params.id, req.user.id])) {
      return res.status(404).json({ error: 'Storage unit not found' });
    }
    if (Object.hasOwn(req.body, 'cover_image') && Object.hasOwn(req.body, 'cover_card_id')) {
      return res.status(400).json({ error: 'Choose either an uploaded image or a card image' });
    }
    const image = cover_image === undefined ? null : await normalizeUploadedImage(cover_image, 980, 700);
    const changeCover = cover_image !== undefined || cover_card_id !== undefined;
    if (cover_card_id !== undefined && cover_card_id !== null) {
      if (typeof cover_card_id !== 'string' || !await db.get(`
        WITH eligible_covers AS (${UNIT_COVER_ROWS})
        SELECT card_id FROM eligible_covers WHERE storage_unit_id = ? AND card_id = ? LIMIT 1
      `, [req.user.id, req.params.id, cover_card_id])) {
        return res.status(400).json({ error: 'Choose a card image from this storage unit' });
      }
    }
    await db.run(`
      UPDATE storage_units SET name = COALESCE(?, name), type = COALESCE(?, type),
        cover_card_id = CASE WHEN ? THEN ? ELSE cover_card_id END,
        cover_image = CASE WHEN ? THEN ? ELSE cover_image END
      WHERE id = ? AND user_id = ?
    `, [name ?? null, type ?? null, changeCover ? 1 : 0, cover_card_id ?? null,
      changeCover ? 1 : 0, image, req.params.id, req.user.id]);
    res.json({ message: 'Storage unit updated' });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to update storage unit' });
  }
});

router.delete('/storage-units/:id', async (req, res) => {
  try {
    // ON DELETE SET NULL detaches containers atomically without touching their contents.
    const result = await db.run('DELETE FROM storage_units WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!result.changes) return res.status(404).json({ error: 'Storage unit not found' });
    res.json({ message: 'Storage unit deleted; containers are now unassigned' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete storage unit' });
  }
});

async function validateStorageUnit(id, userId) {
  if (id == null) return;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(new Error('Invalid storage_unit_id'), { status: 400 });
  }
  if (!await db.get('SELECT id FROM storage_units WHERE id = ? AND user_id = ?', [id, userId])) {
    throw Object.assign(new Error('Storage unit not found'), { status: 404 });
  }
}

// 1. Get Storage Locations with Compartment Summaries
router.get('/locations', async (req, res) => {
  if (req.query?.game !== undefined && req.query.game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  const inventoryType = req.query.inventory_type || 'collection';
  if (!['collection', 'graveyard'].includes(inventoryType)) return res.status(400).json({ error: 'Invalid inventory_type' });
  try {
    // Subqueries, not a joined SUM: joining compartments to collection fans each
    // compartment row out once per card, which inflated total_capacity by the
    // card count. Correlated aggregates keep each sum independent.
    const locations = await db.all(`
      WITH ranked_covers AS (
        SELECT c.location_id, c.card_id,
               ROW_NUMBER() OVER (
                 PARTITION BY c.location_id
                 ORDER BY CASE WHEN c.card_id = l.cover_card_id THEN 0 ELSE 1 END,
                          c.added_at DESC, c.id ASC
               ) AS cover_rank
        FROM collection c
        JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id AND l.inventory_type = c.list_type
        JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.list_type = ? AND cc.game = 'mtg'
          AND cc.image_url IS NOT NULL AND cc.image_url != ''
      )
      SELECT l.*, su.name AS storage_unit_name, cover.id AS resolved_cover_card_id, cover.name AS cover_name,
             cover.game AS cover_game, cover.image_url AS cover_image_url,
             (SELECT COUNT(*) FROM compartments WHERE location_id = l.id) as compartment_count,
             (SELECT COALESCE(SUM(capacity), 0) FROM compartments WHERE location_id = l.id) as total_capacity,
             -- Measured against total_capacity, which counts slots: on a stacking
             -- container the duplicates sharing a pocket are one occupant, so
             -- counting cards there would report a nine-pocket page as overfull.
             (SELECT CASE WHEN l.allow_stacking
                       THEN COUNT(DISTINCT COALESCE(compartment_id, 0) || '|' || ${STACK_KEY_SQL})
                       ELSE COALESCE(SUM(quantity), 0) END
                FROM collection
                WHERE user_id = l.user_id AND COALESCE(list_type, 'collection') = l.inventory_type
                  AND compartment_id IN (SELECT id FROM compartments WHERE location_id = l.id)) as total_cards
      FROM locations l
      LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = l.user_id
      LEFT JOIN ranked_covers rc ON rc.location_id = l.id AND rc.cover_rank = 1
      LEFT JOIN card_cache cover ON cover.id = rc.card_id
      WHERE l.user_id = ? AND l.inventory_type = ?
    `, [req.user.id, inventoryType, req.user.id, inventoryType]);
    const identities = await db.all(`
      SELECT DISTINCT c.location_id, cc.types AS card_colors
      FROM collection c
      JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
        AND l.inventory_type = COALESCE(c.list_type, 'collection')
      JOIN card_cache cc ON cc.id = c.card_id
      WHERE l.user_id = ? AND l.inventory_type = ? AND cc.game = 'mtg' AND c.quantity > 0
    `, [req.user.id, inventoryType]);
    const manaByLocation = new Map();
    for (const { location_id, card_colors } of identities) {
      let identity;
      try { identity = JSON.parse(card_colors); } catch { continue; }
      if (!Array.isArray(identity) || identity.some(color => typeof color !== 'string')) continue;
      const colors = manaByLocation.get(location_id) || new Set();
      // MTG types stores card colors, not Commander identity (which includes rules text).
      if (!identity.length) colors.add('C');
      for (const color of normalizeMtgColorIdentity(identity)) {
        if (color !== 'Colorless' && MANA_SYMBOLS[color]) colors.add(MANA_SYMBOLS[color]);
      }
      manaByLocation.set(location_id, colors);
    }
    res.json(locations.map(({ resolved_cover_card_id, cover_name, cover_game, cover_image_url, ...location }) => ({
      ...location,
      mana_symbols: Object.values(MANA_SYMBOLS).filter(symbol => manaByLocation.get(location.id)?.has(symbol)),
      cover: resolved_cover_card_id ? {
        card_id: resolved_cover_card_id, name: cover_name, game: cover_game, image_url: cover_image_url,
      } : null,
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve locations' });
  }
});

const RULE_TYPES = ['any', 'alphabetical_range', 'specific_sets', 'compound'];
const GAME_RESTRICTIONS = ['mtg'];

router.post('/locations', async (req, res) => {
  const { name, type, sort_order = 'name-asc', foil_sorting = 'normals_first', rule_type = 'any', rule_config, compartmentPlan, game = 'mtg', inventory_type = 'collection', sleeved = 0, storage_unit_id } = req.body;
  if (!['collection', 'graveyard'].includes(inventory_type)) return res.status(400).json({ error: 'Invalid inventory_type' });
  if (!Number.isInteger(sleeved) || sleeved < 0 || sleeved > 3) {
    return res.status(400).json({ error: 'Sleeved must be an integer between 0 and 3' });
  }

  if (!name || !type) {
    return res.status(400).json({ error: 'name and type are required' });
  }
  if (!RULE_TYPES.includes(rule_type)) {
    return res.status(400).json({ error: 'Invalid rule_type' });
  }
  if (!GAME_RESTRICTIONS.includes(game)) {
    return res.status(400).json({ error: 'Invalid game restriction' });
  }
  let ruleConfigJson;
  try {
    ruleConfigJson = normalizeRuleConfig(rule_config);
  } catch {
    return res.status(400).json({ error: 'rule_config must be valid JSON' });
  }
  try {
    await validateStorageUnit(storage_unit_id, req.user.id);
    const existing = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [name, req.user.id]);
    if (existing) {
      return res.status(400).json({ error: 'A location with this name already exists' });
    }

    const result = await db.run(`
      INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id, inventory_type, sleeved, storage_unit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [name, type, sort_order, foil_sorting || 'normals_first', rule_type, ruleConfigJson, game, req.user.id, inventory_type, sleeved, storage_unit_id ?? null]);

    const plan = compartmentPlan || defaultCompartmentPlan(type);
    await db.createCompartments(result.lastID, Math.max(1, parseInt(plan.count, 10) || 1), Math.max(1, parseInt(plan.capacity, 10) || 40));

    res.status(200).json({ message: 'Location created', id: result.lastID });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to create location' });
  }
});

router.get('/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT l.*, su.name AS storage_unit_name FROM locations l
      LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = l.user_id
      WHERE l.id = ? AND l.user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    res.json(loc);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve location' });
  }
});

// A read-only snapshot keeps abandoned/cancelled stocktakes out of persistence.
async function stocktakeSnapshot(userId, locationId) {
  const location = await db.get('SELECT * FROM locations WHERE id = ? AND user_id = ?', [locationId, userId]);
  if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
  const compartments = await db.all('SELECT * FROM compartments WHERE location_id = ? ORDER BY id', [location.id]);
  const rows = await db.all(`SELECT c.*, cc.name, cc.printed_name, cc.set_name, cc.set_id, cc.number, cc.image_url
    FROM collection c LEFT JOIN card_cache cc ON cc.id = c.card_id
    WHERE c.user_id = ? AND c.location_id = ? ORDER BY c.compartment_id, c.position, c.id`, [userId, location.id]);
  if (rows.some(row => row.list_type !== location.inventory_type)) {
    throw Object.assign(new Error('Container inventory has changed. Correct its placements before checking it.'), { status: 409, code: 'stocktake.stale' });
  }
  const ids = new Set(rows.map(row => row.id));
  const reservations = (await checkedOutSources(userId)).filter(source => ids.has(source.entry_id))
    .sort((a, b) => a.entry_id - b.entry_id || a.deck_id - b.deck_id || a.card_id.localeCompare(b.card_id));
  const revision = createHash('sha256').update(JSON.stringify([location, compartments, rows, reservations])).digest('hex');
  return {
    location, revision,
    entries: rows.map(row => ({
      entry_id: row.id, card_id: row.card_id, name: row.name, printed_name: row.printed_name,
      set_name: row.set_name, set_id: row.set_id, number: row.number, image_url: row.image_url, game: row.game,
      quantity: row.quantity, printing: row.printing, language: row.language, condition: row.condition,
      missing: row.missing, position: row.position,
      compartment_label: compartmentLabel(compartments.find(comp => comp.id === row.compartment_id), location.type),
      reserved_quantity: reservations.filter(source => source.entry_id === row.id).reduce((sum, source) => sum + source.quantity, 0),
    })),
  };
}

router.get('/locations/:id/stocktake', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await db.withTransaction(() => stocktakeSnapshot(req.user.id, req.params.id)));
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not load stocktake', code: error.code });
  }
});

router.post('/locations/:id/stocktake', async (req, res) => {
  const { revision, decisions } = req.body;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || !Array.isArray(decisions)
      || !decisions.length || decisions.some(item => !item || !Number.isSafeInteger(item.entry_id)
        || !['verified', 'missing'].includes(item.status)
        || (item.status === 'missing' && (!Number.isSafeInteger(item.missing_quantity) || item.missing_quantity < 1)))
      || new Set(decisions.map(item => item.entry_id)).size !== decisions.length) {
    return res.status(400).json({ error: 'Choose entries to verify or mark missing.', code: 'stocktake.invalid' });
  }
  try {
    const result = await db.withTransaction(async () => {
      const snapshot = await stocktakeSnapshot(req.user.id, req.params.id);
      if (snapshot.revision !== revision) {
        throw Object.assign(new Error('Container, cards or reservations changed. Close and restart the stocktake.'), { status: 409, code: 'stocktake.stale' });
      }
      const entries = new Map(snapshot.entries.map(entry => [entry.entry_id, entry]));
      for (const decision of decisions) {
        const entry = entries.get(decision.entry_id);
        if (!entry) throw Object.assign(new Error('Entry is not in this container.'), { status: 400, code: 'stocktake.invalid' });
        if (decision.status === 'missing' && decision.missing_quantity > entry.quantity) {
          throw Object.assign(new Error('Missing quantity must not exceed the entry quantity.'), { status: 400, code: 'stocktake.invalid' });
        }
        // Never review even the unreserved part of a checked-out row.
        if (entry.reserved_quantity > 0) {
          throw Object.assign(new Error('Check in the deck before reviewing reserved entries.'), { status: 409, code: 'stocktake.reservedError' });
        }
        if (decision.status === 'missing' && decision.missing_quantity < entry.quantity) {
          const original = await db.get('SELECT cert_number FROM collection WHERE id = ? AND user_id = ?', [entry.entry_id, req.user.id]);
          if (original.cert_number) {
            throw Object.assign(new Error('A certified copy cannot be split. Correct its quantity before taking stock.'), { status: 400, code: 'stocktake.invalid' });
          }
        }
      }
      for (const decision of decisions) {
        const entry = entries.get(decision.entry_id);
        const missingQuantity = decision.status === 'missing' ? decision.missing_quantity : 0;
        if (missingQuantity > 0 && missingQuantity < entry.quantity) {
          const foundQuantity = entry.quantity - missingQuantity;
          // Keep the found copies' identity so an unchecked-out deck's selected source stays usable.
          // A non-stacking row spans quantity slots; stacking copies share the original slot.
          await db.run(`INSERT INTO collection (
              card_id, user_id, quantity, condition, printing, language, purchase_price,
              favorite, is_trade, list_type, game, added_at, notes, grader, grade,
              cert_number, market_value, market_value_source, market_value_at, missing,
              location_id, compartment_id, position
            )
            SELECT card_id, user_id, ?, condition, printing, language, purchase_price,
              favorite, is_trade, list_type, game, added_at, notes, grader, grade,
              cert_number, market_value, market_value_source, market_value_at, 1,
              location_id, compartment_id, position + ?
            FROM collection WHERE id = ? AND user_id = ?`,
          [missingQuantity, snapshot.location.allow_stacking ? 0 : foundQuantity * 1000, entry.entry_id, req.user.id]);
          await db.run('UPDATE collection SET quantity = ?, missing = 0 WHERE id = ? AND user_id = ?',
            [foundQuantity, entry.entry_id, req.user.id]);
        } else {
          await db.run('UPDATE collection SET missing = ? WHERE id = ? AND user_id = ?',
            [missingQuantity > 0 ? 1 : 0, entry.entry_id, req.user.id]);
        }
      }
      const lastCheckedAt = new Date().toISOString();
      await db.run('UPDATE locations SET last_checked_at = ? WHERE id = ? AND user_id = ?',
        [lastCheckedAt, snapshot.location.id, req.user.id]);
      return { last_checked_at: lastCheckedAt };
    });
    res.json(result);
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Could not apply stocktake', code: error.code });
  }
});

router.post('/locations/:id/transfer', async (req, res) => {
  const { id } = req.params;
  const { inventory_type } = req.body;
  try {
    const result = await db.withTransaction(async () => {
      if (!['collection', 'graveyard'].includes(inventory_type)) {
        throw Object.assign(new Error('Invalid inventory_type'), { status: 400 });
      }
      const location = await db.get('SELECT id, inventory_type, locked FROM locations WHERE id = ? AND user_id = ?', [id, req.user.id]);
      if (!location) throw Object.assign(new Error('Location not found'), { status: 404 });
      if (location.inventory_type === inventory_type) return { id: location.id, inventory_type, affected: 0 };
      if (location.locked || await db.get('SELECT id FROM compartments WHERE location_id = ? AND locked = 1 LIMIT 1', [id])) {
        throw Object.assign(new Error('Unlock this container and its compartments before transferring'), { status: 409 });
      }
      if (inventory_type === 'graveyard') {
        // Persist legacy reservations before their copies leave physical inventory.
        for (const source of await checkedOutSources(req.user.id)) {
          await db.run(`INSERT OR IGNORE INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)`,
            [source.deck_id, source.card_id, source.entry_id, source.quantity]);
        }
      }
      const updated = await db.run(`
        UPDATE collection SET list_type = ? WHERE user_id = ?
          AND (location_id = ? OR compartment_id IN (SELECT id FROM compartments WHERE location_id = ?))
      `, [inventory_type, req.user.id, id, id]);
      await db.run('UPDATE locations SET inventory_type = ? WHERE id = ? AND user_id = ?', [inventory_type, id, req.user.id]);
      return { id: location.id, inventory_type, affected: updated.changes };
    });
    res.json({ message: 'Container transferred', ...result });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to transfer container' });
  }
});

router.put('/locations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, type, sort_order, foil_sorting, rule_type, rule_config, game, locked, allow_stacking, sleeved, storage_unit_id } = req.body;
  if (sleeved !== undefined && (!Number.isInteger(sleeved) || sleeved < 0 || sleeved > 3)) {
    return res.status(400).json({ error: 'Sleeved must be an integer between 0 and 3' });
  }
  if (rule_type !== undefined && !RULE_TYPES.includes(rule_type)) {
    return res.status(400).json({ error: 'Invalid rule_type' });
  }
  if (game !== undefined && !GAME_RESTRICTIONS.includes(game)) {
    return res.status(400).json({ error: 'Invalid game restriction' });
  }
  let ruleConfigJson;
  try {
    ruleConfigJson = rule_config !== undefined ? normalizeRuleConfig(rule_config) : undefined;
  } catch {
    return res.status(400).json({ error: 'rule_config must be valid JSON' });
  }
  try {
    const loc = await db.get(`SELECT id, game, sort_order, foil_sorting, inventory_type FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }
    await validateStorageUnit(storage_unit_id, req.user.id);
    if (loc.game != null && !['mtg', 'any'].includes(loc.game)) {
      return res.status(400).json({ error: 'Unsupported game' });
    }
    if (req.body.inventory_type !== undefined && req.body.inventory_type !== loc.inventory_type) {
      return res.status(400).json({ error: 'Container inventory cannot be changed after creation' });
    }
    const { cover_card_id } = req.body;
    if (cover_card_id !== undefined && cover_card_id !== null) {
      if (typeof cover_card_id !== 'string' || !await db.get(
        `SELECT c.id FROM collection c JOIN card_cache cc ON cc.id = c.card_id
         WHERE c.location_id = ? AND c.user_id = ? AND c.card_id = ? AND COALESCE(c.list_type, 'collection') = ? AND cc.image_url IS NOT NULL AND cc.image_url != ''`,
        [id, req.user.id, cover_card_id, loc.inventory_type]
      )) return res.status(400).json({ error: 'Choose a card image from this container' });
    }

    if (name) {
      const dup = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ? AND id != ?`, [name, req.user.id, id]);
      if (dup) {
        return res.status(400).json({ error: 'A location with this name already exists' });
      }
    }

    // Switching to Custom: bake the outgoing scheme into stored positions so the
    // manual order starts from the currently-sorted layout instead of stale
    // positions (which would render jumbled). Must run before the UPDATE, while
    // loc.sort_order still holds the old scheme.
    if (sort_order === 'custom' && loc.sort_order && loc.sort_order !== 'custom') {
      const comps = await db.all(`SELECT id FROM compartments WHERE location_id = ?`, [id]);
      for (const c of comps) {
        await rebalanceCompartmentByScheme(db, c.id, loc.sort_order, foil_sorting || loc.foil_sorting);
      }
    }

    await db.run(`
      UPDATE locations
      SET
        name = COALESCE(?, name),
        type = COALESCE(?, type),
        sort_order = COALESCE(?, sort_order),
        foil_sorting = COALESCE(?, foil_sorting),
        rule_type = COALESCE(?, rule_type),
        rule_config = COALESCE(?, rule_config),
        game = COALESCE(?, game),
        locked = COALESCE(?, locked),
        allow_stacking = COALESCE(?, allow_stacking),
        sleeved = COALESCE(?, sleeved),
        storage_unit_id = CASE WHEN ? THEN ? ELSE storage_unit_id END,
        cover_card_id = CASE WHEN ? THEN ? ELSE cover_card_id END
      WHERE id = ? AND user_id = ?
    `, [name, type, sort_order, foil_sorting, rule_type, ruleConfigJson, game,
        locked === undefined ? null : (locked ? 1 : 0),
        allow_stacking === undefined ? null : (allow_stacking ? 1 : 0),
        sleeved ?? null,
        storage_unit_id !== undefined ? 1 : 0, storage_unit_id ?? null,
        cover_card_id !== undefined ? 1 : 0, cover_card_id ?? null,
        id, req.user.id]);

    let evicted = 0;
    if (rule_type !== undefined || rule_config !== undefined || game !== undefined) {
      const updated = await db.get(`SELECT id, rule_type, rule_config, game, inventory_type FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      const stored = await db.all(`
        SELECT c.id as entry_id, c.printing, c.language, c.favorite, c.is_trade, c.list_type,
               cc.name, cc.printed_name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype, cc.game,
               cc.price_trend, cc.price_normal, cc.price_holofoil, cc.cmc, cc.color_identity
        FROM collection c
        JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.location_id = ? AND c.user_id = ? AND COALESCE(c.list_type, 'collection') = ?
      `, [id, req.user.id, loc.inventory_type]);
      for (const entry of stored) {
        entry.printing = entry.printing || 'Normal';
        entry.language = entry.language || 'English';
        try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }
        if (!locationAcceptsCard(updated, entry)) {
          await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [entry.entry_id, req.user.id]);
          evicted++;
        }
      }
    }
    res.json({ message: 'Location updated', evicted });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

router.delete('/locations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) {
      return res.status(404).json({ error: 'Location not found' });
    }

    await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE location_id = ? AND user_id = ?`, [id, req.user.id]);

    await db.run(`DELETE FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    res.json({ message: 'Location deleted successfully (any stored cards moved to Unsorted)' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete location' });
  }
});

// 6b. Manage Compartments
router.get('/locations/:id/compartments', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const compartments = await loadCompartments(db, id, req.user.id);
    res.json(compartments.map(c => ({ ...c, display_label: compartmentLabel(c, loc.type) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve compartments' });
  }
});

router.post('/locations/:id/compartments', async (req, res) => {
  const { id } = req.params;
  try {
    const loc = await db.get(`SELECT id, type FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });

    const last = await db.get(`SELECT MAX(idx) as maxIdx, capacity FROM compartments WHERE location_id = ? ORDER BY idx DESC LIMIT 1`, [id]);
    const nextIdx = (last && last.maxIdx ? last.maxIdx : 0) + 1;
    const capacity = (last && last.capacity) ? last.capacity : (loc.type === 'Binder' ? 9 : 400);

    const result = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, ?, ?)`, [id, nextIdx, capacity]);
    const created = await db.get(`SELECT * FROM compartments WHERE id = ?`, [result.lastID]);
    res.status(201).json({ ...created, display_label: compartmentLabel(created, loc.type) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to add compartment' });
  }
});

router.put('/locations/:id/compartments/:comp_id', async (req, res) => {
  const { id, comp_id } = req.params;
  const { label, capacity, rule_config, assignedFilters, locked } = req.body;
  try {
    const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!loc) return res.status(404).json({ error: 'Location not found' });
    const comp = await getOwnedCompartment(comp_id, req.user.id);
    if (!comp || comp.loc_id !== Number(id)) return res.status(404).json({ error: 'Compartment not found' });

    let ruleConfigJson;
    if (rule_config !== undefined) {
      try {
        ruleConfigJson = normalizeRuleConfig(rule_config);
      } catch {
        return res.status(400).json({ error: 'rule_config must be valid JSON' });
      }
    }

    await db.withTransaction(async () => {
      await updateCompartment(comp, { label, capacity, rule_config: ruleConfigJson, locked });
      if (Array.isArray(assignedFilters)) await replaceCompartmentFilters(comp_id, assignedFilters);
    });

    res.json({ message: 'Compartment updated successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

async function deleteCompartment(req, res) {
  const nested = req.params.comp_id !== undefined;
  const id = nested ? req.params.comp_id : req.params.id;
  try {
    const result = await db.withTransaction(async () => {
      if (nested) {
        const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [req.params.id, req.user.id]);
        if (!loc) return { status: 404, error: 'Location not found' };
      }
      const comp = await getOwnedCompartment(id, req.user.id);
      if (!comp || (nested && comp.loc_id !== Number(req.params.id))) return { status: 404, error: 'Compartment not found' };
      const total = await db.get(`SELECT COUNT(*) AS count FROM compartments WHERE location_id = ?`, [comp.loc_id]);
      if (total.count <= 1) return { status: 400, error: 'Cannot delete the last compartment of a location' };
      await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE compartment_id = ? AND user_id = ?`, [id, req.user.id]);
      await db.run(`DELETE FROM compartments WHERE id = ? AND location_id = ?`, [id, comp.loc_id]);
      return { message: `Compartment deleted${nested ? ' successfully' : ''} (cards inside moved to Unsorted)` };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete compartment' });
  }
}

router.delete('/locations/:id/compartments/:comp_id', deleteCompartment);

// Flat compartment routes (compartment id is globally unique). The storage UI
// edits rows/pages by bare compartment id; resolve the owning location for auth.
async function getOwnedCompartment(compId, userId) {
  return db.get(`
    SELECT cp.*, l.id AS loc_id, l.type AS loc_type, l.sort_order, l.foil_sorting, l.inventory_type
    FROM compartments cp JOIN locations l ON cp.location_id = l.id
    WHERE cp.id = ? AND l.user_id = ?`, [compId, userId]);
}

async function updateCompartment(comp, { label, capacity, rule_config, locked }, updateAll = false) {
  if (capacity !== undefined) {
    const cap = Math.max(1, parseInt(capacity, 10) || 1);
    if (updateAll) await db.run(`UPDATE compartments SET capacity = ? WHERE location_id = ?`, [cap, comp.loc_id]);
    else await db.run(`UPDATE compartments SET capacity = ? WHERE id = ?`, [cap, comp.id]);
  }
  if (label !== undefined) await db.run(`UPDATE compartments SET label = ? WHERE id = ?`, [label || null, comp.id]);
  if (locked !== undefined) await db.run(`UPDATE compartments SET locked = ? WHERE id = ?`, [locked ? 1 : 0, comp.id]);
  if (rule_config !== undefined) await db.run(`UPDATE compartments SET rule_config = ? WHERE id = ?`, [rule_config, comp.id]);
}

async function replaceCompartmentFilters(id, filters) {
  await db.run(`DELETE FROM compartment_assignments WHERE compartment_id = ?`, [id]);
  for (const filterVal of filters) {
    if (filterVal) await db.run(`INSERT OR IGNORE INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)`, [id, filterVal]);
  }
}

router.patch('/compartments/:id', async (req, res) => {
  const { id } = req.params;
  const updateAll = req.query.updateAll === 'true';
  const { label, capacity, rule_config, locked } = req.body;
  try {
    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });

    let ruleConfigJson;
    if (rule_config !== undefined) {
      try { ruleConfigJson = normalizeRuleConfig(rule_config); }
      catch { return res.status(400).json({ error: 'rule_config must be valid JSON' }); }
    }

    await updateCompartment(comp, { label, capacity, rule_config: ruleConfigJson, locked }, updateAll);

    // Evict cards this row/page no longer accepts after a rule change.
    let evicted = 0;
    if (rule_config !== undefined) {
      const cfg = ruleConfigJson ? JSON.parse(ruleConfigJson) : null;
      const compForCheck = { ruleConfig: cfg };
      const stored = await db.all(`
        SELECT c.id AS entry_id, c.printing, c.language,
               cc.name, cc.printed_name, cc.set_name, cc.number, cc.types, cc.subtypes, cc.rarity, cc.supertype, cc.game,
               cc.price_trend, cc.cmc, cc.color_identity
        FROM collection c JOIN card_cache cc ON c.card_id = cc.id
        WHERE c.compartment_id = ? AND c.user_id = ? AND COALESCE(c.list_type, 'collection') = ?`, [id, req.user.id, comp.inventory_type]);
      for (const entry of stored) {
        try { entry.types = JSON.parse(entry.types || '[]'); } catch { entry.types = []; }
        if (!compartmentAcceptsCard(compForCheck, entry)) {
          await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [entry.entry_id, req.user.id]);
          evicted++;
        }
      }
    }
    res.json({ message: 'Compartment updated', evicted });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update compartment' });
  }
});

router.delete('/compartments/:id', deleteCompartment);

router.put('/compartments/:id/filters', async (req, res) => {
  const { id } = req.params;
  const { filters } = req.body;
  try {
    const comp = await getOwnedCompartment(id, req.user.id);
    if (!comp) return res.status(404).json({ error: 'Compartment not found' });
    await db.withTransaction(() => replaceCompartmentFilters(id, Array.isArray(filters) ? filters : []));
    res.json({ message: 'Filters updated' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update filters' });
  }
});

// Recommendation endpoints
router.post('/locations/:id/recommend', async (req, res) => {
  const { id } = req.params;
  const { card_id, printing = 'Normal', language = 'English', list_type = 'collection' } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    assertStorageInventory(location, list_type);

    const cardMetadata = await db.get(`SELECT name, set_name, number, types, subtypes, price_trend, price_normal, price_holofoil, supertype, rarity, game, cmc, color_identity FROM card_cache WHERE id = ?`, [card_id]);
    if (!cardMetadata) return res.status(404).json({ error: 'Card not found in cache' });
    cardMetadata.printing = printing;
    cardMetadata.language = language;
    cardMetadata.list_type = list_type;
    cardMetadata.card_id = card_id;
    try { cardMetadata.types = JSON.parse(cardMetadata.types || '[]'); } catch { cardMetadata.types = []; }

    if (!locationAcceptsCard(location, cardMetadata)) {
      return res.json({ rejected: true });
    }

    const recommendation = await recommendSlot(db, location, cardMetadata);
    if (!recommendation) return res.json({ rejected: true });
    res.json(recommendation);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to compute recommendation' });
  }
});

router.post('/locations/:id/recommend-batch', async (req, res) => {
  const { id } = req.params;
  const { entry_ids = [] } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) return res.status(400).json({ error: 'entry_ids is required' });

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    const mockCards = [];
    const recommendations = [];

    const entries = await loadEntries(entry_ids, req.user.id);
    for (const entry of entries.values()) assertStorageInventory(location, entry.list_type);

    for (const entryId of entry_ids) {
      const entry = entries.get(String(entryId));
      if (!entry) continue;

      if (!locationAcceptsCard(location, entry)) {
        recommendations.push({ entry, recommended: null, rejected: true });
        continue;
      }

      const recommended = await recommendSlot(db, location, entry, workingCompartments, mockCards);
      if (!recommended) {
        recommendations.push({ entry, recommended: null, rejected: true });
        continue;
      }

      recommendations.push({ entry, recommended });

      if (!recommended.stacked) {
        workingCompartments = workingCompartments.map(c =>
          c.id === recommended.compartment_id ? { ...c, count: c.count + (location.allow_stacking ? 1 : entry.quantity), free: c.free - (location.allow_stacking ? 1 : entry.quantity) } : c
        );
      }

      // card_id and position, not just the display fields: on a stacking
      // container they are what lets the next copy in this same batch recognise
      // its twin and land in the pocket this one just claimed.
      mockCards.push({
        entry_id: entry.entry_id,
        card_id: entry.card_id,
        quantity: entry.quantity,
        position: recommended.position,
        compartment_id: recommended.compartment_id,
        image_url: entry.image_url,
        printing: entry.printing,
        language: entry.language,
        name: entry.name,
        supertype: entry.supertype,
        types: JSON.stringify(entry.types),
        rarity: entry.rarity,
        set_name: entry.set_name,
        number: entry.number,
        cmc: entry.cmc,
        color_identity: entry.color_identity,
        price_trend: entry.price_trend,
        price_normal: entry.price_normal,
        price_holofoil: entry.price_holofoil
      });
    }

    res.json(recommendations);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to compute batch recommendations' });
  }
});

router.post('/locations/:id/apply-all', async (req, res) => {
  const { id } = req.params;
  const { entry_ids = [] } = req.body;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
      return res.status(400).json({ error: 'entry_ids is required' });
    }

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    let filed = 0;

    const entries = await loadEntries(entry_ids, req.user.id);
    for (const entry of entries.values()) assertStorageInventory(location, entry.list_type);

    for (const entryId of entry_ids) {
      const entry = entries.get(String(entryId));
      if (!entry) continue;

      const recommended = await recommendSlot(db, location, entry, workingCompartments);
      if (!recommended) continue;

      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [
        recommended.location_id || id, recommended.compartment_id, recommended.position, entryId, req.user.id
      ]);

      if (!recommended.stacked) {
        workingCompartments = workingCompartments.map(c =>
          c.id === recommended.compartment_id ? { ...c, count: c.count + (location.allow_stacking ? 1 : entry.quantity), free: c.free - (location.allow_stacking ? 1 : entry.quantity) } : c
        );
      }
      filed++;
    }

    res.json({ message: `Filed ${filed} of ${entry_ids.length} card(s).`, filed, total: entry_ids.length });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to apply batch' });
  }
});

router.post('/locations/:id/resort', async (req, res) => {
  const { id } = req.params;
  try {
    const location = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!location) return res.status(404).json({ error: 'Location not found' });
    if (location.locked) return res.status(409).json({ error: 'Unlock this container before re-sorting' });

    const cards = await db.all(`
      SELECT c.id as entry_id, c.card_id, c.printing, c.language, c.quantity, c.favorite, c.is_trade, c.list_type,
             cc.name, cc.printed_name, cc.set_name, cc.number, cc.types, cc.rarity, cc.supertype, cc.image_url, cc.game,
             cc.price_trend, cc.price_normal, cc.price_holofoil, cc.cmc, cc.color_identity
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.location_id = ? AND c.user_id = ? AND COALESCE(c.list_type, 'collection') = ?
        AND (c.compartment_id IS NULL OR c.compartment_id IN (SELECT id FROM compartments WHERE locked = 0))
    `, [id, req.user.id, location.inventory_type]);
    cards.forEach(c => { try { c.types = JSON.parse(c.types || '[]'); } catch { c.types = []; } });

    if (cards.length === 0) return res.json([]);

    await db.run(`UPDATE collection SET compartment_id = NULL, position = 0 WHERE id IN (${cards.map(() => '?').join(',')}) AND user_id = ?`, [...cards.map(card => card.entry_id), req.user.id]);

    const ordered = sortCards(cards, location.sort_order, location.foil_sorting);

    let workingCompartments = await loadCompartments(db, id, req.user.id);
    const results = [];

    for (const entry of ordered) {
      const recommended = await recommendSlot(db, location, entry, workingCompartments, []);
      if (!recommended) { results.push({ entry, recommended: null }); continue; }

      const finalLoc = recommended.location_id || Number(id);
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [
        finalLoc, recommended.compartment_id, recommended.position, entry.entry_id, req.user.id
      ]);
      results.push({ entry, recommended });

      if (finalLoc === Number(id) && !recommended.stacked) {
        workingCompartments = workingCompartments.map(c =>
          c.id === recommended.compartment_id ? { ...c, count: c.count + (location.allow_stacking ? 1 : entry.quantity), free: c.free - (location.allow_stacking ? 1 : entry.quantity) } : c
        );
      }
    }

    res.json(results);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to re-sort container' });
  }
});

module.exports = router;
