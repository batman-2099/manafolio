const express = require('express');
const router = express.Router();
const db = require('../db');
const { parseThirdPartyCSV, parseManaboxText } = require('../utils/csvMappers');
const scryfallApi = require('../scryfallApi');
const { generateExportCSV } = require('../utils/csvExporters');
const { resolveCardPrice } = require('../utils/priceHelpers');
const { isBinderType } = require('../utils/compartmentSort');
const { assertStorageInventory, checkedOutSources, moveContainerCopies } = require('../utils/collectionHelpers');
const { normalizeCardBack } = require('../utils/cardBack');
const storageUnitTypes = require('../../../shared/storageUnitTypes.json');
const validImportQuantity = quantity => Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 2147483647;

function parseCsvRows(data) {
  const lines = typeof data === 'string' ? data.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
  if (lines.length <= 1) throw new Error('CSV file is empty or missing headers');

  const parseLine = (line) => {
    const values = [];
    let value = '';
    let quoted = false;
    for (const char of line) {
      if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) {
        values.push(value.trim());
        value = '';
      } else value += char;
    }
    values.push(value.trim());
    return values.map(cell => cell.replace(/^"|"$/g, ''));
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine)
    .filter(values => values.length >= headers.length)
    .map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])));
  return { headers, rows };
}
function csvFormat(headers, format) {
  const names = headers.map(header => header.toLowerCase());
  if (['name', 'set code', 'card number'].every(header => names.includes(header))) return 'manabox';
  if (['count', 'name', 'edition', 'collector number'].every(header => names.includes(header))) return 'arena';
  return format;
}


