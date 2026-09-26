const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const game = req.query.game === undefined ? 'mtg' : req.query.game;
    if (!['mtg', 'lorcana'].includes(game)) return res.status(400).json({ error: 'Unsupported game' });
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
