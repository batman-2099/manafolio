// The one place that knows card_cache's column list.
// Scryfall writes normalized card shapes through this upsert.
const db = require('../db');

const COLUMNS = [
  'id', 'name', 'supertype', 'subtypes', 'types', 'rarity', 'set_id', 'set_name',
  'number', 'image_url', 'price_trend', 'price_normal', 'price_holofoil',
  'price_avg1', 'price_avg7', 'price_avg30', 'cmc',
  'color_identity', 'game', 'language', 'printed_name',
  'tcgplayer_url', 'cardmarket_url', 'tcgplayer_product_id',
  'price_currency', 'price_source',
];

// A page of results can be 250 cards and one round trip per card cost more than
// the provider fetch did, so rows go in batched — chunked small enough that the
// bound-parameter count stays well inside SQLite's limit.
const CHUNK = 50;

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

// Upsert without deleting referenced card rows or resetting unrelated columns.
const SET_CLAUSE = COLUMNS
  .filter(c => c !== 'id')
  .map(c => `${c} = excluded.${c}`)
  .join(', ');


// Upsert already-normalized cards. `game` is passed rather than read off the card
// so a provider can never write rows under the wrong game by forgetting a field.
async function cacheNormalizedCards(cards, game) {
  const rowSql = `(${COLUMNS.map(() => '?').join(', ')}, CURRENT_TIMESTAMP)`;
  const rows = (cards || []).filter(c => c && c.id);
  if (game !== 'mtg' || rows.some(c => c.game != null && c.game !== game)) {
    throw Object.assign(new Error('Unsupported card game'), { status: 400 });
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const conflict = await db.get(
      `SELECT id FROM card_cache WHERE id IN (${chunk.map(() => '?').join(',')}) AND game IS NOT ? LIMIT 1`,
      [...chunk.map(c => c.id), game]
    );
    if (conflict) throw Object.assign(new Error('Card identity conflicts with stored data'), { status: 400 });
    const params = [];
    for (const c of chunk) {
      params.push(
        c.id, c.name || '', c.supertype || '',
        JSON.stringify(c.subtypes || []), JSON.stringify(c.types || []),
        c.rarity || 'Common', c.set_id || '', c.set_name || '', c.number || '',
        c.image_url || '', num(c.price_trend), num(c.price_normal),
        num(c.price_holofoil), num(c.price_avg1),
        num(c.price_avg7), num(c.price_avg30), num(c.cmc),
        JSON.stringify(c.color_identity || []), game,
        c.language || 'English', c.printed_name || null,
        c.tcgplayer_url || null, c.cardmarket_url || null,
        num(c.tcgplayer_product_id),
        c.price_currency || 'USD', c.price_source || null,
      );
    }
    await db.run(
      `INSERT INTO card_cache (${COLUMNS.join(', ')}, last_updated)
       VALUES ${chunk.map(() => rowSql).join(', ')}
       ON CONFLICT(id) DO UPDATE SET ${SET_CLAUSE}, last_updated = CURRENT_TIMESTAMP`,
      params
    );
  }
}

module.exports = { cacheNormalizedCards, CARD_CACHE_COLUMNS: COLUMNS };
