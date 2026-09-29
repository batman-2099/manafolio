const express = require('express');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const { parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { deckCardSources, validateDeckSource, deckLocations, reserveDeckSources, deckMissingCards, checkedOutAllocation, checkedOutSources, sourceEntries, moveContainerCopies, defaultCompartmentPlan } = require('../utils/collectionHelpers');
const { validateDeckAddition } = require('../utils/deckRules');
const { FORMATS } = require('../utils/aiDecks');
const scryfallApi = require('../scryfallApi');
const { parseManaboxText } = require('../utils/csvMappers');
const mtgjsonApi = require('../mtgjsonApi');
const { normalizeCardBack } = require('../utils/cardBack');

const router = express.Router();

// Get User Decks
router.get('/', async (req, res) => {
  if (req.query?.game !== undefined && req.query.game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  try {
    const query = `
      SELECT
        d.id,
        d.name,
        d.description,
        d.game,
        d.format,
        d.category,
        d.accent_color,
        d.target_size,
        d.commander_card_id,
        d.created_at,
        d.checked_out,
        d.inventory_type,
        d.checked_out_at,
        d.wins,
        d.losses,
        d.sleeved,
        COUNT(dc.card_id) as total_card_types,
        COALESCE(SUM(dc.quantity), 0) as total_cards,
        COALESCE(SUM(CASE WHEN cc.color_identity LIKE '%"White"%' OR cc.color_identity LIKE '%"W"%' THEN dc.quantity ELSE 0 END), 0) AS white_cards,
        COALESCE(SUM(CASE WHEN cc.color_identity LIKE '%"Blue"%' OR cc.color_identity LIKE '%"U"%' THEN dc.quantity ELSE 0 END), 0) AS blue_cards,
        COALESCE(SUM(CASE WHEN cc.color_identity LIKE '%"Black"%' OR cc.color_identity LIKE '%"B"%' THEN dc.quantity ELSE 0 END), 0) AS black_cards,
        COALESCE(SUM(CASE WHEN cc.color_identity LIKE '%"Red"%' OR cc.color_identity LIKE '%"R"%' THEN dc.quantity ELSE 0 END), 0) AS red_cards,
        COALESCE(SUM(CASE WHEN cc.color_identity LIKE '%"Green"%' OR cc.color_identity LIKE '%"G"%' THEN dc.quantity ELSE 0 END), 0) AS green_cards
      FROM decks d
      LEFT JOIN deck_cards dc ON d.id = dc.deck_id
      LEFT JOIN card_cache cc ON dc.card_id = cc.id
      WHERE d.user_id = ? AND d.game = 'mtg'
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `;
    const rows = await db.all(query, [req.user.id]);
    const missing = await deckMissingCards(rows, req.user.id);
    res.json(rows.map(deck => ({ ...deck, missing_cards: missing.get(deck.id) })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve decks' });
  }
});

// Create Deck
router.post('/', async (req, res) => {
  const { 
    name, 
    description = '', 
    game = 'mtg',
    format = 'Standard',
    category = 'Competitive',
    accent_color = '#eab308',
    target_size = 60,
    decklist_text = '',
    decklist_format = 'plain',
    precon_file = '',
    inventory_type = 'collection',
    commander_card_id
  } = req.body;
  
  if (!name) {
    return res.status(400).json({ error: 'Deck name is required' });
  }
  if (game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  const deckGame = 'mtg';
  const targetSizeNum = parseInt(target_size, 10) || 60;
  if (!['collection', 'arena', 'graveyard'].includes(inventory_type)) {
    return res.status(400).json({ error: 'Invalid deck inventory type' });
  }
  const inventoryType = inventory_type;

  if (commander_card_id !== undefined) {
    if (typeof commander_card_id !== 'string' || !commander_card_id.trim()) {
      return res.status(400).json({ error: 'commander_card_id must be a non-empty string' });
    }
    if (typeof format !== 'string' || !/commander|edh|brawl/i.test(format)) {
      return res.status(400).json({ error: 'Only Commander / EDH or Brawl decks can designate a commander' });
    }
    if (decklist_text || precon_file) {
      return res.status(400).json({ error: 'Commander creation cannot be combined with a decklist or precon import' });
    }
  }

  let newDeckId;
  try {
    let preconPairs = null;
    if (precon_file) {
      const precon = await mtgjsonApi.getDeck(precon_file);
      if (!precon) return res.status(404).json({ error: 'MTGJSON deck not found' });
      const rows = mtgjsonApi.deckCardRows(precon);
      if (!rows.length) return res.status(422).json({ error: 'This MTGJSON deck has no importable cards' });
      const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(rows, undefined, { localFirst: true });
      if (!pairs.length) return res.status(422).json({ error: 'No MTGJSON cards matched Scryfall' });
      await scryfallApi.cacheCards(cards);
      preconPairs = pairs;
    }

    const result = await db.withTransaction(async () => {
      const deck = await db.run(
        `INSERT INTO decks (name, description, game, format, category, accent_color, target_size, inventory_type, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description, deckGame, format, category, accent_color, targetSizeNum, inventoryType, req.user.id]
      );
      if (commander_card_id !== undefined) {
        const check = await validateDeckAddition({ deckId: deck.lastID, userId: req.user.id, cardId: commander_card_id, newQty: 1, mode: 'draft' });
        if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
        await db.run(`INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 1)`, [deck.lastID, commander_card_id]);
        await db.run(`UPDATE decks SET commander_card_id = ? WHERE id = ? AND user_id = ?`, [commander_card_id, deck.lastID, req.user.id]);
      }
      return deck;
    });
    newDeckId = result.lastID;
    const addDeckCard = async (cardId, quantity) => {
      if (inventoryType !== 'collection') {
        const current = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [newDeckId, cardId]);
        const check = await validateDeckAddition({ deckId: newDeckId, userId: req.user.id, cardId, newQty: (current?.quantity || 0) + quantity, mode: 'draft' });
        if (!check.ok) {
          const error = new Error(check.error);
          error.status = 400;
          throw error;
        }
      }
      await db.run(
        `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
         ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
        [newDeckId, cardId, quantity]
      );
    };

    // Optional decklist import. ManaBox identifies a printing by set and
    // collector number, so resolve those identifiers in batches instead of
    // guessing from a card name shared by many printings.
    if (preconPairs) {
      for (const { row, card } of preconPairs) {
        await addDeckCard(card.id, row.quantity);
      }
    } else if (decklist_text && typeof decklist_text === 'string') {
      const manaBoxItems = deckGame === 'mtg' ? parseManaboxText(decklist_text) : [];
      if (manaBoxItems.length || decklist_format === 'manabox') {
        if (!manaBoxItems.length) {
          const error = new Error('No ManaBox cards found in the decklist');
          error.status = 422;
          throw error;
        }
        const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(manaBoxItems.map(item => ({
          ...item,
          set_id: item.set_code,
          number: item.collector_number
        })), undefined, { localFirst: true });
        if (pairs.length !== manaBoxItems.length) {
          const error = new Error(`Only ${pairs.length} of ${manaBoxItems.length} ManaBox cards matched Scryfall`);
          error.status = 422;
          throw error;
        }
        await scryfallApi.cacheCards(cards);
        for (const { row, card } of pairs) {
          await addDeckCard(card.id, row.quantity);
        }
      } else {
        const lines = decklist_text.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^(\d+)x?\s+(.+)$/i);
          if (match) {
            const qty = parseInt(match[1], 10);
            const cardName = match[2].trim();
            const card = await db.get(`SELECT id FROM card_cache WHERE LOWER(name) = LOWER(?) AND game = ? LIMIT 1`, [cardName, deckGame]);
            if (card) {
              await addDeckCard(card.id, qty);
            }
            else if (inventoryType === 'graveyard') {
              throw Object.assign(new Error(`${cardName} was not found in the card catalog`), { status: 400 });
            }
          }
        }
      }
    }

    res.status(201).json({ message: 'Deck created successfully', id: newDeckId });
  } catch (error) {
    if (newDeckId) await db.run(`DELETE FROM decks WHERE id = ? AND user_id = ?`, [newDeckId, req.user.id]);
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to create deck' });
  }
});

// File existing copies from a saved deck without creating ownership or changing checkout.
router.post('/:id/container', async (req, res) => {
  const deckId = Number(req.params.id);
  const name = req.body?.name;
  if (!Number.isSafeInteger(deckId) || deckId < 1) {
    return res.status(400).json({ error: 'Deck ID must be a positive integer' });
  }
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
    return res.status(400).json({ error: 'Container name must be between 1 and 120 characters' });
  }
  const containerName = name.trim();
  try {
    const result = await db.withTransaction(async () => {
      const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [deckId, req.user.id]);
      if (!deck) throw Object.assign(new Error('Deck not found'), { status: 404 });
      if (!['collection', 'graveyard'].includes(deck.inventory_type)) {
        throw Object.assign(new Error('Only Physical and Graveyard decks can create containers'), { status: 400 });
      }
      const cards = await db.all(`
        SELECT dc.*, COALESCE(cc.name, dc.card_id) AS name FROM deck_cards dc
        LEFT JOIN card_cache cc ON cc.id = dc.card_id
        WHERE dc.deck_id = ? ORDER BY dc.card_id
      `, [deckId]);
      if (!cards.length || cards.some(card => !Number.isSafeInteger(card.quantity) || card.quantity <= 0)) {
        throw Object.assign(new Error('Save a nonempty deck with positive card quantities first'), { status: 400 });
      }
      const requested = cards.reduce((total, card) => total + card.quantity, 0);
      if (!Number.isSafeInteger(requested) || requested > 2147483647) {
        throw Object.assign(new Error('Deck quantity is too large'), { status: 400 });
      }
      const duplicate = await db.get(`SELECT id FROM locations WHERE name = ? AND user_id = ? AND inventory_type = ?`,
        [containerName, req.user.id, deck.inventory_type]);
      if (duplicate) throw Object.assign(new Error('A container with this name already exists in this inventory'), { status: 400 });
      // Freeze legacy fallback identities before filing changes their storage order.
      for (const source of await checkedOutSources(req.user.id)) {
        await db.run(`INSERT OR IGNORE INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, ?)`,
          [source.deck_id, source.card_id, source.entry_id, source.quantity]);
      }
      // Include this deck's reservations, including legacy and archived allocations.
      const allocated = await checkedOutAllocation(req.user.id);
      const location = await db.run(`
        INSERT INTO locations (name, type, sort_order, rule_type, game, inventory_type, user_id)
        VALUES (?, 'Deck Box', 'custom', 'any', 'mtg', ?, ?)
      `, [containerName, deck.inventory_type, req.user.id]);
      const compartment = await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, ?)`,
        [location.lastID, Math.max(defaultCompartmentPlan('Deck Box').capacity, requested)]);
      const items = [];
      for (const card of cards) {
        const candidates = await db.all(`
          SELECT c.*, c.id AS entry_id, l.locked AS location_locked, cp.locked AS compartment_locked
          FROM collection c JOIN card_cache cc ON cc.id = c.card_id AND cc.game = 'mtg'
          LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
          LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
          WHERE c.user_id = ? AND c.card_id = ? AND c.game = 'mtg' AND c.list_type = ?
            AND c.quantity > 0 AND COALESCE(c.missing, 0) = 0
            AND (c.location_id IS NULL OR (l.id IS NOT NULL AND l.inventory_type = ?))
            AND (c.compartment_id IS NULL OR cp.id IS NOT NULL)
          ORDER BY c.location_id, c.compartment_id, c.position, c.id
        `, [req.user.id, card.card_id, deck.inventory_type, deck.inventory_type]);
        const entries = sourceEntries(candidates, card, deck.game)
          // ponytail: exclude whole reserved stacks; splitting can reassign legacy allocations.
          .filter(entry => !entry.location_locked && !entry.compartment_locked
            && !allocated.has(entry.id) && !(entry.quantity > 1 && entry.cert_number))
          .map(entry => ({ ...entry, available: entry.quantity }));
        const moved = Math.min(card.quantity, entries.reduce((total, entry) => total + entry.available, 0));
        await moveContainerCopies(req.user.id, location.lastID, compartment.lastID, entries, moved);
        items.push({ card_id: card.card_id, name: card.name, requested: card.quantity, moved, missing: card.quantity - moved });
      }
      const count = items.reduce((total, item) => total + item.moved, 0);
      return { id: location.lastID, name: containerName, inventory_type: deck.inventory_type,
        requested, count, missing: requested - count, items };
    });
    res.status(201).json(result);
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to create container from deck' });
  }
});

// Save a container as a deck definition, without moving or reserving copies.
router.post('/from-container', async (req, res) => {
  const { location_id, name, format = 'Casual' } = req.body || {};
  if (!Number.isSafeInteger(location_id) || location_id < 1) {
    return res.status(400).json({ error: 'Container ID must be a positive integer' });
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 120) {
    return res.status(400).json({ error: 'Deck name must be non-empty text of at most 120 characters' });
  }
  if (typeof format !== 'string' || !Object.hasOwn(FORMATS, format)) {
    return res.status(400).json({ error: 'Choose a supported Magic format' });
  }

  try {
    const id = await db.withTransaction(async () => {
      const location = await db.get("SELECT id, inventory_type FROM locations WHERE id = ? AND user_id = ? AND inventory_type IN ('collection', 'graveyard')", [location_id, req.user.id]);
      if (!location) throw Object.assign(new Error('Container not found'), { status: 404 });
      // Missing and checked-out copies still belong to the definition; checkout handles availability.
      const cards = await db.all(`
        SELECT c.card_id, SUM(c.quantity) AS quantity
        FROM collection c JOIN card_cache cc ON cc.id = c.card_id AND cc.game = 'mtg'
        WHERE c.location_id = ? AND c.user_id = ? AND c.game = 'mtg'
          AND c.list_type = ? AND c.quantity > 0
        GROUP BY c.card_id
      `, [location_id, req.user.id, location.inventory_type]);
      if (!cards.length) throw Object.assign(new Error('Container has no Magic cards'), { status: 400 });
      const deck = await db.run(`
        INSERT INTO decks (user_id, name, description, game, format, inventory_type, target_size)
        VALUES (?, ?, '', 'mtg', ?, ?, ?)
      `, [req.user.id, name.trim(), format, location.inventory_type, cards.reduce((total, card) => total + card.quantity, 0)]);
      for (const card of cards) {
        await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)', [deck.lastID, card.card_id, card.quantity]);
      }
      return deck.lastID;
    });
    res.status(201).json({ id });
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to create deck from container' });
  }
});

// Get Deck Details (with Cards)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT * FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found' });
    }
    const inventoryType = deck.inventory_type || 'collection';

    const cardsQuery = `
      SELECT
        dc.quantity, dc.checked_out, dc.source_entry_id,
        cc.id,
        cc.name, cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        (SELECT COALESCE(SUM(quantity), 0) FROM collection WHERE card_id = cc.id AND user_id = ? AND list_type = ?) AS owned_qty,
        (SELECT COALESCE(SUM(dc2.quantity), 0)
         FROM deck_cards dc2 JOIN decks d2 ON dc2.deck_id = d2.id
         WHERE d2.checked_out = 1 AND d2.inventory_type = ? AND d2.user_id = ? AND d2.id != ? AND dc2.card_id = cc.id) AS locked_qty,
        (SELECT GROUP_CONCAT(d2.name, ', ')
         FROM deck_cards dc2 JOIN decks d2 ON dc2.deck_id = d2.id
         WHERE d2.checked_out = 1 AND d2.inventory_type = ? AND d2.user_id = ? AND d2.id != ? AND dc2.card_id = cc.id) AS locked_decks
      FROM deck_cards dc
      JOIN card_cache cc ON dc.card_id = cc.id
      WHERE dc.deck_id = ?
    `;
    const cards = await db.all(cardsQuery, [req.user.id, inventoryType, inventoryType, req.user.id, id, inventoryType, req.user.id, id, id]);
    const formatted = cards.map(parseCardRow);

    res.json({
      ...deck,
      cards: formatted
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve deck details' });
  }
});

// A source is the lead copy's current location/compartment, never a move operation.
router.get('/:id/cards/:cardId/sources', async (req, res) => {
  try {
    const deck = await db.get(`SELECT id, inventory_type FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [req.params.id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    if (deck.inventory_type !== 'collection') return res.status(400).json({ error: 'Only Physical decks have physical card sources' });
    const card = await db.get(`SELECT id FROM card_cache WHERE id = ? AND game = 'mtg'`, [req.params.cardId]);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    const saved = await db.get(`SELECT source_entry_id FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deck.id, card.id]);
    res.json({ source_entry_id: saved?.source_entry_id ?? null, sources: await deckCardSources(req.user.id, deck.id, card.id, saved?.source_entry_id) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve card sources' });
  }
});

router.get('/:id/locations', async (req, res) => {
  try {
    const deck = await db.get(`SELECT id, game, inventory_type, checked_out FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [req.params.id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    if (deck.inventory_type !== 'collection') return res.status(400).json({ error: 'Only Physical decks have physical card locations' });
    res.json(await deckLocations(deck, req.user.id));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve card locations' });
  }
});

// Update Deck Metadata
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, format, category, accent_color, target_size, inventory_type } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Deck name is required' });
  }
  const targetSize = target_size === undefined ? null : parseInt(target_size, 10);
  if (target_size !== undefined && (!Number.isInteger(targetSize) || targetSize < 1 || targetSize > 300)) {
    return res.status(400).json({ error: 'target_size must be between 1 and 300' });
  }

  try {
    await db.withTransaction(async () => {
      const deck = await db.get(`SELECT inventory_type, checked_out FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
      if (!deck) throw Object.assign(new Error('Deck not found or unauthorized'), { status: 404 });
      const inventoryType = inventory_type === undefined ? deck.inventory_type : inventory_type;
      if (!['collection', 'arena', 'graveyard'].includes(inventoryType)) {
        throw Object.assign(new Error('Invalid deck inventory type'), { status: 400 });
      }
      if (inventoryType !== deck.inventory_type) {
        if (deck.checked_out) throw Object.assign(new Error('Return this deck before changing its inventory type'), { status: 400 });
        if (inventoryType === 'graveyard') {
          await db.run('UPDATE deck_cards SET source_entry_id = NULL WHERE deck_id = ?', [id]);
          await db.run('DELETE FROM deck_card_allocations WHERE deck_id = ?', [id]);
        } else {
          const selected = await db.get(`SELECT 1 FROM deck_cards WHERE deck_id = ? AND source_entry_id IS NOT NULL LIMIT 1`, [id]);
          if (selected) throw Object.assign(new Error('Clear physical card sources before changing inventory type'), { status: 400 });
          const unavailable = await db.get(
            `SELECT cc.name
             FROM deck_cards dc
             JOIN card_cache cc ON cc.id = dc.card_id
             LEFT JOIN collection c ON c.card_id = dc.card_id AND c.user_id = ? AND c.list_type = ?
             WHERE dc.deck_id = ?
             GROUP BY dc.card_id
             HAVING COALESCE(SUM(c.quantity), 0) < dc.quantity
             LIMIT 1`,
            [req.user.id, inventoryType, id]
          );
          if (unavailable) throw Object.assign(new Error(`${unavailable.name} is not available in ${inventoryType === 'arena' ? 'Arena' : 'Physical'} inventory`), { status: 400 });
        }
      }

      await db.run(
        `UPDATE decks
         SET name = ?, description = COALESCE(?, description), format = COALESCE(?, format), category = COALESCE(?, category),
             accent_color = COALESCE(?, accent_color), target_size = COALESCE(?, target_size), inventory_type = ?,
             commander_card_id = CASE WHEN ? THEN NULL ELSE commander_card_id END
         WHERE id = ? AND user_id = ?`,
        [String(name).trim(), description, format, category, accent_color, targetSize, inventoryType,
          format != null && !/commander|edh|brawl/i.test(format), id, req.user.id]
      );
    });
    res.json({ message: 'Deck updated successfully' });
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update deck' });
  }
});

// Replace the editor draft as one unit; failed validation rolls every change back.
router.put('/:id/editor', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'A complete deck editor draft is required' });
  }
  const { name, description, notes, format, category, accent_color, target_size, inventory_type, cards, commander_card_id } = body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Deck name is required' });
  }
  if ([description, format, category, accent_color].some(value => typeof value !== 'string')) {
    return res.status(400).json({ error: 'Deck description, format, category and accent_color must be strings' });
  }
  if (notes !== undefined && typeof notes !== 'string') {
    return res.status(400).json({ error: 'Deck notes must be a string' });
  }
  if (!Number.isInteger(target_size) || target_size < 1 || target_size > 300) {
    return res.status(400).json({ error: 'target_size must be between 1 and 300' });
  }
  if (!['collection', 'arena', 'graveyard'].includes(inventory_type)) {
    return res.status(400).json({ error: 'Invalid deck inventory type' });
  }
  if (!Array.isArray(cards)) {
    return res.status(400).json({ error: 'cards must be an array' });
  }
  const cardIds = new Set();
  for (const card of cards) {
    if (!card || typeof card.card_id !== 'string' || !card.card_id.trim()
        || !Number.isSafeInteger(card.quantity) || card.quantity < 1 || typeof card.pulled !== 'boolean') {
      return res.status(400).json({ error: 'Each card requires a card_id, positive integer quantity and boolean pulled flag' });
    }
    if (cardIds.has(card.card_id)) return res.status(400).json({ error: 'Duplicate card_id in deck draft' });
    if (card.source_entry_id != null && (!Number.isSafeInteger(card.source_entry_id) || card.source_entry_id === 0)) {
      return res.status(400).json({ error: 'source_entry_id must be a non-zero integer or null' });
    }
    if (inventory_type === 'arena' && card.source_entry_id != null) {
      return res.status(400).json({ error: 'Arena decks cannot select physical sources' });
    }
    cardIds.add(card.card_id);
  }
  if (commander_card_id !== null && (typeof commander_card_id !== 'string' || !commander_card_id.trim())) {
    return res.status(400).json({ error: 'commander_card_id must be a non-empty string or null' });
  }
  if (commander_card_id !== null) {
    if (!/commander|edh|brawl/i.test(format)) {
      return res.status(400).json({ error: 'Only Commander / EDH or Brawl decks can designate a commander' });
    }
    if (!cardIds.has(commander_card_id)) {
      return res.status(400).json({ error: 'Commander must be a card in this deck' });
    }
  }

  const { id } = req.params;
  try {
    await db.withTransaction(async () => {
      const deck = await db.get(`SELECT inventory_type, checked_out FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
      if (!deck) throw Object.assign(new Error('Deck not found or unauthorized'), { status: 404 });
      const archiving = inventory_type === 'graveyard' && deck.inventory_type !== 'graveyard';
      if (inventory_type === 'graveyard' && !archiving && cards.some(card => card.source_entry_id != null)) {
        throw Object.assign(new Error('Graveyard decks cannot select physical sources'), { status: 400 });
      }
      const savedCards = await db.all(`SELECT card_id, quantity, source_entry_id FROM deck_cards WHERE deck_id = ? AND quantity > 0`, [id]);
      const saved = new Map(savedCards.map(card => [card.card_id, card]));
      if (deck.checked_out) {
        if (inventory_type !== deck.inventory_type) {
          throw Object.assign(new Error('Return this deck before changing its inventory type'), { status: 400 });
        }
        if (savedCards.length !== cards.length || cards.some(card => saved.get(card.card_id)?.quantity !== card.quantity
            || saved.get(card.card_id)?.source_entry_id !== (card.source_entry_id ?? null))) {
          throw Object.assign(new Error('Return this deck before changing its cards or sources'), { status: 400 });
        }
      }
      await db.run(
        `UPDATE decks SET name = ?, description = ?, notes = COALESCE(?, notes), format = ?, category = ?, accent_color = ?,
          target_size = ?, inventory_type = ?, commander_card_id = ? WHERE id = ? AND user_id = ?`,
        [name.trim(), description, notes ?? null, format, category, accent_color, target_size, inventory_type, commander_card_id, id, req.user.id]
      );
      if (deck.checked_out) {
        // Preserve the checked-out composition and its reservations, even if inventory has since changed.
        for (const card of cards) {
          await db.run(`UPDATE deck_cards SET checked_out = ? WHERE deck_id = ? AND card_id = ?`, [card.pulled ? 1 : 0, id, card.card_id]);
        }
      } else {
        if (archiving) await db.run('DELETE FROM deck_card_allocations WHERE deck_id = ?', [id]);
        await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [id]);
        for (const card of cards) {
          // Archiving keeps the saved definition, including cards no longer owned.
          if (!archiving || saved.get(card.card_id)?.quantity !== card.quantity) {
            const mode = inventory_type !== deck.inventory_type && inventory_type !== 'graveyard' ? 'addition' : 'draft';
            const check = await validateDeckAddition({ deckId: id, userId: req.user.id, cardId: card.card_id, newQty: card.quantity, mode });
            if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
          }
          const sourceEntryId = inventory_type === 'graveyard' ? null : card.source_entry_id ?? null;
          await validateDeckSource(req.user.id, Number(id), card.card_id, card.quantity, sourceEntryId,
            { mode: 'draft', savedSourceEntryId: saved.get(card.card_id)?.source_entry_id });
          await db.run(
            `INSERT INTO deck_cards (deck_id, card_id, quantity, checked_out, source_entry_id) VALUES (?, ?, ?, ?, ?)`,
            [id, card.card_id, card.quantity, card.pulled ? 1 : 0, sourceEntryId]
          );
        }
      }
    });
    res.json({ message: 'Deck updated successfully' });
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to update deck' });
  }
});

router.patch('/:id/record', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'result' && key !== 'delta')
      || !['win', 'loss'].includes(body.result) || ![1, -1].includes(body.delta)) {
    return res.status(400).json({ error: 'Record requires result win or loss and delta 1 or -1' });
  }

  const column = body.result === 'win' ? 'wins' : 'losses';
  try {
    const record = await db.get(
      `UPDATE decks SET ${column} = ${column} + ?
       WHERE id = ? AND user_id = ? AND game = 'mtg'
         AND ${column} + ? BETWEEN 0 AND 2147483647
       RETURNING wins, losses`,
      [body.delta, req.params.id, req.user.id, body.delta]
    );
    if (record) return res.json(record);
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [req.params.id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    return res.status(400).json({ error: 'Wins and losses must remain between 0 and 2147483647' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update deck record' });
  }
});

router.patch('/:id/sleeved', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'sleeved')
      || !Number.isInteger(body.sleeved) || body.sleeved < 0 || body.sleeved > 3) {
    return res.status(400).json({ error: 'Sleeved must be an integer between 0 and 3' });
  }
  try {
    const deck = await db.get(
      `UPDATE decks SET sleeved = ? WHERE id = ? AND user_id = ? AND game = 'mtg' RETURNING sleeved`,
      [body.sleeved, req.params.id, req.user.id]
    );
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    res.json(deck);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update deck sleeves' });
  }
});

