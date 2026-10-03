const crypto = require('crypto');
const db = require('../db');

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const cardKey = (card, preference) => preference === 'any' && card.name?.trim() ? `name:${card.name}` : `id:${card.card_id}`;

async function acquisitionDeckNeeds(userId) {
  const required = await db.all(`SELECT d.id AS deck_id, d.inventory_type, dc.card_id, cc.name, dc.quantity
    FROM decks d JOIN deck_cards dc ON dc.deck_id = d.id JOIN card_cache cc ON cc.id = dc.card_id
    WHERE d.user_id = ? AND d.game = 'mtg' AND cc.game = 'mtg'
      AND d.inventory_type IN ('collection', 'arena') AND dc.quantity > 0`, [userId]);
  const entries = await db.all(`SELECT c.card_id, cc.name, c.list_type, SUM(c.quantity) AS quantity
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id
    WHERE c.user_id = ? AND c.game = 'mtg' AND cc.game = 'mtg' AND c.quantity > 0
      AND c.list_type IN ('collection', 'arena') AND COALESCE(c.missing, 0) = 0
    GROUP BY c.card_id, c.list_type`, [userId]);
  const needs = new Map();
  for (const preference of ['exact', 'any']) {
    const owned = new Map();
    for (const entry of entries) {
      const key = `${entry.list_type}:${cardKey(entry, preference)}`;
      owned.set(key, (owned.get(key) || 0) + entry.quantity);
    }
    const decks = new Map();
    for (const card of required) {
      if (!decks.has(card.deck_id)) decks.set(card.deck_id, new Map());
      const cards = decks.get(card.deck_id);
      const key = `${card.inventory_type}:${cardKey(card, preference)}`;
      cards.set(key, (cards.get(key) || 0) + card.quantity);
    }
    for (const [id, cards] of decks) {
      if (!needs.has(id)) needs.set(id, { exact: 0, any: 0 });
      for (const [key, quantity] of cards) needs.get(id)[preference] += Math.max(0, quantity - (owned.get(key) || 0));
    }
  }
  return needs;
}

// Ownership planning, not checkout: reservations remain owned; missing copies do not.
async function acquisitionPlan(userId, body) {
  const { deck_ids: ids, preference } = body || {};
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(ids).size !== ids.length) fail('Choose between 1 and 100 distinct saved decks.');
  if (!['exact', 'any'].includes(preference)) fail('Choose exact or any printing.');
  const placeholders = ids.map(() => '?').join(',');
  const decks = await db.all(`SELECT id, inventory_type FROM decks WHERE user_id = ? AND game = 'mtg' AND id IN (${placeholders})`, [userId, ...ids]);
  if (decks.length !== ids.length) fail('Deck not found.', 404);
  const inventory = decks[0].inventory_type;
  if (!['collection', 'arena'].includes(inventory) || decks.some(deck => deck.inventory_type !== inventory)) {
    fail('Choose only Physical decks or only Arena decks. Graveyard decks cannot be planned.');
  }
  const required = await db.all(`SELECT cc.id AS card_id, cc.name, cc.set_id, cc.number, cc.language, cc.image_url,
    cc.price_normal, cc.price_currency, SUM(dc.quantity) AS required
    FROM deck_cards dc JOIN card_cache cc ON cc.id = dc.card_id
    WHERE dc.deck_id IN (${placeholders}) AND cc.game = 'mtg' AND dc.quantity > 0
    GROUP BY cc.id ORDER BY cc.id`, ids);
  const key = card => cardKey(card, preference);
  const groups = new Map();
  for (const card of required) {
    const identity = key(card);
    if (!groups.has(identity)) groups.set(identity, { ...card, required: 0, owned: 0, wishlist: 0 });
    const row = groups.get(identity);
    row.required += card.required;
    if (!Number.isSafeInteger(row.required) || row.required > 2147483647) fail('Planned quantity is too large.');
  }
  const entries = await db.all(`SELECT c.card_id, cc.name, c.list_type, SUM(c.quantity) AS quantity
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id
    WHERE c.user_id = ? AND c.game = 'mtg' AND cc.game = 'mtg' AND c.quantity > 0
      AND ((c.list_type = ? AND COALESCE(c.missing, 0) = 0) OR (c.list_type = 'wishlist' AND ? = 'collection'))
    GROUP BY c.card_id, c.list_type`, [userId, inventory, inventory]);
  for (const entry of entries) {
    const row = groups.get(key(entry));
    if (row) row[entry.list_type === 'wishlist' ? 'wishlist' : 'owned'] += entry.quantity;
  }
  const totals = {};
  let unknown = 0;
  const items = [...groups.values()].map(card => {
    const needed = Math.max(0, card.required - card.owned);
    const to_add = Math.max(0, needed - card.wishlist);
    const currency = /^[A-Z]{3}$/.test(card.price_currency || '') ? card.price_currency : null;
    const unit_price = inventory === 'collection' && currency && Number.isFinite(card.price_normal) && card.price_normal > 0 ? card.price_normal : null;
    const estimated_cost = unit_price === null ? null : Math.round(needed * unit_price * 100) / 100;
    if (needed > 0) {
      if (estimated_cost === null) unknown += needed;
      else totals[currency] = Math.round(((totals[currency] || 0) + estimated_cost) * 100) / 100;
    }
    return { card_id: card.card_id, name: card.name, set_id: card.set_id, number: card.number, language: card.language, image_url: card.image_url,
      required: card.required, owned: card.owned, wishlist: card.wishlist, needed, to_add, unit_price, currency, estimated_cost };
  });
  const plan = { inventory, preference, items, totals, unknown };
  return { ...plan, revision: crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}

module.exports = { acquisitionPlan, acquisitionDeckNeeds };