async function parseCompleteBackup(data) {
  const backup = typeof data === 'string' ? JSON.parse(data) : data;
  const arrays = ['collection', 'card_cache', 'locations', 'compartments', 'compartment_assignments', 'decks', 'deck_cards'];
  if (!backup || backup.format !== 'manafolio-backup' || backup.version !== 1 || !arrays.every(key => Array.isArray(backup[key]))) {
    throw new Error('Invalid backup file');
  }
  const storageUnits = backup.storage_units === undefined ? [] : backup.storage_units;
  if (!Array.isArray(storageUnits) || storageUnits.some(unit => !unit
      || !Number.isSafeInteger(unit.id) || unit.id < 1
      || typeof unit.name !== 'string' || !unit.name.trim()
      || (unit.type !== undefined && !storageUnitTypes.includes(unit.type)))
      || new Set(storageUnits.map(unit => unit.id)).size !== storageUnits.length) {
    throw new Error('Invalid backup storage units');
  }
  const storageUnitIds = new Set(storageUnits.map(unit => unit.id));
  if (backup.locations.some(location => location.storage_unit_id != null && !storageUnitIds.has(location.storage_unit_id))) {
    throw new Error('Invalid backup storage unit references');
  }
  if (backup.decks.some(deck => !['collection', 'arena', 'graveyard'].includes(deck.inventory_type ?? 'collection')
      || ((deck.inventory_type ?? 'collection') !== 'collection' && (deck.checked_out || deck.checked_out_at != null)))) {
    throw new Error('Invalid backup deck inventory or checkout state');
  }
  if (backup.decks.some(deck => ['wins', 'losses'].some(key => Object.hasOwn(deck, key)
      && (!Number.isInteger(deck[key]) || deck[key] < 0 || deck[key] > 2147483647)))) {
    throw new Error('Invalid backup deck record');
  }
  if (backup.decks.some(deck => Object.hasOwn(deck, 'sleeved')
      && (!Number.isInteger(deck.sleeved) || deck.sleeved < 0 || deck.sleeved > 3))) {
    throw new Error('Invalid backup deck sleeves');
  }
  if (backup.decks.some(deck => deck.notes != null && typeof deck.notes !== 'string')) {
    throw new Error('Invalid backup deck notes');
  }
  if (backup.locations.some(location => Object.hasOwn(location, 'sleeved')
      && (!Number.isInteger(location.sleeved) || location.sleeved < 0 || location.sleeved > 3))) {
    throw new Error('Invalid backup container sleeves');
  }
  for (const deck of backup.decks) {
    Object.assign(deck, await normalizeCardBack({
      color: Object.hasOwn(deck, 'card_back_color') ? deck.card_back_color : null,
      image: Object.hasOwn(deck, 'card_back_image') ? deck.card_back_image : null
    }, true));
  }
  if (['card_cache', 'collection', 'decks'].some(key =>
    backup[key].some(row => row.game != null && row.game !== 'mtg'))
    || backup.locations.some(location => location.game != null && !['any', 'mtg'].includes(location.game))
    || backup.card_cache.some(card => typeof card.id !== 'string'
      || (card.game !== 'mtg' && !card.id.startsWith('mtg-')))) {
    throw Object.assign(new Error('Unsupported backup card ID or game'), { status: 400 });
  }

  const cardIds = new Set(backup.card_cache.map(card => card.id));
  const locationIds = new Set(backup.locations.map(location => location.id));
  const compartmentIds = new Set(backup.compartments.map(compartment => compartment.id));
  const deckIds = new Set(backup.decks.map(deck => deck.id));
  const entries = new Map(backup.collection.map(entry => [entry.id, entry]));
  const allocations = backup.deck_card_allocations ?? [];
  if (!Array.isArray(allocations)
      || backup.deck_cards.some(card => card.source_entry_id != null && (
        !Number.isSafeInteger(card.source_entry_id) || card.source_entry_id === 0
        || (entries.has(card.source_entry_id) && entries.get(card.source_entry_id).card_id !== card.card_id)
        || (backup.decks.find(deck => deck.id === card.deck_id)?.inventory_type ?? 'collection') !== 'collection'))
      || allocations.some(source => !Number.isSafeInteger(source.entry_id) || source.entry_id === 0
        || !Number.isSafeInteger(source.quantity) || source.quantity < 1
        || (backup.decks.find(deck => deck.id === source.deck_id)?.inventory_type ?? 'collection') !== 'collection'
        || !backup.deck_cards.some(card => card.deck_id === source.deck_id && card.card_id === source.card_id)
        || (entries.has(source.entry_id) && entries.get(source.entry_id).card_id !== source.card_id))) {
    throw new Error('Invalid backup deck sources');
  }
  if (
    backup.card_cache.some(card => !card.id || !card.name)
    || backup.locations.some(location => !location.id || !location.name || !location.type || !['collection', 'graveyard'].includes(location.inventory_type ?? 'collection'))
    || backup.compartments.some(compartment => !compartment.id || !locationIds.has(compartment.location_id))
    || backup.compartment_assignments.some(assignment => !compartmentIds.has(assignment.compartment_id))
    || backup.collection.some(card => !cardIds.has(card.card_id) || (card.location_id != null && !locationIds.has(card.location_id)) || (card.compartment_id != null && !compartmentIds.has(card.compartment_id)))
    || backup.deck_cards.some(card => !cardIds.has(card.card_id) || !deckIds.has(card.deck_id))
    || backup.decks.some(deck => deck.commander_card_id != null && (
      typeof deck.commander_card_id !== 'string'
      || deck.game !== 'mtg'
      || !/commander|edh|brawl/i.test(deck.format)
      || !backup.deck_cards.some(card => card.deck_id === deck.id && card.card_id === deck.commander_card_id && card.quantity > 0)
    ))
  ) {
    throw new Error('Invalid backup references');
  }
  const locations = new Map(backup.locations.map(location => [location.id, location]));
  const compartments = new Map(backup.compartments.map(compartment => [compartment.id, compartment]));
  for (const card of backup.collection) {
    const location = locations.get(card.location_id);
    if (location) assertStorageInventory(location, card.list_type ?? 'collection');
    if (card.compartment_id != null && compartments.get(card.compartment_id).location_id !== card.location_id) {
      throw new Error('Invalid backup compartment placement');
    }
  }
  return backup;
}

