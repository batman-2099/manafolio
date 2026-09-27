// Deck construction rules, enforced server-side so every path that writes
// deck_cards (deck builder POST, the collection "add to deck" bulk action)
// obeys them — the frontend checks were advisory and easy to bypass.
const db = require('../db');
const { validateDeckSource } = require('./collectionHelpers');

function parseSubtypes(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) { try { return JSON.parse(raw); } catch { return []; } }
  return [];
}

// Basic lands are exempt from the per-name copy limit.
function isBasicLand(card, game = 'mtg') {
  if (!card) return false;
  const subs = parseSubtypes(card.subtypes);
  if (game === 'mtg' || card.game === 'mtg') {
    return (subs.includes('Land') || card.supertype === 'Land') &&
      (subs.includes('Basic') || /^(?:Snow-Covered )?(?:Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(card.name));
  }
  return false;
}

// Validate setting a deck's copy count of `cardId` to `newQty`.
// Returns { ok: true } or { ok: false, error }. Drafts enforce construction
// rules without requiring inventory; additions also require owned copies.
async function validateDeckAddition({ deckId, userId, cardId, newQty, dbClient, mode = 'addition' }) {
  const client = dbClient || db;
  const qty = parseInt(newQty, 10);
  if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: 'Invalid quantity' };

  const card = await client.get(
    `SELECT id, name, supertype, subtypes, game FROM card_cache WHERE id = ?`, [cardId]
  );
  if (!card) return { ok: false, error: 'Card not found' };

  const deck = await client.get(`SELECT game, inventory_type, checked_out FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
  if (!deck) return { ok: false, error: 'Deck not found or unauthorized' };
  if (card.game !== deck.game) return { ok: false, error: 'Unsupported game' };
  const existing = await client.get(`SELECT quantity, source_entry_id FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, cardId]);
  if (deck?.checked_out) {
    return existing?.quantity === qty ? { ok: true } : { ok: false, error: 'Return this deck before changing its cards' };
  }
  if (mode !== 'draft' && qty > 0 && existing?.source_entry_id != null) {
    try {
      await validateDeckSource(userId, deckId, cardId, qty, existing.source_entry_id);
    } catch (error) {
      if (!error.status) throw error;
      return { ok: false, error: error.message };
    }
  }
  if (mode !== 'draft') {
    const inventoryType = deck.inventory_type === 'arena' ? 'arena' : 'collection';
    const ownedRow = await client.get(
      `SELECT COALESCE(SUM(quantity), 0) AS owned FROM collection
       WHERE card_id = ? AND user_id = ? AND list_type = ?`, [cardId, userId, inventoryType]
    );
    const owned = ownedRow ? ownedRow.owned : 0;
    if (qty > owned) {
      return { ok: false, error: `You only own ${owned} ${owned === 1 ? 'copy' : 'copies'} of ${card.name}.` };
    }
  }

  const game = deck?.game || card.game || 'mtg';

  if (!isBasicLand(card, game)) {
    // Copies of the same NAME already in the deck under a different card_id
    // (alt arts / reprints) count toward the 4-card limit.
    const otherRow = await client.get(
      `SELECT COALESCE(SUM(dc.quantity), 0) AS other
       FROM deck_cards dc JOIN card_cache cc ON dc.card_id = cc.id
       WHERE dc.deck_id = ? AND cc.name = ? AND dc.card_id != ?`,
      [deckId, card.name, cardId]
    );
    const other = otherRow ? otherRow.other : 0;
    if (other + qty > 4) {
      return { ok: false, error: `Cannot have more than 4 copies of ${card.name}.` };
    }
  }

  return { ok: true };
}

module.exports = { isBasicLand, validateDeckAddition };