router.patch('/:id/card-back', async (req, res) => {
  try {
    const owned = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [req.params.id, req.user.id]);
    if (!owned) return res.status(404).json({ error: 'Deck not found' });
    const back = await normalizeCardBack(req.body);
    const deck = await db.get(
      `UPDATE decks SET card_back_color = ?, card_back_image = ?
       WHERE id = ? AND user_id = ? AND game = 'mtg' RETURNING card_back_color, card_back_image`,
      [back.card_back_color, back.card_back_image, req.params.id, req.user.id]
    );
    if (!deck) return res.status(404).json({ error: 'Deck not found' });
    res.json(deck);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to update deck card back' });
  }
});

// Designate one existing card as commander; null clears the designation.
router.put('/:id/commander', async (req, res) => {
  const { id } = req.params;
  const cardId = req.body?.card_id;
  if (cardId !== null && (typeof cardId !== 'string' || !cardId.trim())) {
    return res.status(400).json({ error: 'card_id must be a non-empty string or null' });
  }

  try {
    const deck = await db.get(`SELECT format FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found or unauthorized' });
    if (!/commander|edh|brawl/i.test(deck.format)) {
      return res.status(400).json({ error: 'Only Commander / EDH or Brawl decks can designate a commander' });
    }
    const result = await db.run(
      `UPDATE decks SET commander_card_id = ?
       WHERE id = ? AND user_id = ? AND format = ? AND (? IS NULL OR EXISTS (
         SELECT 1 FROM deck_cards WHERE deck_id = decks.id AND card_id = ? AND quantity > 0
       ))`,
      [cardId, id, req.user.id, deck.format, cardId, cardId]
    );
    if (!result.changes) return res.status(400).json({ error: 'Commander must be a card in this deck' });
    res.json({ commander_card_id: cardId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update commander' });
  }
});

// Duplicate Deck
router.post('/:id/duplicate', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(
      `SELECT name, description, notes, game, format, category, accent_color, target_size, inventory_type, commander_card_id, sleeved, card_back_color, card_back_image
       FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`,
      [id, req.user.id]
    );
    if (!deck) return res.status(404).json({ error: 'Deck not found or unauthorized' });

    const duplicateId = await db.withTransaction(async () => {
      const result = await db.run(
        `INSERT INTO decks (name, description, notes, game, format, category, accent_color, target_size, inventory_type, commander_card_id, sleeved, card_back_color, card_back_image, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${deck.name} (Copy)`, deck.description, deck.notes ?? '', deck.game, deck.format, deck.category, deck.accent_color, deck.target_size, deck.inventory_type, deck.commander_card_id, deck.sleeved, deck.card_back_color, deck.card_back_image, req.user.id]
      );
      await db.run(
        `INSERT INTO deck_cards (deck_id, card_id, quantity, source_entry_id)
         SELECT ?, card_id, quantity, source_entry_id FROM deck_cards WHERE deck_id = ?`,
        [result.lastID, id]
      );
      return result.lastID;
    });

    res.status(201).json({ message: 'Deck duplicated successfully', id: duplicateId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to duplicate deck' });
  }
});

// Delete Deck
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Verify ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Manual cascade deletion
    await db.run(`DELETE FROM deck_cards WHERE deck_id = ?`, [id]);
    await db.run(`DELETE FROM decks WHERE id = ?`, [id]);

    res.json({ message: 'Deck deleted successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete deck' });
  }
});

// Add/Update Card in Deck
router.post('/:id/cards', async (req, res) => {
  const { id } = req.params;
  const { card_id, quantity = 1 } = req.body;

  if (!card_id) {
    return res.status(400).json({ error: 'card_id is required' });
  }
  if (typeof card_id !== 'string') {
    return res.status(400).json({ error: 'Unsupported card ID' });
  }

  try {
    // Verify deck ownership
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }

    // Resolve uncached metadata through the provider that owns this card ID.
    let card = await db.get(`SELECT id, game FROM card_cache WHERE id = ?`, [card_id]);
    if (card && card.game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
    if (!card) {
      if (!card_id.startsWith('mtg-')) return res.status(400).json({ error: 'Unsupported card ID' });
      console.log(`Card ${card_id} not in cache. Fetching...`);
      const apiCard = await cardApi.getCardById(card_id);
      if (!apiCard) {
        return res.status(404).json({ error: `Card ${card_id} not found on Scryfall.` });
      }
    }

    await db.withTransaction(async () => {
      // Validate and change composition under the same lock as checkout.
      const check = await validateDeckAddition({ deckId: id, userId: req.user.id, cardId: card_id, newQty: quantity });
      if (!check.ok) throw Object.assign(new Error(check.error), { status: 400 });
      await db.run(`
        INSERT INTO deck_cards (deck_id, card_id, quantity)
        VALUES (?, ?, ?)
        ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = ?
      `, [id, card_id, parseInt(quantity, 10), parseInt(quantity, 10)]);
      if (parseInt(quantity, 10) === 0) {
        await db.run(`UPDATE decks SET commander_card_id = NULL WHERE id = ? AND commander_card_id = ?`, [id, card_id]);
      }
    });

    // Record initial price history trend if card is added
    const cacheCard = await db.get(`SELECT price_trend FROM card_cache WHERE id = ?`, [card_id]);
    if (cacheCard) await recordPrice(card_id, cacheCard.price_trend);

    res.json({ message: 'Card added/updated in deck successfully' });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to add card to deck' });
  }
});

// Mark an individual deck card as physically pulled.
router.put('/:id/cards/:card_id/pulled', async (req, res) => {
  const { id, card_id } = req.params;
  const { pulled } = req.body || {};
  if (typeof pulled !== 'boolean') return res.status(400).json({ error: 'pulled must be a boolean' });

  try {
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
    if (!deck) return res.status(404).json({ error: 'Deck not found or unauthorized' });

    const result = await db.run(
      `UPDATE deck_cards SET checked_out = ? WHERE deck_id = ? AND card_id = ?`,
      [pulled ? 1 : 0, id, card_id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Card not found in deck' });
    res.json({ pulled });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update pull status' });
  }
});

// Remove Card from Deck
router.delete('/:id/cards/:card_id', async (req, res) => {
  const { id, card_id } = req.params;
  try {
    await db.withTransaction(async () => {
      const deck = await db.get(`SELECT id, checked_out FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
      if (!deck) throw Object.assign(new Error('Deck not found or unauthorized'), { status: 404 });
      if (deck.checked_out) throw Object.assign(new Error('Return this deck before changing its cards'), { status: 400 });
      await db.run(`DELETE FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [id, card_id]);
      await db.run(`UPDATE decks SET commander_card_id = NULL WHERE id = ? AND commander_card_id = ?`, [id, card_id]);
    });
    res.json({ message: 'Card removed from deck successfully' });
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to remove card from deck' });
  }
});

// Checkout Deck (mark as in play)
router.put('/:id/checkout', async (req, res) => {
  const { id } = req.params;
  try {
    await db.withTransaction(async () => {
      const deck = await db.get(`SELECT id, game, inventory_type, checked_out FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
      if (!deck) throw Object.assign(new Error('Deck not found or unauthorized'), { status: 404 });
      if (deck.inventory_type !== 'collection') throw Object.assign(new Error('Only Physical decks can be checked out'), { status: 400 });
      if (deck.checked_out) return;
      await reserveDeckSources(deck, req.user.id);
      await db.run(`UPDATE decks SET checked_out = 1, checked_out_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
    });
    res.json({ message: 'Deck checked out successfully' });
  } catch (error) {
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to checkout deck', ...(error.details ? { details: error.details } : {}) });
  }
});

// Return Deck (mark as returned to storage)
router.put('/:id/return', async (req, res) => {
  const { id } = req.params;
  try {
    const deck = await db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ? AND game = 'mtg'`, [id, req.user.id]);
    if (!deck) {
      return res.status(404).json({ error: 'Deck not found or unauthorized' });
    }
    await db.withTransaction(async () => {
      await db.run(`UPDATE decks SET checked_out = 0, checked_out_at = NULL WHERE id = ?`, [id]);
      await db.run(`DELETE FROM deck_card_allocations WHERE deck_id = ?`, [id]);
    });
    res.json({ message: 'Deck returned to storage successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to return deck' });
  }
});

module.exports = router;
