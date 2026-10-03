const express = require('express');
const db = require('../db');
const router = express.Router();
const { getSetChecklist } = require('../scryfallApi');
const { physicalCardEntries, checkedOutAllocation } = require('../utils/collectionHelpers');
const { setCompletion } = require('../utils/setCompletion');

router.get('/:code/completion', async (req, res) => {
  const code = req.params.code.replace(/^mtg-/, '').toLowerCase();
  const inventory = req.query.inventory_type;
  if (!/^[a-z0-9]{2,12}$/.test(code) || !['collection', 'arena'].includes(inventory)) {
    return res.status(400).json({ error: 'Choose a valid set and Physical or Arena inventory.' });
  }
  res.set('Cache-Control', 'no-store');
  try {
    const catalog = await getSetChecklist(code);
    const entries = await db.all(`
      SELECT c.id AS entry_id, c.quantity, c.printing, c.missing, c.list_type, cc.set_id, cc.number
      FROM collection c JOIN card_cache cc ON cc.id = c.card_id AND cc.game = c.game
      WHERE c.user_id = ? AND c.list_type = ? AND c.game = 'mtg' AND cc.set_id = ? AND c.quantity > 0
    `, [req.user.id, inventory, code]);
    if (inventory === 'collection') {
      const eligible = new Set((await physicalCardEntries(req.user.id)).map(entry => entry.entry_id));
      const allocated = await checkedOutAllocation(req.user.id);
      for (const entry of entries) {
        entry.available = eligible.has(entry.entry_id) ? Math.max(0, entry.quantity - (allocated.get(entry.entry_id) || 0)) : 0;
      }
    }
    res.json({ set: code, inventory, goals: setCompletion(catalog, entries, inventory) });
  } catch (error) {
    console.warn('Set completion unavailable:', error.message);
    res.status(502).json({ error: 'Set catalog unavailable. Retry to load the complete checklist.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const game = req.query.game === undefined ? 'mtg' : req.query.game;
    if (game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
    const where = `WHERE game = ?`;
    const params = [game];
    const sets = await db.all(`
      SELECT id, name, series, printed_total, total, release_date, symbol_url, logo_url, game
      FROM sets
      ${where}
      ORDER BY release_date ASC
    `, params);
    // ?tree=1: parents only, each carrying its subsets. A Scryfall release is one
    // parent expansion plus a handful of child sets (tokens, art series, promos,
    // Commander decks) that each have their OWN set code, so a scan scoped to
    // "fdn" silently excludes every token in the box. The scanner's set filter
    // needs the family to offer them, and needs them separable so a user who is
    // not feeding tokens in can drop them. Opt-in because every other caller
    // wants the flat list it has always had.
    if (req.query.tree === '1' && game === 'mtg') {
      const { getMtgChildSetMap } = require('../cardSets');
      const childMap = await getMtgChildSetMap();
      const childCodes = new Set([...childMap.values()].flatMap(cs => cs.map(c => c.code)));
      const code = (s) => String(s.id || '').replace(/^mtg-/, '');
      return res.json(
        sets
          .filter(s => !childCodes.has(code(s)))
          .map(s => ({ ...s, children: childMap.get(code(s).toLowerCase().replace(/[^a-z0-9]/g, '')) || [] }))
      );
    }
    res.json(sets);
  } catch (error) {
    console.error('Error fetching sets:', error);
    res.status(500).json({ error: 'Failed to retrieve sets' });
  }
});

module.exports = router;