async function restoreCompleteBackup(backup, userId) {
  const storageUnitIds = new Map();
  const locationIds = new Map();
  const compartmentIds = new Map();
  const deckIds = new Map();
  const entryIds = new Map();
  // Deleted sources stay invalid even when restoring into a different database
  // where their old positive ID could belong to somebody else's collection.
  const restoredEntryId = id => entryIds.get(id) ?? -Math.abs(id);

  await db.withTransaction(async () => {
    const unsupported = await db.get(`
      SELECT id FROM collection WHERE user_id = ? AND game NOT IN ('mtg')
      UNION ALL SELECT id FROM decks WHERE user_id = ? AND game NOT IN ('mtg')
      UNION ALL SELECT id FROM locations WHERE user_id = ? AND game NOT IN ('mtg', 'any')
      UNION ALL SELECT c.id FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND cc.game NOT IN ('mtg')
      UNION ALL SELECT d.id FROM decks d JOIN deck_cards dc ON dc.deck_id = d.id
        JOIN card_cache cc ON cc.id = dc.card_id WHERE d.user_id = ? AND cc.game NOT IN ('mtg')
      LIMIT 1
    `, [userId, userId, userId, userId, userId]);
    if (unsupported) {
      throw Object.assign(new Error('Restore would replace unsupported stored records; export them before restoring into a separate account'), { status: 400 });
    }
    for (const card of backup.card_cache) {
      const cached = await db.get('SELECT game FROM card_cache WHERE id = ?', [card.id]);
      if (cached && cached.game !== card.game) {
        throw Object.assign(new Error('Backup card identity conflicts with stored data'), { status: 400 });
      }
    }
    await db.run('DELETE FROM deck_cards WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)', [userId]);
    await db.run('DELETE FROM decks WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM collection WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM locations WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM storage_units WHERE user_id = ?', [userId]);

    for (const card of backup.card_cache) {
      await db.run(`
        INSERT OR IGNORE INTO card_cache (
          id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url,
          price_trend, price_normal, price_holofoil, price_avg1, price_avg7,
          price_avg30, price_currency, price_source, cmc, color_identity, game,
          language, printed_name, tcgplayer_product_id, last_updated
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card.id, card.name, card.supertype, card.subtypes, card.types, card.rarity, card.set_id, card.set_name, card.number, card.image_url,
        card.price_trend, card.price_normal, card.price_holofoil, card.price_avg1, card.price_avg7,
        card.price_avg30, card.price_currency, card.price_source, card.cmc, card.color_identity, card.game,
        card.language, card.printed_name, card.tcgplayer_product_id, card.last_updated
      ]);
    }

    for (const unit of backup.storage_units ?? []) {
      const result = await db.run('INSERT INTO storage_units (user_id, name, type) VALUES (?, ?, ?)', [userId, unit.name, unit.type ?? 'Other']);
      storageUnitIds.set(unit.id, result.lastID);
    }

    for (const location of backup.locations) {
      const result = await db.run(`
        INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, rule_config, game, user_id, locked, allow_stacking, cover_card_id, inventory_type, sleeved, storage_unit_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        location.name, location.type, location.sort_order, location.foil_sorting, location.rule_type, location.rule_config,
        location.game, userId, location.locked || 0, location.allow_stacking || 0, location.cover_card_id || null, location.inventory_type ?? 'collection',
        location.sleeved ?? 0, location.storage_unit_id == null ? null : storageUnitIds.get(location.storage_unit_id)
      ]);
      locationIds.set(location.id, result.lastID);
    }

    for (const compartment of backup.compartments) {
      const result = await db.run(`
        INSERT INTO compartments (location_id, idx, label, capacity, rule_config, locked)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        locationIds.get(compartment.location_id), compartment.idx, compartment.label, compartment.capacity,
        compartment.rule_config, compartment.locked || 0
      ]);
      compartmentIds.set(compartment.id, result.lastID);
    }

    for (const assignment of backup.compartment_assignments) {
      await db.run('INSERT INTO compartment_assignments (compartment_id, filter_value) VALUES (?, ?)', [
        compartmentIds.get(assignment.compartment_id), assignment.filter_value
      ]);
    }

    for (const card of backup.collection) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, quantity, condition, printing, language, purchase_price, location_id, compartment_id,
          position, favorite, is_trade, list_type, game, added_at, notes, grader, grade, cert_number,
          market_value, market_value_source, market_value_at, missing, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        card.card_id, card.quantity, card.condition, card.printing, card.language, card.purchase_price,
        card.location_id == null ? null : locationIds.get(card.location_id),
        card.compartment_id == null ? null : compartmentIds.get(card.compartment_id),
        card.position, card.favorite || 0, card.is_trade || 0, card.list_type, card.game, card.added_at,
        card.notes || '', card.grader || 'Raw', card.grade, card.cert_number, card.market_value,
        card.market_value_source, card.market_value_at, card.missing || 0, userId
      ]);
      entryIds.set(card.id, result.lastID);
    }

    for (const deck of backup.decks) {
      const result = await db.run(`
        INSERT INTO decks (
          name, description, notes, checked_out, checked_out_at, game, created_at, format, category,
          accent_color, target_size, commander_card_id, inventory_type, wins, losses, sleeved, card_back_color, card_back_image, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        deck.name, deck.description, deck.notes ?? '', deck.checked_out || 0, deck.checked_out_at, deck.game, deck.created_at,
        deck.format, deck.category, deck.accent_color, deck.target_size, deck.commander_card_id ?? null,
        deck.inventory_type ?? 'collection', deck.wins ?? 0, deck.losses ?? 0, deck.sleeved ?? 0, deck.card_back_color, deck.card_back_image, userId
      ]);
      deckIds.set(deck.id, result.lastID);
    }

    for (const card of backup.deck_cards) {
      await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out, source_entry_id) VALUES (?, ?, ?, ?, ?)', [
        deckIds.get(card.deck_id), card.card_id, card.quantity, card.checked_out || 0,
        card.source_entry_id == null ? null : restoredEntryId(card.source_entry_id)
      ]);
    }
    for (const source of backup.deck_card_allocations ?? []) {
      await db.run(`INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)`,
        [deckIds.get(source.deck_id), source.card_id, restoredEntryId(source.entry_id), source.quantity]);
    }
    for (const source of await checkedOutSources(userId)) {
      await db.run(`INSERT OR IGNORE INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)`,
        [source.deck_id, source.card_id, source.entry_id, source.quantity]);
    }
  });

  return { cards: backup.collection.length, locations: backup.locations.length, decks: backup.decks.length };
}

