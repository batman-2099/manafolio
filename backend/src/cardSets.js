// Set discovery and card-list caching: which sets a game has, and fetching a
// set's cards into card_cache.
//
// This file used to build per-set ORB feature indexes for set-scoped scanning.
// That pipeline is gone — scanning is CollectorVision embeddings now (cvScan +
// catalog) — and filling card_cache, which had only ever run as a SIDE EFFECT of
// indexing, is what survives as a job in its own right. Its ORB imports (opencv,
// sharp, fs) and tuning constants went with it; nothing here reads pixels.
const languages = require('./utils/languages');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "This set has no data in this language" — an expected gap, not a failure.
//
// The distinction decides whether a whole build is allowed to finish: per-language
// coverage is patchy enough that counting gaps as failures would abort every
// non-English catalog build partway through (catalog.js cachePhase reads the flag).
// It is a FLAG rather than a phrase in the message, because a correctness decision
// bound to the exact wording of a sentence written for a human breaks the moment
// someone rewords it — which is what the previous owner of this distinction did,
// and why builds started failing with nothing connecting the two.
function absent(message) {
  const e = new Error(message);
  e.absent = true;
  return e;
}

const norm = (set) => (set || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const langOf = (lang) => languages.toCode(lang);

// Scryfall's /sets list, memoised. These three were used below but never
// declared, so line one of getScryfallSets threw ReferenceError on EVERY call:
// the family lookups (getMtgChildSets, getMtgChildSetMap) propagated it, and
// mtgSetFamilyQuery/listAllSets swallowed it and quietly fell back to "no
// children" — which is why a set-scoped MTG build indexed the parent set only.
const SCRYFALL_SETS_TTL_MS = 6 * 60 * 60 * 1000;
let scryfallSetsCache = null;
let scryfallSetsCacheAt = 0;

async function getScryfallSets() {
  if (scryfallSetsCache && (Date.now() - scryfallSetsCacheAt < SCRYFALL_SETS_TTL_MS)) {
    return scryfallSetsCache;
  }
  const scryfallApi = require('./scryfallApi');
  try {
    const r = await scryfallApi.scryGetRetried('https://api.scryfall.com/sets');
    scryfallSetsCache = r.data.data || [];
    scryfallSetsCacheAt = Date.now();
  } catch {
    if (!scryfallSetsCache) scryfallSetsCache = [];
  }
  return scryfallSetsCache;
}

async function getScanExclusions() {
  const db = require('./db');
  try {
    const row = await db.get(`
      SELECT scan_exclude_tokens, scan_exclude_art_cards, scan_exclude_jumpstart, scan_exclude_promos
      FROM app_settings WHERE id = 1
    `);
    return {
      tokens: !!(row && row.scan_exclude_tokens),
      artCards: !!(row && row.scan_exclude_art_cards),
      jumpstart: !!(row && row.scan_exclude_jumpstart),
      promos: !!(row && row.scan_exclude_promos),
    };
  } catch {
    return { tokens: false, artCards: false, jumpstart: false, promos: false };
  }
}


// Does this child set survive the user's scan exclusions? One definition, shared
// by everything that folds children into their parent, so the family a build
// indexes and the family the UI lists can never drift apart.
function childAllowed(s, exclusions, excludeChildCodes = []) {
  if (exclusions.tokens && s.set_type === 'token') return false;
  if (exclusions.artCards && s.set_type === 'memorabilia') return false;
  if (exclusions.jumpstart && s.set_type === 'starter') return false;
  if (exclusions.promos && s.set_type === 'promo') return false;
  return !excludeChildCodes.includes(s.code);
}

const childBrief = (s) => ({
  code: s.code,
  name: s.name,
  symbol_url: s.icon_svg_uri || null,
  cardCount: s.card_count || 0,
  type: s.set_type || 'subset',
});

// Every parent's children in ONE pass, as normalized-parent-code -> children[].
//
// This replaced a per-parent lookup that cost a settings query plus a full scan
// of the ~900 entry Scryfall set list EACH TIME: a caller wanting children for
// every set in the catalogue paid that ~460 times per request. One query, one
// pass, same answer — and now the only shape of this question anything asks.
async function getMtgChildSetMap() {
  const [sets, exclusions] = await Promise.all([getScryfallSets(), getScanExclusions()]);
  const map = new Map();
  for (const s of sets) {
    if (!s.parent_set_code || s.digital) continue;
    if (!childAllowed(s, exclusions)) continue;
    const parent = norm(s.parent_set_code);
    const arr = map.get(parent);
    if (arr) arr.push(childBrief(s)); else map.set(parent, [childBrief(s)]);
  }
  return map;
}

// A Scryfall release is split into a parent expansion plus child sets — tokens,
// promos, art series, Commander — each with its own set code (tecl, pecl, ...),
// linked by parent_set_code. Build a query spanning the whole family so "ecl"
// indexes tokens/art/etc., not just the 408 main-set prints. Digital-only sets
// (Alchemy) are skipped — no physical card to scan. include:extras stops Scryfall
// hiding tokens/emblems; -is:digital drops any stray digital print.
async function mtgSetFamilyQuery(set, lang, { excludeChildCodes = [] } = {}) {
  const code = norm(set);
  const codes = new Set([code]);
  const exclusions = await getScanExclusions();
  try {
    const data = await getScryfallSets();
    for (const s of data) {
      // norm() on both sides, matching getMtgChildSets — the UI lists the family
      // from that function and the build queries it from this one, so a
      // difference here means indexing something other than what was shown.
      if (s.parent_set_code && norm(s.parent_set_code) === code && !s.digital
          && childAllowed(s, exclusions, excludeChildCodes)) {
        codes.add(s.code);
      }
    }
  } catch { /* /sets unreachable: fall back to the main set only */ }
  const sets = [...codes].map(c => `set:${c}`).join(' or ');
  // Language is a search keyword (and needs include_multilingual on the request,
  // added by mtgSearchUrl below) — Scryfall has no lang parameter.
  const scryLang = languages.resolve(lang).scryfall;
  const langTerm = scryLang === 'en' ? '' : ` lang:${scryLang}`;
  return `(${sets}) include:extras unique:prints -is:digital${langTerm}`;
}

// Search URL for a set family in one language. English omits
// include_multilingual so the query stays exactly what it was before languages.
function mtgSearchUrl(query, lang, extra = '') {
  const multilingual = languages.resolve(lang).scryfall === 'en' ? '' : '&include_multilingual=true';
  return `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}${extra}${multilingual}`;
}

// Every set worth building a global index from, as set codes in build order.
//
// MTG returns PARENT sets only. mtgSetFamilyQuery above already folds a set's
// children (tokens, art series, promos — anything linked by parent_set_code)
// into the parent's index, so enumerating the children as well would index the
// same printings twice: harmless for correctness (scanMatch treats repeated
// set|number rows as faces and keeps the best) but a straight waste of build
// time and disk. Digital-only sets are skipped — no physical card to scan.
async function listAllSets(game, lang) {
  if (game !== 'mtg') throw new Error('Unsupported game');
  const sets = await getScryfallSets();
  return sets
    .filter(s => s.code && !s.digital && !s.parent_set_code && (s.card_count || 0) > 0)
    .map(s => s.code);
}

// MTG: page Scryfall for a set family in one language.
// ponytail: keep raw cards once per scannable face; the catalog only needs the count.
async function fetchMtgSet(set, lang, { excludeChildCodes = [] } = {}) {
  const scryfallApi = require('./scryfallApi');
  let url = mtgSearchUrl(await mtgSetFamilyQuery(set, lang, { excludeChildCodes }), lang, '&order=set');
  const cards = [];
  while (url) {
    const r = await scryfallApi.scryGetRetried(url);
    for (const c of r.data.data || []) {
      if (c.image_uris?.normal) cards.push(c);
      else for (const face of c.card_faces || []) {
        if (face.image_uris?.normal) cards.push(c);
      }
    }
    url = r.data.has_more ? r.data.next_page : null;
    await sleep(120);
  }
  return cards;
}


// Fetch a set from its provider and cache its cards. This was once half of a job
// that also built an ORB index for the set; the index half is gone and this half
// is what the catalog builder calls.
//
// Returns the fetched cards so a caller can count them.
async function cacheSetCards(game, set, lang, { excludeChildCodes = [] } = {}) {
  if (game !== 'mtg') throw new Error('Unsupported game');
  const code = langOf(lang);
  const cards = await fetchMtgSet(set, code, { excludeChildCodes });
  if (cards.length === 0) throw absent(`no cards for set ${set}`);
  await cacheFetchedCards(cards, code);
  return cards;
}

// Cache full card data so the post-match /api/search is an instant local
// card_cache hit instead of a live (throttled) provider fetch per scan.
async function cacheFetchedCards(cards, code) {
  try {
    const scryfallApi = require('./scryfallApi');
    const seen = new Set();
    const rows = cards.filter(c => c.id && (seen.has(c.id) ? false : seen.add(c.id)));
    await scryfallApi.cacheCards(rows.map(c => scryfallApi.normalizeCard(c, code)));
  } catch (e) { console.warn(`cardSets: caching cards failed: ${e.message}`); }
}

module.exports = {
  listAllSets, cacheSetCards, getMtgChildSetMap, getScanExclusions,
};
