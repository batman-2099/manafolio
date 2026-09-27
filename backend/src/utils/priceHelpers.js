// SQLite's CURRENT_TIMESTAMP stores UTC but as a naive "YYYY-MM-DD HH:MM:SS"
// string with no timezone marker. JS's Date parser treats a string like that
// as LOCAL time, so on any server not running in UTC, a value that's really
// "now" gets parsed as hours off — enough to misorder it against a properly
// UTC-tagged timestamp (e.g. an ISO string with a trailing Z). Always read
// SQLite datetimes through this so they compare correctly against Date.now()
// or other real UTC timestamps.
function parseSqliteUtc(str) {
  if (!str) return new Date(NaN);
  return /Z$|[+-]\d\d:\d\d$/.test(str) ? new Date(str) : new Date(str.replace(' ', 'T') + 'Z');
}

function resolveCardPrice(card) {
  if (!card) return 0;
  // A manual value on an owned copy overrides the raw provider price.
  if (card.market_value > 0) return card.market_value;
  if (card.printing === 'Holofoil' && card.price_holofoil !== null && card.price_holofoil > 0) {
    return card.price_holofoil;
  }
  if (card.printing === 'Normal' && card.price_normal !== null && card.price_normal > 0) {
    return card.price_normal;
  }
  return card.price_trend || 0;
}

// Hydrate a raw card_cache row: its array columns are stored as JSON strings,
// so parse them back to arrays. Missing columns become []; the raw row is untouched.
function parseCardRow(row) {
  if (!row) return row;
  return {
    ...row,
    subtypes: JSON.parse(row.subtypes || '[]'),
    types: JSON.parse(row.types || '[]'),
    color_identity: JSON.parse(row.color_identity || '[]'),
  };
}

// position orders cards WITHIN a single compartment (a binder page, a box
// row) — see compartmentSort.js for how a card's compartment+position is
// chosen in the first place.
async function rebalanceCompartmentPositions(db, compartmentId, userId) {
  if (!compartmentId) return;
  const cards = await db.all(`SELECT id FROM collection WHERE compartment_id = ? AND user_id = ? ORDER BY position ASC, id ASC`, [compartmentId, userId]);
  for (let i = 0; i < cards.length; i++) {
    const cleanPos = (i + 1) * 1000;
    await db.run(`UPDATE collection SET position = ? WHERE id = ? AND user_id = ?`, [cleanPos, cards[i].id, userId]);
  }
}


// Record a price point, but only when it actually moved. The price sweep runs
// on every boot and nodemon reboots on every code edit, so the unguarded insert
// was writing a fresh row per card per restart — 17k rows in a single day, all
// the same number. A price series only needs the points where the price
// changed; the flat stretches between them are implied by the line.
async function recordPrice(cardId, price) {
  if (!cardId || !(price > 0)) return false;
  const db = require('../db');
  const last = await db.get(
    `SELECT price FROM price_history WHERE card_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    [cardId]
  );
  if (last && last.price === price) return false;
  // Millisecond resolution, not CURRENT_TIMESTAMP. recorded_at is part of the
  // primary key, and the default is second-resolution — so two genuine price
  // movements in the same second collided and the second one was silently
  // dropped by OR IGNORE. %f keeps the guard while making that effectively
  // impossible. parseSqliteUtc already reads the fractional form correctly.
  const res = await db.run(
    `INSERT OR IGNORE INTO price_history (card_id, price, recorded_at)
     VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))`,
    [cardId, price]
  );
  if (res && res.changes === 0) {
    await db.run(
      `INSERT OR IGNORE INTO price_history (card_id, price, recorded_at)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now', '+1 millisecond'))`,
      [cardId, price]
    );
  }
  return true;
}

// Scryfall: "We only update prices for cards once per day. Fetching card data
// more frequently than 24 hours will not yield new prices."
// (https://scryfall.com/docs/api/rate-limits). Sweeping more often than daily
// is pure load for zero new data.
const PRICE_SWEEP_INTERVAL_MS = 1000 * 60 * 60 * 24;
// The supported provider's persisted sweep clock.
const SWEEP_COLUMN = {
  mtg: 'mtg_prices_swept_at',
};

// How often the automatic sweep is allowed to run, as configured. 0 turns it off.
// Unreadable or missing settings fall back to daily, which is what every install
// did before this existed.
const DEFAULT_PRICE_REFRESH_DAYS = 1;

async function priceRefreshDays() {
  const db = require('../db');
  try {
    const row = await db.get(`SELECT price_refresh_days FROM app_settings WHERE id = 1`);
    const n = Number(row && row.price_refresh_days);
    return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PRICE_REFRESH_DAYS;
  } catch {
    return DEFAULT_PRICE_REFRESH_DAYS;
  }
}

// Has this game's price sweep gone stale enough to be worth running again?
//
// The timer ticks hourly and this persisted gate decides when a sweep is due.
//
// Hourly rather than daily on purpose: with a daily tick and a daily interval,
// any drift at all leaves "23h 59m elapsed" at the moment of the tick, which
// skips and turns a daily refresh into an every-other-day one. Checking often
// and refusing cheaply has no such edge.
async function shouldSweepPrices(game) {
  const col = SWEEP_COLUMN[game];
  if (!col) return false;
  const days = await priceRefreshDays();
  if (days === 0) return false;            // automatic refresh switched off
  const db = require('../db');
  try {
    const row = await db.get(`SELECT ${col} AS sweptAt FROM app_settings WHERE id = 1`);
    if (!row || !row.sweptAt) return true;
    return Date.now() - parseSqliteUtc(row.sweptAt).getTime() >= days * PRICE_SWEEP_INTERVAL_MS;
  } catch {
    return true; // never block the sweep on a bookkeeping failure
  }
}

async function markPricesSwept(game) {
  const col = SWEEP_COLUMN[game];
  if (!col) return;
  const db = require('../db');
  try {
    await db.run(`UPDATE app_settings SET ${col} = CURRENT_TIMESTAMP WHERE id = 1`);
  } catch (e) {
    console.warn(`Could not record ${game} price sweep time:`, e.message);
  }
}

module.exports = {
  parseSqliteUtc,
  shouldSweepPrices,
  markPricesSwept,
  priceRefreshDays,
  DEFAULT_PRICE_REFRESH_DAYS,
  PRICE_SWEEP_INTERVAL_MS,
  resolveCardPrice,
  parseCardRow,
  rebalanceCompartmentPositions,
  recordPrice
};