// Export endpoint
router.get('/export', async (req, res) => {
  const { format = 'csv', ecosystem = 'internal' } = req.query;
  const targetFormat = (ecosystem || format || 'internal').toLowerCase();

  try {
    if (format.toLowerCase() === 'backup') {
      const [collection, locations, compartments, compartmentAssignments, decks, deckCards, cardCache] = await Promise.all([
        db.all('SELECT * FROM collection WHERE user_id = ? ORDER BY id', [req.user.id]),
        db.all('SELECT * FROM locations WHERE user_id = ? ORDER BY id', [req.user.id]),
        db.all('SELECT cp.* FROM compartments cp JOIN locations l ON l.id = cp.location_id WHERE l.user_id = ? ORDER BY cp.location_id, cp.idx', [req.user.id]),
        db.all('SELECT ca.* FROM compartment_assignments ca JOIN compartments cp ON cp.id = ca.compartment_id JOIN locations l ON l.id = cp.location_id WHERE l.user_id = ? ORDER BY ca.compartment_id, ca.filter_value', [req.user.id]),
        db.all('SELECT * FROM decks WHERE user_id = ? ORDER BY id', [req.user.id]),
        db.all('SELECT dc.* FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.user_id = ? ORDER BY dc.deck_id, dc.card_id', [req.user.id]),
        db.all(`
          SELECT * FROM card_cache WHERE id IN (
            SELECT card_id FROM collection WHERE user_id = ?
            UNION
            SELECT dc.card_id FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id WHERE d.user_id = ?
          ) ORDER BY id
        `, [req.user.id, req.user.id])
      ]);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=manafolio_backup_${new Date().toISOString().slice(0, 10)}.json`);
      return res.json({
        format: 'manafolio-backup',
        version: 1,
        exported_at: new Date().toISOString(),
        collection,
        card_cache: cardCache,
        locations,
        storage_units: await db.all('SELECT id, name, type FROM storage_units WHERE user_id = ? ORDER BY id', [req.user.id]),
        compartments,
        compartment_assignments: compartmentAssignments,
        decks,
        deck_cards: deckCards,
        deck_card_allocations: await checkedOutSources(req.user.id)
      });
    }

    const query = `
      SELECT 
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.added_at,
        cc.id as card_id,
        cc.name as name,
        cc.supertype,
        cc.types,
        cc.rarity,
        cc.set_id as set_code,
        cc.set_name,
        cc.number as collector_number,
        cc.image_url,
        c.grader,
        c.grade,
        c.market_value,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        l.name as location_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        c.position
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      WHERE c.user_id = ?
    `;
    const raw = await db.all(query, [req.user.id]);
    // market_price used to be cc.price_trend flat, which exported the wrong number
    // for foils and slabs, which resolveCardPrice values consistently.
    // price_trend is destructured OUT along with the per-printing columns: the CSV
    // strategies read `item.price_trend || item.market_price`, so leaving it in
    // would win over the resolved number and export the raw price anyway.
    const rows = raw.map(({ price_trend, price_normal, price_holofoil, ...keep }) => ({
      ...keep,
      market_price: resolveCardPrice({ price_trend, price_normal, price_holofoil, ...keep }),
      // The two sub-location columns the exporters read. They used to be selected
      // straight off the collection table as sub_location_1/2 — columns db.js has
      // DROPPED the table to remove, so every export answered
      // "no such column: c.sub_location_1" and 500'd. Rebuilt from the compartment
      // the card actually lives in, the same way the collection view labels it.
      sub_location_1: keep.compartment_idx == null
        ? ''
        : (keep.compartment_label || `${isBinderType(keep.location_type) ? 'Page' : 'Row'} ${keep.compartment_idx}`),
      sub_location_2: keep.position >= 1000 ? String(Math.floor(keep.position / 1000)) : '',
    }));

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=pokedexrr_collection_${targetFormat}.json`);
      return res.json(rows);
    }

    const csvContent = generateExportCSV(rows, targetFormat);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=pokedexrr_collection_${targetFormat}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ error: 'Export failed', message: error.message });
  }
});


