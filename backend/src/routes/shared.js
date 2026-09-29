const express = require('express');
const db = require('../db');
const { resolveCardPrice, parseCardRow } = require('../utils/priceHelpers');
const { compartmentLabel } = require('../utils/compartmentSort');

const router = express.Router();

router.get('/decks/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^[a-f0-9]{64}$/.test(req.params.token)) {
    return res.status(404).json({ error: 'Shared deck not found' });
  }
  try {
    const result = await db.withTransaction(async () => {
      const row = await db.get(`SELECT d.id, u.username AS owner, d.name, d.description,
        d.game, d.format, d.category, d.wins, d.losses, d.commander_card_id
        FROM deck_shares s JOIN decks d ON d.id = s.deck_id JOIN users u ON u.id = d.user_id
        WHERE s.token = ? AND d.game = 'mtg'`, [req.params.token]);
      if (!row) return null;
      const { id, owner, ...deck } = row;
      const cards = await db.all(`SELECT cc.id, cc.name, cc.printed_name, cc.set_id, cc.set_name,
        cc.number, cc.image_url, cc.game, cc.supertype, cc.types, cc.subtypes, cc.rarity,
        cc.cmc, cc.color_identity, dc.quantity
        FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.card_id
        WHERE dc.deck_id = ? AND cc.game = 'mtg'
        ORDER BY cc.name, cc.id`, [id]);
      return { owner, deck, cards: cards.map(parseCardRow) };
    });
    if (!result) return res.status(404).json({ error: 'Shared deck not found' });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve shared deck' });
  }
});

// One container, laid out the way its owner sees it: its pages or rows, and the
// slot each card sits in — so a shared binder reads as a binder and a shared box
// as a box, instead of collapsing to a flat card list.
//
// Gated on share_locations, not just share_enabled: where a card is stored is
// exactly what this exposes, and that is the setting the owner opts into.
router.get('/:share_token/containers/:id', async (req, res) => {
  if (req.query?.game !== undefined && req.query.game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  const { share_token, id } = req.params;
  try {
    const owner = await db.get(`SELECT id, username, share_enabled, share_locations FROM users WHERE share_token = ?`, [share_token]);
    if (!owner || owner.share_enabled === 0) {
      return res.status(404).json({ error: 'This card collection is private or does not exist.' });
    }
    if (owner.share_locations !== 1) {
      return res.status(404).json({ error: 'This collection does not share where its cards are stored.' });
    }

    const location = await db.get(
      `SELECT id, name, type, sort_order, allow_stacking FROM locations WHERE id = ? AND user_id = ? AND inventory_type = 'collection'`,
      [id, owner.id]
    );
    if (!location) return res.status(404).json({ error: 'Container not found.' });

    const compartments = await db.all(
      `SELECT id, idx, label, capacity FROM compartments WHERE location_id = ? ORDER BY idx ASC`,
      [location.id]
    );

    // Same public column set as the collection share above — no purchase price,
    // no ROI — plus the placement columns the layout is drawn from.
    const rows = await db.all(`
      SELECT c.id AS entry_id, c.card_id, c.compartment_id, c.position, c.quantity, c.condition,
             c.printing, c.language, c.favorite, c.is_trade, c.market_value,
             cc.name, cc.printed_name, cc.supertype, cc.subtypes, cc.types, cc.rarity,
             cc.set_id, cc.set_name, cc.number, cc.image_url, cc.game, cc.cmc, cc.color_identity,
             cc.price_trend, cc.price_normal, cc.price_holofoil
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      WHERE c.location_id = ? AND c.user_id = ? AND c.list_type = 'collection' AND cc.game = 'mtg'
      ORDER BY c.position ASC, c.id ASC
    `, [location.id, owner.id]);

    const cards = rows.map(row => ({ ...parseCardRow(row), price_trend: resolveCardPrice(row) }));

    res.json({
      owner: owner.username,
      location,
      compartments: compartments.map(c => ({ ...c, display_label: compartmentLabel(c, location.type) })),
      cards
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve shared container' });
  }
});

// Retrieve a shared collection by share token
router.get('/:share_token', async (req, res) => {
  if (req.query?.game !== undefined && req.query.game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  const { share_token } = req.params;
  const listType = req.query.list || 'collection';

  try {
    const owner = await db.get(`SELECT id, username, share_enabled, share_locations FROM users WHERE share_token = ?`, [share_token]);
    if (!owner || owner.share_enabled === 0) {
      return res.status(404).json({ error: 'This card collection is private or does not exist.' });
    }

    let filterSql = `WHERE c.user_id = ? AND cc.game = 'mtg'`;
    let filterParams = [owner.id];

    if (listType === 'wishlist') {
      filterSql += ` AND c.list_type = 'wishlist'`;
    } else if (listType === 'trade') {
      filterSql += ` AND c.is_trade = 1 AND c.list_type = 'collection'`;
    } else {
      filterSql += ` AND c.list_type = 'collection'`;
    }

    // Retrieve their collection without private fields (locations, purchase price, ROI)
    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        -- The owner's own valuation for this copy (a graded slab, usually), which
        -- resolveCardPrice prefers. Without it a shared collection prices every
        -- slab as if it were raw, and its total disagrees with the owner's.
        c.market_value,
        cc.name,
        -- The name as printed on a non-English card, so a shared Japanese
        -- collection reads the way the cards actually look.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        l.name AS location_name
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, filterParams);

    const shareLocations = owner.share_locations === 1;
    const formatted = rows.map(row => {
      const card = {
        ...parseCardRow(row),
        price_trend: resolveCardPrice(row),
      };
      // Card locations are private by default; only expose when the owner has
      // opted in, and strip the raw column otherwise.
      delete card.location_name;
      if (shareLocations) card.location = row.location_name || 'Unsorted';
      return card;
    });

    // Calculate public stats
    let totalCards = 0;
    let uniqueCards = formatted.length;
    let totalValue = 0;

    const typeCounts = {};
    const rarityCounts = {};
    const setCounts = {};

    formatted.forEach(row => {
      const qty = row.quantity || 1;
      const price = row.price_trend || 0;

      totalCards += qty;
      totalValue += qty * price;

      row.types.forEach(t => {
        typeCounts[t] = (typeCounts[t] || 0) + qty;
      });
      if (row.types.length === 0) {
        typeCounts['Colorless'] = (typeCounts['Colorless'] || 0) + qty;
      }

      const rarity = row.rarity || 'Unknown';
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + qty;

      if (!setCounts[row.set_id]) {
        setCounts[row.set_id] = { name: row.set_name, count: 0, value: 0 };
      }
      setCounts[row.set_id].count += qty;
      setCounts[row.set_id].value += qty * price;
    });

    res.json({
      owner: owner.username,
      shareLocations,
      collection: formatted,
      stats: {
        summary: {
          totalCards,
          uniqueCards,
          totalValue: parseFloat(totalValue.toFixed(2))
        },
        types: Object.keys(typeCounts).map(name => ({ name, value: typeCounts[name] })),
        rarities: Object.keys(rarityCounts).map(name => ({ name, value: rarityCounts[name] })),
        sets: Object.keys(setCounts).map(id => ({
          id,
          name: setCounts[id].name,
          count: setCounts[id].count,
          value: parseFloat(setCounts[id].value.toFixed(2))
        })).sort((a, b) => b.value - a.value).slice(0, 8)
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve shared collection' });
  }
});

module.exports = router;