router.post('/import/preview', (req, res) => {
  const { format = 'internal', data, mapping } = req.body;
  if (!data) return res.status(400).json({ error: 'No import data provided' });

  if (format.toLowerCase() === 'manabox') {
    const items = parseManaboxText(data);
    if (!items.length) return res.status(400).json({ error: 'No ManaBox cards found' });
    const summary = items.reduce((out, item) => {
      out.cards += item.quantity;
      if (item.printing === 'Holofoil') out.foils += item.quantity;
      else out.normal += item.quantity;
      return out;
    }, { printings: items.length, cards: 0, normal: 0, foils: 0 });
    return res.json(summary);
  }

  try {
    const { headers, rows } = parseCsvRows(data);
    const items = parseThirdPartyCSV(rows, csvFormat(headers, format), mapping);
    const errors = items.flatMap((item, index) => {
      const row = index + 2;
      return [
        ...(!item.name ? [`Row ${row}: Name is required.`] : []),
        ...(!validImportQuantity(item.quantity) ? [`Row ${row}: Quantity must be an integer from 1 to 2147483647.`] : [])
      ];
    });
    return res.json({
      headers,
      cards: items.length,
      quantity: items.reduce((total, item) => total + (validImportQuantity(item.quantity) ? item.quantity : 0), 0),
      errors
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});
// Import endpoint
router.post('/import', async (req, res) => {
  const { format = 'internal', data, list_type = 'collection', mapping } = req.body;
  if (req.body.game !== undefined && req.body.game !== 'mtg') {
    return res.status(400).json({ error: 'Unsupported game' });
  }
  if (!data) {
    return res.status(400).json({ error: 'No data provided' });
  }

  const streaming = req.accepts(['application/json', 'application/x-ndjson']) === 'application/x-ndjson';
  let streamStarted = false;
  const canWrite = () => !res.destroyed && !res.writableEnded;
  const sendEvent = event => {
    if (!canWrite()) return;
    if (!streamStarted) {
      res.set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no'
      });
      streamStarted = true;
      res.flushHeaders();
    }
    res.write(`${JSON.stringify(event)}\n`);
    res.flush?.();
  };
  const onProgress = streaming ? progress => sendEvent({ type: 'progress', ...progress }) : undefined;
  const respond = (status, payload) => {
    if (!canWrite()) return;
    if (streamStarted) {
      sendEvent(status >= 400 ? { type: 'error', ...payload } : { type: 'complete', data: payload });
      if (canWrite()) res.end();
      return;
    }
    return res.status(status).json(payload);
  };

  try {
    let rawItems = [];
    let unmatchedCount = 0;
    let manaBoxItems = null;
    const formatKey = format.toLowerCase();
    if (!['collection', 'arena'].includes(list_type)) {
      return res.status(400).json({ error: 'Invalid list_type' });
    }
    if (formatKey === 'backup') {
      const backup = await parseCompleteBackup(data);
      onProgress?.({ stage: 'parsed', total: backup.collection.length });
      onProgress?.({ stage: 'saving', current: 0, total: backup.collection.length });
      const restored = await restoreCompleteBackup(backup, req.user.id);
      onProgress?.({ stage: 'saved', current: restored.cards, total: restored.cards });
      return respond(200, {
        success: true,
        ...restored,
        message: `Restored ${restored.cards} cards, ${restored.locations} containers, and ${restored.decks} decks.`
      });
    }

    if (formatKey === 'json') {
      rawItems = typeof data === 'string' ? JSON.parse(data) : data;
    } else if (formatKey === 'manabox') {
      rawItems = parseManaboxText(data);
      if (rawItems.length === 0) {
        return res.status(400).json({ error: 'No ManaBox cards found' });
      }
      manaBoxItems = rawItems;
    } else {
      const { headers, rows } = parseCsvRows(data);
      const parsedFormat = csvFormat(headers, format);
      rawItems = parseThirdPartyCSV(rows, parsedFormat, mapping);
      if (parsedFormat === 'manabox') manaBoxItems = rawItems;
    }

    if (!Array.isArray(rawItems)) {
      return res.status(400).json({ error: 'Invalid data payload' });
    }
    if (rawItems.some(item => !item || (item.game !== undefined && item.game !== 'mtg'))) {
      return res.status(400).json({ error: 'Unsupported game' });
    }
    const inputIds = [...new Set(rawItems.map(item => item.card_id || item.id).filter(Boolean))];
    for (let offset = 0; offset < inputIds.length; offset += 500) {
      const ids = inputIds.slice(offset, offset + 500);
      const cached = await db.all(`SELECT id, game FROM card_cache WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      const identities = new Map(cached.map(card => [card.id, card.game]));
      if (ids.some(id => typeof id !== 'string'
        || (identities.has(id) ? identities.get(id) !== 'mtg' : !id.startsWith('mtg-')))) {
        return res.status(400).json({ error: 'Unsupported card ID or game' });
      }
    }
    onProgress?.({ stage: 'parsed', total: rawItems.length });

    // Resolve Magic CSV rows through the same Scryfall bulk path as ManaBox
    // text. Card IDs in exported Arena CSVs are Manafolio-local, not Scryfall
    // UUIDs, so writing them straight to card_cache made incomplete placeholder
    // cards instead of real normalized printings.
    const failedItem = item => ({
      name: item.name || item.card_id || 'Unknown card',
      quantity: item.quantity,
      set_code: item.set_code || item.set_id || '',
      collector_number: item.collector_number || item.number || ''
    });
    let failedItems = [];
    rawItems = rawItems.filter(item => {
      const quantity = item.quantity === undefined ? 1
        : typeof item.quantity === 'string' && item.quantity.trim() !== '' ? Number(item.quantity) : item.quantity;
      if (!validImportQuantity(quantity)) {
        failedItems.push({ ...failedItem(item), error: 'Quantity must be an integer from 1 to 2147483647' });
        return false;
      }
      item.quantity = quantity;
      return true;
    });
    const magicItems = manaBoxItems ? rawItems : (formatKey !== 'json' && rawItems.filter(item => item.game === 'mtg'));
    if (magicItems?.length) {
      const { cards, pairs, unmatchedRows = [] } = await scryfallApi.bulkFetchByIdentifier(magicItems.map(item => ({
        ...item,
        set_id: item.set_code,
        number: item.collector_number
      })), onProgress, { localFirst: true });
      onProgress?.({ stage: 'caching', total: cards.length });
      await scryfallApi.cacheCards(cards);

      unmatchedCount = magicItems.length - pairs.length;
      failedItems.push(...unmatchedRows.map(failedItem));
      rawItems = pairs.map(({ row, card }) => ({ ...row, card_id: card.id }));
      if (rawItems.length === 0) {
        return respond(400, { error: 'No Magic cards matched Scryfall', summary: {
          added: { cards: 0, copies: 0, items: [] },
          failed: { cards: failedItems.length, copies: failedItems.reduce((total, item) => total + (validImportQuantity(item.quantity) ? item.quantity : 0), 0), items: failedItems }
        } });
      }
    } else {
      onProgress?.({ stage: 'resolved', matched: rawItems.length, unmatched: 0 });
    }

    let importedCount = 0;
    let addedItems = [];
    onProgress?.({ stage: 'saving', current: 0, total: rawItems.length });

    await db.withTransaction(async () => {
      // A disconnected client stops notifications, not the atomic import.
      for (const item of rawItems) {
        const cardId = item.card_id || item.id;
        const cached = typeof cardId === 'string'
          ? await db.get(`SELECT id, game FROM card_cache WHERE id = ?`, [cardId]) : null;
        const idGame = cached ? cached.game : (typeof cardId === 'string' && cardId.startsWith('mtg-') ? 'mtg' : null);
        if (idGame !== 'mtg' || (item.game !== undefined && item.game !== idGame)) {
          throw Object.assign(new Error('Unsupported card ID or game'), { status: 400 });
        }
        const game = idGame;
        if (!cached) {
          await db.run(
            `INSERT OR IGNORE INTO card_cache 
             (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend, game)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              cardId,
              item.name || 'Imported Card',
              item.supertype || 'Card',
              '[]',
              JSON.stringify(item.types || []),
              item.rarity || 'Common',
              item.set_code || item.set_id || '',
              item.set_name || item.set_code || 'Imported Set',
              item.collector_number || item.number || '',
              item.image_url || '',
              item.market_price || item.purchase_price || 0,
              game
            ]
          );
        }

        await db.run(
          `INSERT INTO collection 
           (card_id, user_id, quantity, condition, printing, language, purchase_price, list_type, game, added_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [
            cardId,
            req.user.id,
            item.quantity,
            item.condition || 'Near Mint',
            item.printing || 'Normal',
            item.language || 'English',
            item.purchase_price || 0,
            list_type,
            game
          ]
        );
        importedCount++;
        addedItems.push({ name: item.name || cardId, quantity: item.quantity });
        if (importedCount % 100 === 0) {
          onProgress?.({ stage: 'saving', current: importedCount, total: rawItems.length });
        }
      }
      if (importedCount % 100 !== 0) {
        onProgress?.({ stage: 'saving', current: importedCount, total: rawItems.length });
      }
    });
    onProgress?.({ stage: 'saved', current: importedCount, total: importedCount });

    const unmatched = unmatchedCount ? ` ${unmatchedCount} unmatched Magic printings were skipped.` : '';
    const copies = items => items.reduce((total, item) => total + (validImportQuantity(item.quantity) ? item.quantity : 0), 0);
    return respond(200, {
      success: true,
      count: importedCount,
      message: `Successfully imported ${importedCount} items.${unmatched}`,
      summary: {
        added: { cards: addedItems.length, copies: copies(addedItems), items: addedItems },
        failed: { cards: failedItems.length, copies: copies(failedItems), items: failedItems }
      }
    });
  } catch (error) {
    const status = error.status || (error.message.startsWith('Invalid backup') ? 400 : 500);
    return respond(status, {
      error: status === 400 ? error.message : 'Import failed',
      message: streamStarted ? undefined : error.message
    });
  }
});

// Storage reassignment preserves deck checkout state and owned copy counts.
async function movableContainerEntries(userId, cardId, printing, locationId) {
  const entries = await db.all(`
    SELECT c.* FROM collection c
    JOIN card_cache cc ON cc.id = c.card_id AND cc.game = 'mtg'
    LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
    LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
    WHERE c.user_id = ? AND c.card_id = ?
      AND c.game = 'mtg' AND c.list_type = 'collection'
      AND COALESCE(c.missing, 0) = 0 AND c.quantity > 0
      AND (c.location_id IS NULL OR (c.location_id != ? AND l.id IS NOT NULL AND l.locked = 0))
      AND (c.compartment_id IS NULL OR (cp.id IS NOT NULL AND cp.locked = 0))
    ORDER BY CASE WHEN ? != 'Any' AND c.printing = ? THEN 0 ELSE 1 END,
      c.location_id, c.compartment_id, c.position, c.id
  `, [userId, cardId, locationId, printing, printing]);
  return entries.map(entry => ({
    ...entry,
    // A certified slab is one physical copy; a legacy certified stack cannot be
    // split without inventing duplicate certificates or discarding its metadata.
    available: entry.quantity > 1 && entry.cert_number
      ? 0 : entry.quantity
  })).filter(entry => entry.available > 0);
}

async function containerQuantity(userId, cardId, locationId) {
  const current = await db.get(`
    SELECT COALESCE(SUM(quantity), 0) AS quantity FROM collection
    WHERE user_id = ? AND card_id = ? AND location_id = ?
      AND game = 'mtg' AND list_type = 'collection' AND COALESCE(missing, 0) = 0 AND quantity > 0
  `, [userId, cardId, locationId]);
  return current.quantity;
}

async function containerItemReport(userId, cardId, printing, requested, locationId) {
  const finishes = await db.all(`
    SELECT printing, SUM(quantity) AS quantity FROM collection
    WHERE user_id = ? AND card_id = ? AND location_id = ?
      AND game = 'mtg' AND list_type = 'collection' AND COALESCE(missing, 0) = 0 AND quantity > 0
    GROUP BY printing
    ORDER BY CASE WHEN ? != 'Any' AND printing = ? THEN 0 ELSE 1 END, printing
  `, [userId, cardId, locationId, printing, printing]);
  let unmoved = requested;
  const movedFinishes = [];
  for (const finish of finishes) {
    if (unmoved === 0) break;
    const quantity = Math.min(unmoved, finish.quantity);
    movedFinishes.push({ printing: finish.printing, quantity });
    unmoved -= quantity;
  }
  const entries = await movableContainerEntries(userId, cardId, printing, locationId);
  const locations = await db.all(`
    SELECT c.location_id, l.name AS location_name, su.name AS storage_unit_name, c.list_type, c.printing,
      SUM(c.quantity) AS quantity, c.missing
    FROM collection c
    LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
    LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = c.user_id
    WHERE c.user_id = ? AND c.card_id = ? AND c.quantity > 0
      AND (c.location_id IS NULL OR (c.location_id != ? AND l.id IS NOT NULL))
    GROUP BY c.location_id, l.name, su.name, c.list_type, c.printing, c.missing
    ORDER BY c.location_id, c.list_type, c.printing, c.missing
  `, [userId, cardId, locationId]);
  return {
    card_id: cardId, printing, requested, moved: requested - unmoved, unmoved,
    moved_finishes: movedFinishes,
    movable: Math.min(unmoved, entries.reduce((total, entry) => total + entry.available, 0)),
    locations
  };
}


// Build a physical box from matching, unfiled cards the user already owns.
router.post('/import-container', async (req, res) => {
  const { data, name } = req.body;
  const containerName = String(name || '').trim();
  if (!data || !containerName) {
    return res.status(400).json({ error: 'Container name and ManaBox data are required' });
  }

  try {
    const items = parseManaboxText(data);
    if (items.length === 0) return res.status(400).json({ error: 'No ManaBox cards found' });
    if (items.some(item => !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || item.quantity > 2147483647)) {
      return res.status(400).json({ error: 'Card quantities must be positive integers up to 2147483647' });
    }
    const duplicate = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ?`, [containerName, req.user.id]);
    if (duplicate) return res.status(400).json({ error: 'A location with this name already exists' });

    const rows = items.map(item => ({
      ...item,
      set_id: item.set_code,
      number: item.collector_number
    }));
    const { pairs } = await scryfallApi.bulkFetchByIdentifier(rows, undefined, { localFirst: true });
    const resolved = new Map(pairs.map(({ row, card }) => [row, card]));
    const report = [];
    const byCardId = new Map();
    for (const row of rows) {
      const cardId = resolved.get(row)?.id || null;
      const existing = cardId && byCardId.get(cardId);
      if (existing) {
        existing.requested += row.quantity;
        existing.unmoved = existing.requested;
        if (existing.printing !== row.printing) existing.printing = 'Any';
        continue;
      }
      const item = {
        card_id: cardId,
        name: row.name,
        set_code: row.set_code,
        collector_number: row.collector_number,
        printing: row.printing,
        requested: row.quantity,
        moved: 0,
        unmoved: row.quantity,
        movable: 0,
        moved_finishes: [],
        status: cardId ? 'resolved' : 'unresolved',
        locations: []
      };
      report.push(item);
      if (cardId) byCardId.set(cardId, item);
    }
    if (report.some(item => item.requested > 2147483647)) {
      return res.status(400).json({ error: 'Card quantities must be positive integers up to 2147483647' });
    }
    const requested = items.reduce((total, item) => total + item.quantity, 0);
    if (byCardId.size === 0) {
      return res.status(400).json({
        error: 'No ManaBox cards matched Scryfall',
        id: null, name: containerName, requested, count: 0, missing: requested,
        items: report, message: 'No ManaBox cards matched Scryfall; no container was created.'
      });
    }

    let locationId;
    let count = 0;
    await db.withTransaction(async () => {
      const location = await db.run(`
        INSERT INTO locations (name, type, sort_order, foil_sorting, rule_type, game, user_id)
        VALUES (?, 'Box', 'custom', 'normals_first', 'any', 'mtg', ?)
      `, [containerName, req.user.id]);
      locationId = location.lastID;
      const compartment = await db.run(
        `INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, ?)`,
        [locationId, 1]
      );

      for (const item of report) {
        if (!item.card_id) continue;
        const entries = await movableContainerEntries(req.user.id, item.card_id, item.printing, locationId);
        await moveContainerCopies(req.user.id, locationId, compartment.lastID,
          entries.filter(entry => entry.location_id === null), item.requested);
        Object.assign(item, await containerItemReport(
          req.user.id, item.card_id, item.printing, item.requested, locationId
        ));
      }
      count = report.reduce((total, item) => total + item.moved, 0);
      await db.run(`UPDATE compartments SET capacity = ? WHERE id = ?`, [Math.max(1, count), compartment.lastID]);
    });

    const missing = requested - count;
    const skipped = missing ? ` ${missing} card${missing === 1 ? '' : 's'} not found in Unsorted.` : '';
    res.status(201).json({
      id: locationId, name: containerName, requested, count, missing, items: report,
      message: `Created ${containerName} with ${count} cards.${skipped}`
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to import container' });
  }
});

router.post('/import-container/move', async (req, res) => {
  const { location_id, card_id, printing, requested } = req.body || {};
  if (!Number.isSafeInteger(location_id) || location_id <= 0 ||
      typeof card_id !== 'string' || !card_id.trim() ||
      !['Normal', 'Holofoil', 'Any'].includes(printing) ||
      !Number.isSafeInteger(requested) || requested <= 0 || requested > 2147483647) {
    return res.status(400).json({ error: 'A valid container, card, finish, and requested quantity are required' });
  }
  try {
    const result = await db.withTransaction(async () => {
      const destination = await db.get(`SELECT * FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!destination) throw Object.assign(new Error('Container not found'), { status: 404 });
      assertStorageInventory(destination);
      const compartment = await db.get(`
        SELECT cp.* FROM compartments cp JOIN locations l ON l.id = cp.location_id
        WHERE cp.location_id = ? AND l.user_id = ? ORDER BY cp.idx, cp.id LIMIT 1
      `, [location_id, req.user.id]);
      if (destination.type !== 'Box' || destination.locked || destination.sort_order !== 'custom' ||
          destination.rule_type !== 'any' || destination.game !== 'mtg' || destination.allow_stacking ||
          !compartment || compartment.locked || compartment.rule_config) {
        throw Object.assign(new Error('Container settings changed; cards cannot be moved into this import'), { status: 409 });
      }
      const card = await db.get(`SELECT id FROM card_cache WHERE id = ? AND game = 'mtg'`, [card_id]);
      if (!card) throw Object.assign(new Error('Magic card not found'), { status: 404 });
      const remaining = requested - await containerQuantity(req.user.id, card_id, location_id);
      if (remaining > 0) {
        const entries = await movableContainerEntries(req.user.id, card_id, printing, location_id);
        await moveContainerCopies(req.user.id, location_id, compartment.id, entries, remaining);
      }
      return containerItemReport(req.user.id, card_id, printing, requested, location_id);
    });
    res.json(result);
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to move matching cards' });
  }
});

module.exports = router;
