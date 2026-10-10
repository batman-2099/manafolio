const express = require('express');
const db = require('../db');
const scryfallApi = require('../scryfallApi');
const mtgjsonApi = require('../mtgjsonApi');
const cvScan = require('../cvScan');
const scanOcr = require('../utils/scanOcr');
const scryfallBulk = require('../scryfallBulk');
const languages = require('../utils/languages');
const psaApi = require('../psaApi');
const cardApi = require('../utils/cardApi');
const { searchLimiter } = require('../middleware/auth');
const { resolveCardPrice, parseCardRow, recordPrice } = require('../utils/priceHelpers');
const { parseSetList } = require('../utils/setQuery');
const { compartmentLabel, isBinderType, rebalanceCompartmentByScheme, stackKey } = require('../utils/compartmentSort');
const { checkedOutAllocation, physicalCardEntries, sourceEntries, reserveDeckSources, resolveCompartmentAndPosition, assertStorageInventory, describePlacement, setStackQuantity, defaultCompartmentPlan } = require('../utils/collectionHelpers');
const { validateDeckAddition } = require('../utils/deckRules');
const { splitPrice } = require('../utils/splitPrice');

const router = express.Router();
const LIST_TYPES = ['collection', 'wishlist', 'arena', 'graveyard'];

async function assertArchivable(userId, entryIds) {
  const allocated = await checkedOutAllocation(userId);
  if (entryIds.some(id => allocated.get(Number(id)) > 0)) {
    throw new AddCardError(409, 'Check in the deck before archiving its checked-out cards.');
  }
}

// Stamp each result with how many copies the user already owns, so browsing a
// set shows what is already in the binder instead of inviting duplicate adds.
// A collection-scope search already reports owned_qty from its own join.
async function attachOwnedQty(cards, userId, listType = 'collection') {
  if (!Array.isArray(cards) || cards.length === 0 || !userId) return;
  const ids = cards.map(c => c.id).filter(Boolean);
  if (ids.length === 0) return;
  const rows = await db.all(
    `SELECT card_id, SUM(quantity) AS qty FROM collection
     WHERE user_id = ? AND list_type = ? AND card_id IN (${ids.map(() => '?').join(',')})
     GROUP BY card_id`,
    [userId, listType ?? 'collection', ...ids]
  );
  const owned = new Map(rows.map(r => [r.card_id, r.qty]));
  for (const c of cards) c.owned_qty = owned.get(c.id) || 0;
}

// Compare collector numbers without insignificant leading zeros.
const sameNumber = (a, b) => {
  const norm = (n) => String(n == null ? '' : n).trim().toLowerCase().replace(/^0+(?=\d)/, '');
  return !!norm(a) && norm(a) === norm(b);
};
// Normalize combined queries (e.g. "Lightning Bolt #5", "FDN 540").
function normalizeSearchParams({ name = '', number = '', set = '', q = '' }) {
  let cleanName = String(name || '').trim();
  let cleanNumber = String(number || '').trim();
  let cleanSet = String(set || '').trim();
  const rawQuery = String(q || '').trim();

  if (!cleanName && !cleanNumber && !cleanSet) cleanName = rawQuery;
  const input = cleanName;

  if (input && !cleanNumber) {
    const pureFrac = input.match(/^#?([A-Z0-9★\-]+)\s*\/\s*[A-Z0-9★\-]+$/i);
    if (pureFrac) {
      cleanNumber = pureFrac[1];
      if (input === cleanName) cleanName = '';
    } else if (/^#?\d+$/i.test(input) || /^#[A-Z0-9★\-]+$/i.test(input)) {
      cleanNumber = input.replace(/^#/, '');
      if (input === cleanName) cleanName = '';
    } else {
      const fracMatch = input.match(/^(.+?)\s+#?([A-Z0-9★\-]+)\s*\/\s*[A-Z0-9★\-]+$/i);
      if (fracMatch) {
        cleanName = fracMatch[1].trim();
        cleanNumber = fracMatch[2].trim();
      } else {
        const hashMatch = input.match(/^(.+?)\s+#([A-Z0-9★\-]+)$/i);
        if (hashMatch) {
          cleanName = hashMatch[1].trim();
          cleanNumber = hashMatch[2].trim();
        } else {
          const numMatch = input.match(/^(.+?)\s+(\d+[A-Z★]?)$/i);
          if (numMatch) {
            cleanName = numMatch[1].trim();
            cleanNumber = numMatch[2].trim();
          }
        }
      }
    }
  }

  if (cleanNumber) {
    cleanNumber = cleanNumber.replace(/^#/, '').split('/')[0].trim();
  }

  return { name: cleanName, number: cleanNumber, set: cleanSet };
}

router.all('/search', searchLimiter, async (req, res) => {
  const query = req.method === 'POST' ? { ...req.query, ...req.body } : req.query;
  const { name: rawName, number: rawNumber, set: rawSet, scope = 'database', lang, prints, q, image, cropped, list_type } = query;
  const game = query.game === undefined ? 'mtg' : query.game;
  if (game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  if (list_type !== undefined && !LIST_TYPES.includes(list_type)) return res.status(400).json({ error: 'Invalid list_type' });
  const { name, number, set } = normalizeSearchParams({ name: rawName, number: rawNumber, set: rawSet, q });
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(250, Math.max(1, parseInt(query.limit, 10) || 60));
  try {
    let { cards, total } = await scryfallApi.searchCards({
      name, number, set, scope, userId: req.user.id, lang,
      allPrints: prints === '1', page, limit, listType: list_type,
    });

    // When an image from a camera scan is attached, score each candidate card
    // against the scan's visual embedding and sort by similarity descending.
    if (image && Array.isArray(cards) && cards.length > 0) {
      const base64 = typeof image === 'string' ? image.replace(/^data:image\/\w+;base64,/, '') : '';
      if (base64) {
        const buf = Buffer.from(base64, 'base64');
        const langName = languages.toName(lang);
        if (cvScan.isBuilt(game, langName)) {
          cards = await cvScan.scoreCards(buf, game, cards, { lang: langName, cropped: !!cropped });
        }
      }
    }

    await attachOwnedQty(cards, req.user.id, list_type);
    // Header, not the body: every existing caller expects a bare array here.
    if (total != null) {
      res.set('X-Total-Count', String(total));
      res.set('Access-Control-Expose-Headers', 'X-Total-Count');
    }
    res.json(cards);
  } catch (error) {
    console.error(error);
    if (error.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      return res.status(503).json({ error: 'Card API is having trouble. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Search failed' });
  }
});

// 1a2. Identify a graded slab from the cert number printed on its label.
//
// Returns the cert and candidate printings for the user to choose before adding.
//
// GET, and cheap on a repeat: psaApi caches every cert permanently, so re-checking
// a number costs no quota and works with no token configured.
// Path is spelled in full because this router mounts at /api, not at /api/collection
// — every route here carries its own complete path (see '/search' above).
router.get('/collection/cert/:certNumber', searchLimiter, async (req, res) => {
  try {
    const cert = await psaApi.lookupCert(req.params.certNumber, req.user.psa_api_token || '');
    const brand = `${cert.brand || ''} ${cert.category || ''}`.toUpperCase();
    const game = /MAGIC|GATHERING/.test(brand) ? 'mtg' : null;
    if (!game) return res.status(400).json({ error: 'Unsupported certification game' });
    let candidates = [];
    if (game) {
      const name = psaApi.searchableName(cert.subject);
      if (name) {
        // Number included when PSA gave one: it is the single strongest
        // discriminator between printings of the same name, and the search treats
        // it as optional so a label without one still returns something.
        const number = cert.card_number || '';
        ({ cards: candidates } = await scryfallApi.searchCards({
          name, number, userId: req.user.id,
          allPrints: true, limit: 24,
        }));
        await attachOwnedQty(candidates, req.user.id);
      }
    }
    res.json({ cert, game, candidates });
  } catch (error) {
    // psaApi puts a caller-visible status on everything it throws; anything without
    // one is a genuine bug here rather than a bad cert number.
    const status = error.status || 500;
    if (status >= 500) console.error('cert lookup failed:', error.message);
    res.status(status).json({ error: status >= 500 ? 'Certification lookup failed' : error.message });
  }
});

// 1b. Identify a scanned card image by visual-feature match.
// Which sets the scanner can actually answer for, and how completely.
//
// Not admin-only: this is what the set filter needs to stop offering sets that
// match nothing. Read-only counts, no build controls.
router.get('/scan-sets', async (req, res) => {
  const game = req.query.game === undefined ? 'mtg' : req.query.game;
  if (game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  try {
    // Report built languages so the picker can explain catalog coverage.
    res.json({
      ...await require('../catalog').setCounts(game, languages.toName(req.query.lang)),
      builtLangs: cvScan.builtLangs(game),
    });
  } catch (e) {
    console.error('scan-sets failed:', e.message);
    res.status(500).json({ error: 'Could not read catalog set counts' });
  }
});


const scanSetCode = value => String(value || '').trim().toLowerCase().replace(/^mtg-/, '');
const scanPrintingId = candidate => candidate.card?.id || candidate.cardId || String(candidate.productId);
const scanPairMatches = (card, ocr) => scanSetCode(card.set_id || card.set) === ocr.setCode
  && sameNumber(card.number, ocr.number);

async function scanArtworkPrintings(candidates, sets, langName) {
  const top = candidates[0];
  if (!top?.card) return [];
  const cached = await db.all(`SELECT * FROM card_cache WHERE game = 'mtg' AND name = ?`, [top.card.name]);
  const cards = new Map([...cached, ...candidates.map(c => c.card).filter(Boolean)].map(card => [card.id, card]));
  const illustrations = card => [card?.illustration_id, ...(card?.card_faces || []).map(f => f.illustration_id)].filter(Boolean);
  const art = new Map([...cards].map(([id, card]) => [id, illustrations(card)]));
  // The normalized cache omits illustration IDs. Read them from an already
  // downloaded bulk catalog when available; never download a catalog per scan.
  if (await scryfallBulk.storedMetadata()) {
    const rows = [...new Set([...cards.keys(), ...candidates.map(c => c.cardId).filter(Boolean)])].map(id => ({ id }));
    const { pairs } = await scryfallBulk.resolveRows(rows);
    for (const { row, raw } of pairs) art.set(row.id, illustrations(raw));
  }
  const topArt = new Set([...(art.get(top.card.id) || []), ...(art.get(top.cardId) || [])]);
  if (!topArt.size) return [];
  const wanted = new Set(sets.map(scanSetCode));
  return [...cards.values()].filter(card =>
    (!wanted.size || wanted.has(scanSetCode(card.set_id)))
    && languages.toCode(card.language) === languages.toCode(langName)
    && (art.get(card.id) || []).some(id => topArt.has(id)));
}

async function applyScanSafety(result, footer, { sets, langName }) {
  const candidates = result.candidates;
  const codes = await db.all(`SELECT id AS code FROM sets WHERE game = 'mtg'
    UNION SELECT DISTINCT set_id AS code FROM card_cache WHERE game = 'mtg'`);
  let ocr = typeof footer.tsv === 'string'
    ? scanOcr.parsePrintingTsv(footer.tsv, {
      setCodes: [...codes.map(r => scanSetCode(r.code)), ...candidates.map(c => scanSetCode(c.set))],
    })
    : footer;
  const artPrintings = await scanArtworkPrintings(candidates, sets, candidates[0]?.card?.language || langName);
  const topScore = candidates[0]?.score;
  const nearby = candidates.filter(c => topScore - c.score < cvScan.STRONG_MARGIN);
  const artIds = new Set(artPrintings.map(card => card.id));
  if (ocr.status === 'read') {
    const eligible = candidates.filter(c => scanPairMatches(c.card || c, ocr)
      && (nearby.includes(c) || artIds.has(c.card?.id)));
    if (eligible.length) {
      // OCR corroborates visual evidence, not a set preference. Keep rejected
      // candidates available for review without leaving them in the auto-add tie.
      result.alternatives = candidates.filter(c => !eligible.includes(c));
      result.candidates = [...new Map(eligible.map(c => [scanPrintingId(c), c])).values()];
      ocr = { ...ocr, status: 'matched' };
    } else {
      ocr = { ...ocr, status: 'conflict' };
      // An exact cached OCR printing outside the visual shortlist is useful to a
      // person, but has no measured score and cannot become an automatic match.
      const rows = await db.all(`SELECT * FROM card_cache WHERE game = 'mtg' AND lower(set_id) = ?`, [ocr.setCode]);
      for (const row of rows.filter(card => scanPairMatches(card, ocr))) {
        if (candidates.some(c => scanPrintingId(c) === row.id)) continue;
        const card = parseCardRow(row);
        candidates.push({ cardId: card.id, name: card.name, set: card.set_id, number: card.number, card });
      }
    }
  }
  const top = result.candidates[0];
  const name = typeof footer.nameTsv === 'string'
    ? scanOcr.parseNameTsv(footer.nameTsv) : { status: 'unreadable' };
  const choices = ocr.status === 'matched' ? result.candidates : nearby;
  const identities = new Set(choices.map(scanPrintingId));
  for (const card of artPrintings) {
    if (ocr.status !== 'matched' || scanPairMatches(card, ocr)) identities.add(card.id);
  }
  const quality = result.quality || { blurry: false, glare: false };
  const context = {
    setFallback: !!result.context?.setFallback
      || (sets.length > 0 && (!top?.card || !sets.map(scanSetCode).includes(scanSetCode(top.card.set_id)))),
    languageFallback: !!top?.card && languages.toCode(top.card.language) !== languages.toCode(langName),
  };
  const reasons = [];
  if (quality.blurry) reasons.push('blur');
  if (quality.glare) reasons.push('glare');
  if (identities.size > 1) reasons.push('ambiguous_printing');
  if (!top?.card || !(top.score >= cvScan.STRONG_SIM) || result.detected === false) reasons.push('low_confidence');
  if (result.notInCatalog || !top) reasons.push('not_in_catalog');
  if (context.setFallback) reasons.push('set_fallback');
  if (context.languageFallback) reasons.push('language_fallback');
  if (['conflict', 'unavailable', 'error'].includes(ocr.status)) reasons.push(`ocr_${ocr.status}`);
  result.margin = result.candidates.length > 1
    ? top.score - result.candidates[1].score : (top?.score || 0);
  result.safety = { autoAddSafe: reasons.length === 0, reasons, ocr, name, quality, context };
  result.context = context;
  result.lang = languages.toCode(top?.card?.language || langName);
}

router.post('/scan-match', searchLimiter, async (req, res) => {
  const started = performance.now();
  try {
    const { image, set = '', lang, cropped = false } = req.body || {};
    const game = req.body?.game === undefined ? 'mtg' : req.body.game;
    if (game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
    if (!image || typeof image !== 'string') return res.status(400).json({ error: 'Missing image' });
    const base64 = image.includes(',') ? image.slice(image.indexOf(',') + 1) : image;
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 100) return res.status(400).json({ error: 'Invalid image data' });

    const langName = languages.toName(lang);

    // Set scoping is a FILTER over the catalog, not a different pipeline. The ORB
    // path needed a per-set index built before it could scope a scan (that was the
    // client's "preparing set" wait); a cosine sweep just skips rows that do not
    // belong. A scoped scan is the same scan over fewer candidates — cheaper and
    // more accurate, with nothing to build.
    //
    // Language is not a gate either. A card's artwork is the same in every
    // language, so the English catalog answers "which card is this" for a Spanish
    // or Japanese photo; when a catalog exists in the scanned language cvScan uses
    // it instead. Measured 100% right-card on Spanish/Japanese/French/Italian MTG
    // off the English catalog.
    if (!cvScan.isBuilt(game, langName)) {
      // There is no second matcher to fall back to. Say what is missing and what
      // fixes it, rather than an empty candidate list that reads to the user as
      // "your card could not be identified".
      return res.status(503).json({
        game, lang: langName, candidates: [], verified: false, notBuilt: true,
        error: 'No scan catalog is built for this game and language yet. An admin can build one from Admin → Catalogs.',
      });
    }

    const sets = parseSetList(set);
    const timings = {};
    const matchStarted = performance.now();
    const result = await cvScan.match(buf, game, 8, { sets, lang: langName, cropped: !!cropped });
    timings.matchMs = performance.now() - matchStarted;

    // Recognition needs the crop, not metadata. Catch immediately so a failed
    // subprocess never rejects unobserved while provider requests are pending.
    const ocrPromise = (async () => {
      const ocrStarted = performance.now();
      try {
        const footer = cropped ? buf : (result.crop ? Buffer.from(result.crop.split(',').pop(), 'base64') : null);
        return footer && result.detected !== false
          ? await scanOcr.readCardText(footer) : { status: 'unreadable' };
      } catch (error) {
        console.warn('scan-match OCR failed:', error.message);
        return { status: 'error' };
      } finally {
        timings.ocrMs = performance.now() - ocrStarted;
      }
    })();
    const metadataStarted = performance.now();

    result.candidates = await Promise.all(result.candidates.map(async (cand) => {
      if (!cand.cardId) return cand;
      const card = await scryfallApi.getCardById(cand.cardId).catch(() => null);
      if (!card) return cand;
      // Keep the provider's actual printing language authoritative.
      const localized = languages.toCode(card.language) === languages.toCode(langName) ? null
        : await scryfallApi.getPrintingInLang(card.set_id, card.number, langName).catch(() => null);
      const use = localized && languages.toCode(localized.language) === languages.toCode(langName)
        ? localized : card;
      const marked = languages.toCode(use.language) === languages.toCode(langName)
        ? use : { ...use, langFallback: langName };
      return { ...cand, name: use.name, set: use.set_id, number: use.number, card: marked };
    }));

    result.candidates = result.candidates.filter((candidate, index, all) =>
      all.findIndex(other => scanPrintingId(other) === scanPrintingId(candidate)) === index);
    timings.metadataMs = performance.now() - metadataStarted;
    const footer = await ocrPromise;
    const safetyStarted = performance.now();
    await applyScanSafety(result, footer, { sets, langName });
    timings.safetyMs = performance.now() - safetyStarted;
    // Overlapping wall-clock stages: these durations are not additive.
    result.timings = { ...timings, totalMs: performance.now() - started };

    return res.json(result);
  } catch (error) {
    console.error('scan-match failed:', error.message);
    res.status(500).json({ error: 'Scan match failed' });
  }
});

// 2. Get User's Collection
router.get('/collection', async (req, res) => {
  if (req.query?.game !== undefined && req.query.game !== 'mtg') return res.status(400).json({ error: 'Unsupported game' });
  try {
    const listType = req.query.list_type || 'collection';
    if (!LIST_TYPES.includes(listType)) return res.status(400).json({ error: 'Invalid list_type' });
    const isTrade = req.query.is_trade;
    const compId = req.query.compartment_id;

    let filterSql = `WHERE c.user_id = ? AND c.list_type = ? AND cc.game = 'mtg'`;
    let filterParams = [req.user.id, listType];

    if (isTrade !== undefined) {
      filterSql += ` AND c.is_trade = ?`;
      filterParams.push(isTrade === 'true' || isTrade === '1' ? 1 : 0);
    }
    if (compId !== undefined) {
      filterSql += ` AND c.compartment_id = ?`;
      filterParams.push(compId);
    }

    const query = `
      SELECT
        c.id as entry_id,
        c.card_id,
        c.quantity,
        c.condition,
        c.printing,
        c.language,
        c.purchase_price,
        c.compartment_id,
        c.position,
        c.added_at,
        c.is_trade,
        c.favorite,
        c.list_type,
        c.notes,
        c.grader,
        c.grade,
        c.cert_number,
        c.market_value,
        c.market_value_source,
        c.market_value_at,
        c.missing,
        cc.name,
        -- The localized name for a non-English printing, so every view that
        -- renders a collection card can show it as the card actually reads.
        cc.printed_name,
        cc.supertype,
        cc.subtypes,
        cc.types,
        cc.cmc,
        cc.color_identity,
        cc.rarity,
        cc.set_id,
        cc.set_name,
        cc.number,
        cc.image_url,
        cc.price_trend,
        cc.price_normal,
        cc.price_holofoil,
        cc.price_currency,
        cc.price_source,
        cc.game,
        cc.tcgplayer_url,
        cc.cardmarket_url,
        cc.tcgplayer_product_id,
        l.id as location_id,
        l.name as location_name,
        su.name as storage_unit_name,
        l.type as location_type,
        cp.idx as compartment_idx,
        cp.label as compartment_label,
        cp.capacity as compartment_capacity,
        checked_out_decks.deck_names
      FROM collection c
      JOIN card_cache cc ON c.card_id = cc.id
      LEFT JOIN locations l ON c.location_id = l.id
      LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = c.user_id
      LEFT JOIN compartments cp ON c.compartment_id = cp.id
      LEFT JOIN (
        SELECT dc.card_id, d.user_id, GROUP_CONCAT(d.name, ', ') AS deck_names
        FROM deck_cards dc
        JOIN decks d ON d.id = dc.deck_id
        WHERE d.user_id = ? AND d.inventory_type = 'collection' AND (d.checked_out = 1 OR dc.checked_out = 1)
        GROUP BY dc.card_id, d.user_id
      ) checked_out_decks ON checked_out_decks.card_id = c.card_id AND checked_out_decks.user_id = c.user_id
      ${filterSql}
      ORDER BY c.added_at DESC
    `;
    const rows = await db.all(query, [req.user.id, ...filterParams]);

    const alloc = listType === 'collection' ? await checkedOutAllocation(req.user.id) : new Map();
    // Display pulled copies without turning a pull flag into a reservation.
    const inDeck = new Map(alloc);
    if (listType === 'collection') {
      const pulled = await db.all(`
        SELECT dc.*, d.game FROM deck_cards dc JOIN decks d ON d.id = dc.deck_id
        WHERE d.user_id = ? AND d.inventory_type = 'collection'
          AND d.checked_out = 0 AND dc.checked_out = 1 AND dc.quantity > 0
        ORDER BY (dc.source_entry_id IS NOT NULL) DESC, d.id, dc.card_id
      `, [req.user.id]);
      const entries = pulled.length ? await physicalCardEntries(req.user.id) : [];
      for (const card of pulled) {
        let needed = card.quantity;
        for (const entry of sourceEntries(entries, card, card.game)) {
          const used = inDeck.get(entry.entry_id) || 0;
          const take = Math.min(needed, Math.max(0, entry.quantity - used));
          if (take > 0) inDeck.set(entry.entry_id, used + take);
          needed -= take;
          if (needed <= 0) break;
        }
      }
    }

    const formatted = rows.map(row => ({
      ...parseCardRow(row),
      price_trend: resolveCardPrice(row),
      checked_out_qty: alloc.get(row.entry_id) || 0,
      in_deck_qty: inDeck.get(row.entry_id) || 0,
      compartment_display_label: row.compartment_id
        ? compartmentLabel({ idx: row.compartment_idx, label: row.compartment_label }, row.location_type)
        : null,
      sub_location: row.compartment_id
        ? `${row.location_type === 'Binder' ? 'Page' : 'Row'} ${row.compartment_idx}`
        : ''
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch collection' });
  }
});

// A text-only snapshot: keep inventory and exact checkout allocations in one read.
router.get('/collection/offline-snapshot', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const snapshot = await db.withTransaction(async () => {
      const user = await db.get('SELECT id, username FROM users WHERE id = ?', [req.user.id]);
      if (!user) return null;
      const rows = await db.all(`
        SELECT c.id AS entry_id, c.card_id, cc.name, cc.printed_name,
          cc.set_id, cc.set_name, cc.number, c.quantity, c.list_type,
          c.printing, c.language, c.condition, cc.color_identity,
          COALESCE(c.missing, 0) AS missing,
          l.id AS location_id, l.name AS location_name, su.name AS storage_unit_name,
          l.type AS location_type, cp.idx AS compartment_idx, cp.label AS compartment_label,
          CASE WHEN l.id IS NOT NULL THEN c.position ELSE NULL END AS position
        FROM collection c
        JOIN card_cache cc ON cc.id = c.card_id AND cc.game = c.game
        LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
          AND c.list_type = 'collection' AND l.inventory_type = 'collection'
        LEFT JOIN storage_units su ON su.id = l.storage_unit_id AND su.user_id = c.user_id
        LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
        WHERE c.user_id = ? AND c.game = 'mtg'
          AND c.list_type IN ('collection', 'arena', 'wishlist')
        ORDER BY c.id
      `, [user.id]);
      const allocated = await checkedOutAllocation(user.id);
      return {
        version: 1,
        user_id: user.id,
        username: user.username,
        saved_at: new Date().toISOString(),
        cards: rows.map(row => {
          const colors = JSON.parse(row.color_identity || '[]');
          return {
            ...row,
            color_identity: Array.isArray(colors) ? colors : [],
            reserved_quantity: row.list_type === 'collection' ? allocated.get(row.entry_id) || 0 : 0
          };
        })
      };
    });
    if (!snapshot) return res.status(401).json({ error: 'Account no longer exists' });
    res.json(snapshot);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch offline collection snapshot' });
  }
});

// Shared by the single add below and the bulk add after it, so one card and two
// hundred cards travel exactly the same path (cache lookup, compartment
// resolution, rebalance, price history). Throws AddCardError for caller-visible
// failures; anything else is a genuine 500.
class AddCardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function collectionQuantity(value = 1) {
  const quantity = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN;
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new AddCardError(400, 'quantity must be a positive safe integer');
  }
  return quantity;
}

// Mirrors the collection.grader CHECK constraint in db.js. 'Raw' is the default
// and means an ungraded card, not a missing value.
const GRADERS = ['Raw', 'PSA', 'BGS', 'CGC', 'SGC', 'TAG'];

// Draft/product-deck callers already hold a transaction and supply cached metadata.
// Ordinary single/bulk adds resolve provider metadata before taking their own lock.
async function addCardToCollection(user, body, preparedCard = null, inTransaction = false) {
  const {
    card_id,
    quantity = 1,
    condition = 'Near Mint',
    printing = 'Normal',
    language = 'English',
    purchase_price = 0,
    location_id = null,
    list_type = 'collection',
    is_trade = 0,
    game = 'mtg',
    stackable = false,
    grader = 'Raw',
    grade = null,
    cert_number = null
  } = body;
  const req = { user, body };
  const requestedQuantity = collectionQuantity(quantity);

  if (!card_id) {
    throw new AddCardError(400, 'card_id is required');
  }
  if (game !== 'mtg') throw new AddCardError(400, 'Unsupported game');
  if (typeof card_id !== 'string') {
    throw new AddCardError(400, 'Unsupported card ID');
  }
  if (!LIST_TYPES.includes(list_type)) {
    throw new AddCardError(400, 'Invalid list_type');
  }

  // Grading, validated here rather than at the two call sites, so the single add
  // and the bulk add cannot disagree about what a slab is.
  if (!GRADERS.includes(grader)) {
    throw new AddCardError(400, `Invalid grader. One of: ${GRADERS.join(', ')}`);
  }
  const gradeNum = grade == null || grade === '' ? null : Number(grade);
  if (gradeNum != null && !(gradeNum > 0 && gradeNum <= 10)) {
    throw new AddCardError(400, 'grade must be between 0 and 10');
  }
  const cert = cert_number ? String(cert_number).trim() : null;
  // A raw card has no grade and no cert by definition. Silently keeping either
  // would leave a row that reads as raw in one column and graded in another, and
  // every downstream check would then depend on which column it happened to read.
  const isGraded = grader !== 'Raw';
  const certValue = isGraded ? cert : null;
  const gradeValue = isGraded ? gradeNum : null;

  // Checked before the insert purely for the message: the unique index in db.js is
  // what actually enforces this, and still catches a race between two requests.
  // Without the check the user gets 'Failed to add card' and no idea why.
  if (certValue) {
    const dup = await db.get(
      `SELECT c.id, cc.name FROM collection c JOIN card_cache cc ON cc.id = c.card_id
        WHERE c.user_id = ? AND c.grader = ? AND c.cert_number = ?`,
      [user.id, grader, certValue]
    );
    if (dup) {
      throw new AddCardError(409, `${grader} cert ${certValue} is already in your collection as ${dup.name}.`);
    }
  }

  {
    let card = preparedCard || await db.get(`SELECT * FROM card_cache WHERE id = ?`, [card_id]);
    if (!card) {
      if (!card_id.startsWith('mtg-')) throw new AddCardError(400, 'Unsupported card ID');
      card = await cardApi.getCardById(card_id, { game });
      if (!card) throw new AddCardError(404, `Card ID ${card_id} not found.`);
    }
    if (card.game !== 'mtg') throw new AddCardError(400, 'Only Magic: The Gathering cards are supported.');

    let cardId = card_id;
    const localized = preparedCard ? null : await cardApi.printingInLanguage(card, language);
    if (localized) {
      card = localized;
      cardId = localized.id;
    }
    const effectiveGame = 'mtg';
    const insert = async () => {

    if (location_id) {
      const loc = await db.get(`SELECT id FROM locations WHERE id = ? AND user_id = ?`, [location_id, req.user.id]);
      if (!loc) {
        throw new AddCardError(400, 'Invalid location ID');
      }
    }

    // A cert number names ONE physical slab, so a quantity above 1 is not a
    // request for more of them — it is a mistake that the per-user unique index on
    // (grader, cert_number) would reject on the second insert anyway, after the
    // first had already been written. Collapse it here so the request succeeds with
    // the row the user actually meant.
    const count = certValue ? 1 : requestedQuantity;
    const resolved = await resolveCompartmentAndPosition({
      locationId: location_id,
      listType: list_type,
      quantity: count,
      userId: req.user.id,
      cardId,
      printing,
      language
    });

    const targetLocationId = resolved.compartment_id ? (resolved.location_id ?? location_id) : null;

    let lastInsertedId = null;
    // Stacking is quantity-on-one-row, which is meaningful only for interchangeable
    // copies. Two slabs are never interchangeable: they have different certs, and
    // usually different grades.
    const stack = stackable && !isGraded;

    if (stack) {
      const result = await db.run(`
        INSERT INTO collection (
          card_id, user_id, quantity, condition, printing, language, purchase_price,
          location_id, compartment_id, position, is_trade, list_type, game,
          grader, grade, cert_number
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        cardId, req.user.id, count, condition, printing, language, purchase_price || 0,
        targetLocationId, resolved.compartment_id, resolved.position, is_trade ? 1 : 0, list_type, effectiveGame,
        grader, gradeValue, certValue
      ]);
      lastInsertedId = result.lastID;
    } else {
      for (let i = 0; i < count; i++) {
        const result = await db.run(`
          INSERT INTO collection (
            card_id, user_id, quantity, condition, printing, language, purchase_price,
            location_id, compartment_id, position, is_trade, list_type, game,
            grader, grade, cert_number
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          cardId, req.user.id, condition, printing, language, purchase_price || 0,
          targetLocationId, resolved.compartment_id, resolved.position + (i * 0.001), is_trade ? 1 : 0, list_type, effectiveGame,
          grader, gradeValue, certValue
        ]);
        lastInsertedId = result.lastID;
      }
    }

    if (resolved.compartment_id && targetLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [targetLocationId, req.user.id]);
      if (loc) {
        await rebalanceCompartmentByScheme(db, resolved.compartment_id, loc.sort_order, loc.foil_sorting);
      }
    }

    await recordPrice(cardId, card.price_trend);

    return {
      message: 'Card added to collection',
      id: lastInsertedId,
      placement: resolved.compartment_id
        ? await describePlacement(db, lastInsertedId, req.user.id)
        : null,
      rule_rejected: !!resolved.rejected
    };
    };
    return inTransaction ? insert() : db.withTransaction(insert);
  }
}

const SCAN_DRAFT_SELECT = `
  SELECT cc.*, d.id AS draft_id, d.card_id, d.quantity, d.condition, d.printing,
    d.language, d.purchase_price, d.location_id
  FROM scan_drafts d JOIN card_cache cc ON cc.id = d.card_id
  WHERE d.user_id = ?`;

async function getScanDraft(userId, id) {
  const row = await db.get(`${SCAN_DRAFT_SELECT} AND d.id = ?`, [userId, id]);
  if (!row) throw new AddCardError(404, 'Scan draft not found');
  return parseCardRow(row);
}

async function normalizeScanDraft(body, previous = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AddCardError(400, 'Invalid scan draft');
  }
  const draft = {
    card_id: previous.card_id, quantity: 1, condition: 'Near Mint', printing: 'Normal',
    language: 'English', purchase_price: 0, location_id: null, ...previous, ...body
  };
  if (typeof draft.card_id !== 'string' || !cardApi.isMtgId(draft.card_id)) {
    throw new AddCardError(400, 'Unsupported card ID');
  }
  if (!Number.isInteger(draft.quantity) || draft.quantity < 1 || draft.quantity > 250) {
    throw new AddCardError(400, 'quantity must be an integer from 1 to 250');
  }
  if (!['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'].includes(draft.condition)) {
    throw new AddCardError(400, 'Invalid condition');
  }
  if (!['Normal', 'Holofoil'].includes(draft.printing)) {
    throw new AddCardError(400, 'Invalid printing');
  }
  const language = typeof draft.language === 'string' && languages.LANGUAGES.find(l =>
    [l.name.toLowerCase(), l.code, l.scryfall].includes(draft.language.trim().toLowerCase()));
  if (!language) throw new AddCardError(400, 'Invalid language');
  draft.language = language.name;
  if (!Number.isFinite(draft.purchase_price) || draft.purchase_price < 0) {
    throw new AddCardError(400, 'purchase_price must be a nonnegative number');
  }
  if (draft.location_id !== null) {
    if (!['number', 'string'].includes(typeof draft.location_id) ||
        !Number.isSafeInteger(Number(draft.location_id)) || Number(draft.location_id) < 1) {
      throw new AddCardError(400, 'Invalid location ID');
    }
    draft.location_id = Number(draft.location_id);
  }
  // Resolve and cache the reviewed printing before taking a write transaction.
  let card = await db.get('SELECT * FROM card_cache WHERE id = ?', [draft.card_id]);
  if (!card) card = await cardApi.getCardById(draft.card_id, { game: 'mtg' });
  if (!card || card.game !== 'mtg') throw new AddCardError(400, 'Invalid Magic card');
  card = await cardApi.printingInLanguage(card, draft.language) || card;
  draft.card_id = card.id;
  return draft;
}

async function assertScanDraftLocation(draft, userId) {
  if (draft.location_id === null) return;
  const location = await db.get('SELECT inventory_type FROM locations WHERE id = ? AND user_id = ?', [draft.location_id, userId]);
  if (!location) throw new AddCardError(400, 'Invalid location ID');
  assertStorageInventory(location, 'collection');
}

function scanDraftError(res, error) {
  if (error.status === 400 || error.status === 404) return res.status(error.status).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: 'Failed to save scan draft' });
}

router.get('/scan-drafts', async (req, res) => {
  try {
    res.json((await db.all(`${SCAN_DRAFT_SELECT} ORDER BY d.id DESC`, [req.user.id])).map(parseCardRow));
  } catch (error) {
    scanDraftError(res, error);
  }
});

router.post('/scan-drafts', async (req, res) => {
  try {
    const draft = await normalizeScanDraft(req.body);
    const result = await db.withTransaction(async () => {
      await assertScanDraftLocation(draft, req.user.id);
      const inserted = await db.run(`INSERT INTO scan_drafts
        (user_id, card_id, quantity, condition, printing, language, purchase_price, location_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
        req.user.id, draft.card_id, draft.quantity, draft.condition, draft.printing,
        draft.language, draft.purchase_price, draft.location_id
      ]);
      return getScanDraft(req.user.id, inserted.lastID);
    });
    res.json(result);
  } catch (error) {
    scanDraftError(res, error);
  }
});

router.patch('/scan-drafts/:id', async (req, res) => {
  try {
    const previous = await getScanDraft(req.user.id, req.params.id);
    const draft = await normalizeScanDraft(req.body, previous);
    const result = await db.withTransaction(async () => {
      await assertScanDraftLocation(draft, req.user.id);
      const updated = await db.run(`UPDATE scan_drafts SET
        card_id = ?, quantity = ?, condition = ?, printing = ?, language = ?, purchase_price = ?, location_id = ?
        WHERE id = ? AND user_id = ?`, [
        draft.card_id, draft.quantity, draft.condition, draft.printing,
        draft.language, draft.purchase_price, draft.location_id, req.params.id, req.user.id
      ]);
      if (!updated.changes) throw new AddCardError(404, 'Scan draft not found');
      return getScanDraft(req.user.id, req.params.id);
    });
    res.json(result);
  } catch (error) {
    scanDraftError(res, error);
  }
});

function scanDraftIds(body) {
  const ids = body?.draft_ids;
  if (!Array.isArray(ids) || !ids.length ||
      ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) {
    throw new AddCardError(400, 'draft_ids must be a nonempty array of unique positive integer IDs');
  }
  return ids;
}

router.delete('/scan-drafts', async (req, res) => {
  try {
    const ids = scanDraftIds(req.body);
    await db.withTransaction(async () => {
      for (const id of ids) await getScanDraft(req.user.id, id);
      for (const id of ids) {
        await db.run('DELETE FROM scan_drafts WHERE id = ? AND user_id = ?', [id, req.user.id]);
      }
    });
    res.json({ drafts: ids.length });
  } catch (error) {
    scanDraftError(res, error);
  }
});

router.delete('/scan-drafts/:id', async (req, res) => {
  try {
    const deleted = await db.run('DELETE FROM scan_drafts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!deleted.changes) throw new AddCardError(404, 'Scan draft not found');
    res.json({ message: 'Scan draft discarded' });
  } catch (error) {
    scanDraftError(res, error);
  }
});

router.post('/scan-drafts/commit', async (req, res) => {
  try {
    const ids = scanDraftIds(req.body);
    const result = await db.withTransaction(async () => {
      const drafts = [];
      for (const id of ids) drafts.push(await getScanDraft(req.user.id, id));
      let added = 0;
      for (const draft of drafts) {
        // Reviewed printings are cached; committing never needs the provider.
        await addCardToCollection(req.user, draft, draft, true);
        await db.run('DELETE FROM scan_drafts WHERE id = ? AND user_id = ?', [draft.draft_id, req.user.id]);
        added += draft.quantity;
      }
      return { added, drafts: drafts.length };
    });
    res.json(result);
  } catch (error) {
    scanDraftError(res, error);
  }
});

router.post('/cards/related-tokens', async (req, res) => {
  try {
    const inventoryType = req.body?.inventory_type === undefined ? 'collection' : req.body.inventory_type;
    if (!['collection', 'arena', 'graveyard'].includes(inventoryType)) {
      return res.status(400).json({ error: 'inventory_type must be collection, arena or graveyard' });
    }
    const commanderId = req.body?.commander_card_id;
    if (commanderId != null && commanderId !== ''
      && (typeof commanderId !== 'string'
        || !/^mtg-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(commanderId)
        || !Array.isArray(req.body?.card_ids) || !req.body.card_ids.includes(commanderId))) {
      return res.status(400).json({ error: 'commander_card_id must be an mtg-UUID ID included in card_ids' });
    }
    const tokens = await scryfallApi.getRelatedTokens(req.body?.card_ids);
    const byId = new Map(tokens.map(token => [token.id, { ...token, owned: false, locations: [] }]));
    if (tokens.length) {
      const commander = commanderId
        ? await db.get(`SELECT set_id FROM card_cache WHERE id = ? AND game = 'mtg'`, [commanderId])
        : null;
      const commanderSet = commander?.set_id?.toLowerCase();
      const names = [...new Set(tokens.flatMap(token => [token.name, token.name.split(' // ')[0]]))];
      const rows = await db.all(`
        SELECT DISTINCT c.card_id, cc.name, cc.image_url, cc.set_id, l.name AS location_name, l.type AS location_type,
               l.id AS location_id, cp.idx, cp.label, c.position
        FROM collection c
        JOIN card_cache cc ON cc.id = c.card_id AND cc.game = 'mtg'
        LEFT JOIN compartments cp ON cp.id = c.compartment_id
        LEFT JOIN locations l ON l.id = COALESCE(cp.location_id, c.location_id)
          AND l.user_id = c.user_id AND l.inventory_type = 'collection'
        WHERE c.user_id = ? AND c.list_type = ? AND c.quantity > 0
          AND cc.name COLLATE NOCASE IN (${names.map(() => '?').join(',')})
        ORDER BY l.name, cp.idx, c.position, c.card_id
      `, [req.user.id, inventoryType, ...names]);
      for (const token of byId.values()) {
        const matches = rows.filter(row => [token.name.toLowerCase(), token.name.split(' // ')[0].toLowerCase()].includes(row.name.toLowerCase()));
        if (!matches.length) continue;
        const preferred = commanderSet
          ? matches.filter(row => [commanderSet, `t${commanderSet}`].includes(row.set_id?.toLowerCase()))
          : [];
        const pool = preferred.length ? preferred : matches;
        const selected = pool.find(row => row.card_id === token.id) || pool[0];
        token.matched_card_id = selected.card_id;
        token.image_url = selected.image_url;
        token.owned = true;
        for (const row of pool) {
          if (inventoryType === 'collection') {
            token.locations.push({
              location_name: row.location_name,
              compartment_display: row.location_id && row.idx != null
                ? compartmentLabel(row, row.location_type) : null,
              position: row.location_id ? row.position : null,
            });
          }
        }
      }
    }
    res.json({ tokens: [...byId.values()] });
  } catch (error) {
    const status = [400, 404].includes(error.status) ? error.status : 502;
    res.status(status).json({
      error: status === 502 ? 'Unable to load related tokens from Scryfall. Try again later.' : error.message,
    });
  }
});

// 2b. Localize card to a specific language printing
router.get('/cards/:id/printing', async (req, res) => {
  try {
    const cardId = req.params.id;
    const targetLang = req.query.lang;
    const game = req.query.game;
    if (game !== undefined && game !== 'mtg') {
      return res.status(400).json({ error: 'Unsupported game' });
    }
    if (!targetLang) {
      return res.status(400).json({ error: 'lang query parameter is required' });
    }

    let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [cardId]);
    if (!cardApi.isMtgId(cardId) || (card && card.game !== 'mtg')) {
      return res.status(400).json({ error: 'Unsupported card ID or game' });
    }
    if (!card) {
      card = await cardApi.getCardById(cardId, { game });
    }
    if (!card) {
      return res.status(404).json({ error: `Card ID ${cardId} not found.` });
    }

    const localized = await cardApi.printingInLanguage(card, targetLang);
    if (localized) {
      return res.status(200).json(localized);
    }

    if (languages.toCode(card.language) === languages.toCode(targetLang)) return res.json(card);
    res.status(404).json({ error: 'No printing found in the requested language' });
  } catch (error) {
    console.error('Error fetching card localized printing:', error);
    if (error.status) return res.status(error.status).json({ error: error.message });
    res.status(500).json({ error: 'Failed to fetch card printing' });
  }
});

// 3. Add Card to Collection
router.post('/collection', async (req, res) => {
  try {
    res.status(200).json(await addCardToCollection(req.user, req.body));
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to add card' });
  }
});

// 3b. Bulk add: one shared condition/printing/quantity across many cards, so a
// set browse can be added in one action instead of one drawer per card.
const BULK_ADD_MAX = 250;
router.post('/collection/bulk-add', async (req, res) => {
  const { card_ids = [], ...shared } = req.body;
  if (!Array.isArray(card_ids) || card_ids.length === 0) {
    return res.status(400).json({ error: 'card_ids is required' });
  }
  if (card_ids.length > BULK_ADD_MAX) {
    return res.status(400).json({ error: `Cannot add more than ${BULK_ADD_MAX} cards at once.` });
  }
  // Every field in `shared` is applied to every card, which a cert number cannot
  // survive: it identifies one slab. Rejected rather than dropped, because silently
  // discarding it would add the cards ungraded and look like it worked.
  if (shared.cert_number) {
    return res.status(400).json({ error: 'A certification number applies to a single card. Add graded cards one at a time.' });
  }
  let qty;
  try { qty = collectionQuantity(shared.quantity); }
  catch (error) { return res.status(error.status).json({ error: error.message }); }
  // Sequential on purpose: placement resolves against the rows already inserted,
  // so adds must not race each other for the same compartment slot.
  const added = [];
  const failed = [];
  for (const card_id of card_ids) {
    try {
      const result = await addCardToCollection(req.user, { ...shared, card_id });
      added.push({ card_id, id: result.id });
    } catch (error) {
      if (!(error instanceof AddCardError)) console.error(error);
      failed.push({ card_id, error: error instanceof AddCardError ? error.message : 'Failed to add card' });
    }
  }
  res.status(failed.length && !added.length ? 500 : 200).json({
    message: failed.length
      ? `Added ${added.length} of ${card_ids.length} cards; ${failed.length} failed.`
      : `Added ${added.length} card${added.length === 1 ? '' : 's'}${qty > 1 ? ` (x${qty} each)` : ''} to collection.`,
    added: added.length,
    failed
  });
});


function deckDetails(deck) {
  const groups = { creatures: new Map(), spells: new Map(), lands: new Map() };
  for (const section of ['commander', 'mainBoard', 'sideBoard']) {
    for (const card of deck[section] || []) {
      const group = card.types?.includes('Creature') ? groups.creatures
        : card.types?.includes('Land') ? groups.lands : groups.spells;
      const key = `${card.name}|${card.setCode}|${card.number}|${card.isFoil ? 'foil' : 'normal'}`;
      const row = group.get(key) || { name: card.name, setCode: card.setCode, number: card.number, count: 0, type: card.type };
      row.count += Math.max(1, parseInt(card.count, 10) || 1);
      group.set(key, row);
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([name, cards]) => [
    name,
    [...cards.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ]));
}

// Product deck names and files come from MTGJSON, but this proxy keeps their
// large catalog off the browser and lets the server validate the requested file.
router.get('/mtg-decks', searchLimiter, async (req, res) => {
  try {
    res.json(await mtgjsonApi.searchDecks(req.query.q));
  } catch (error) {
    console.error('MTGJSON deck search failed:', error.message);
    res.status(502).json({ error: 'Failed to search MTGJSON decks' });
  }
});

router.get('/mtg-decks/:fileName', searchLimiter, async (req, res) => {
  try {
    const deck = await mtgjsonApi.getDeck(req.params.fileName);
    if (!deck) return res.status(404).json({ error: 'MTGJSON deck not found' });
    res.json({ name: deck.name, ...deckDetails(deck) });
  } catch (error) {
    console.error('MTGJSON deck details failed:', error.message);
    res.status(502).json({ error: 'Failed to load MTGJSON deck details' });
  }
});

router.post('/mtg-decks/:fileName/import', searchLimiter, async (req, res) => {
  if (req.body?.create_deck !== undefined && typeof req.body.create_deck !== 'boolean') {
    return res.status(400).json({ error: 'create_deck must be a boolean' });
  }
  try {
    const deck = await mtgjsonApi.getDeck(req.params.fileName);
    if (!deck) return res.status(404).json({ error: 'MTGJSON deck not found' });

    const rows = mtgjsonApi.deckCardRows(deck);
    if (!rows.length) return res.status(422).json({ error: 'This MTGJSON deck has no importable cards' });
    const total = rows.reduce((sum, row) => sum + row.quantity, 0);
    const { cards, pairs } = await scryfallApi.bulkFetchByIdentifier(rows, undefined, { localFirst: true });
    const missing = total - pairs.reduce((sum, { row }) => sum + row.quantity, 0);
    if (req.body?.create_deck && missing) {
      return res.status(422).json({ error: 'All cards must resolve before creating and checking out a deck.' });
    }
    await scryfallApi.cacheCards(cards);
    // Resolve language printings before acquiring the write transaction.
    for (const pair of pairs) {
      pair.card = await cardApi.printingInLanguage(pair.card, pair.row.language) || pair.card;
    }

    const result = await db.withTransaction(async () => {
    let locationId = null;
    if (req.body?.create_container) {
      const existing = await db.get('SELECT id FROM locations WHERE name = ? AND user_id = ?', [deck.name, req.user.id]);
      if (existing) throw new AddCardError(409, `A storage container named "${deck.name}" already exists`);
      const plan = defaultCompartmentPlan('Deck Box');
      const location = await db.run(`
        INSERT INTO locations (name, type, game, user_id)
        VALUES (?, 'Deck Box', 'mtg', ?)
      `, [deck.name, req.user.id]);
      locationId = location.lastID;
      await db.createCompartments(locationId, plan.count, Math.max(plan.capacity, total));
    }

    let added = 0;
    const failed = [];
    let deckId = null;
    if (req.body?.create_deck) {
      const created = await db.run(
        `INSERT INTO decks (name, game, format, target_size, inventory_type, user_id)
         VALUES (?, 'mtg', ?, ?, 'collection', ?)`,
        [deck.name, deck.commander?.length ? 'Commander / EDH' : 'Standard', total, req.user.id]
      );
      deckId = created.lastID;
    }
    for (const { row, card } of pairs) {
      try {
        const addedCard = await addCardToCollection(req.user, {
          card_id: card.id,
          quantity: row.quantity,
          printing: row.printing,
          language: row.language,
          game: 'mtg',
          location_id: locationId,
        }, card, true);
        if (deckId) {
          const entry = await db.get('SELECT card_id FROM collection WHERE id = ? AND user_id = ?', [addedCard.id, req.user.id]);
          await db.run(
            `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
             ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = quantity + EXCLUDED.quantity`,
            [deckId, entry.card_id, row.quantity]
          );
        }
        added += row.quantity;
      } catch (error) {
        if (deckId || !(error instanceof AddCardError)) throw error;
        failed.push({ name: row.name, error: error.message });
      }
    }

    if (deckId) {
      await reserveDeckSources({ id: deckId, game: 'mtg', checked_out: 0 }, req.user.id);
      await db.run('UPDATE decks SET checked_out = 1, checked_out_at = CURRENT_TIMESTAMP WHERE id = ?', [deckId]);
    }
    return { locationId, deckId, added, failed };
    });
    const { locationId, deckId, added, failed } = result;
    res.status(failed.length && !added ? 500 : 200).json({
      message: `Added ${added} of ${total} cards from ${deck.name}.`,
      location_id: locationId,
      deck_id: deckId,
      added,
      missing,
      failed,
    });
  } catch (error) {
    if (error instanceof AddCardError) return res.status(error.status).json({ error: error.message });
    console.error('MTGJSON deck import failed:', error.message);
    res.status(502).json({ error: 'Failed to import MTGJSON deck' });
  }
});

// 4. Update Collection Entry
router.put('/collection/:id', async (req, res) => {
  const { id } = req.params;
  const {
    quantity, condition, printing, language, purchase_price,
    location_id, compartment_id, list_type, is_trade, favorite, game, notes,
    grader, grade, cert_number, market_value, missing
  } = req.body;

  try {
    const requestedQty = quantity !== undefined ? collectionQuantity(quantity) : null;
    const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (!entry) return res.status(404).json({ error: 'Collection entry not found' });
    if (entry.game !== 'mtg' || (game !== undefined && game !== entry.game)) {
      return res.status(400).json({ error: 'Unsupported game' });
    }
    if (list_type !== undefined && !LIST_TYPES.includes(list_type)) return res.status(400).json({ error: 'Invalid list_type' });
    const nextListType = list_type ?? entry.list_type;
    const listChanged = nextListType !== entry.list_type;
    const isMoving = location_id !== undefined || compartment_id !== undefined || listChanged;
    let finalCompartmentId = listChanged ? null : entry.compartment_id;
    let finalLocationId = listChanged ? null : entry.location_id;
    let finalPosition = listChanged ? 0 : entry.position;
    let resolvedRejected = false;

    if (location_id !== undefined || compartment_id !== undefined) {
      const resolved = await resolveCompartmentAndPosition({
        locationId: location_id === undefined ? (compartment_id ? null : finalLocationId) : location_id,
        compartmentId: compartment_id,
        listType: nextListType,
        userId: req.user.id,
        cardId: entry.card_id,
        quantity: entry.quantity,
        printing: printing ?? entry.printing,
        language: language ?? entry.language,
        excludeEntryId: entry.id
      });
      finalCompartmentId = resolved.compartment_id;
      finalLocationId = resolved.compartment_id ? resolved.location_id : null;
      finalPosition = resolved.position;
      resolvedRejected = !!resolved.rejected;
    }

    const updates = [];
    const params = [];

    // Absolute, not additive: see the reconcile below. Deliberately NOT part of
    // the UPDATE — setStackQuantity owns the quantity column so the two can
    // never disagree about how many copies the row stands for.
    if (condition !== undefined) { updates.push('condition = ?'); params.push(condition); }
    if (printing !== undefined) { updates.push('printing = ?'); params.push(printing); }
    if (language !== undefined) {
      updates.push('language = ?');
      params.push(language);
      if (language !== entry.language) {
        let card = await db.get(`SELECT * FROM card_cache WHERE id = ?`, [entry.card_id]);
        if (card) {
          const localized = await cardApi.printingInLanguage(card, language);
          if (localized && localized.id && localized.id !== entry.card_id) {
            updates.push('card_id = ?');
            params.push(localized.id);
          }
        }
      }
    }
    if (purchase_price !== undefined) { updates.push('purchase_price = ?'); params.push(purchase_price); }
    if (isMoving) {
      updates.push('location_id = ?', 'compartment_id = ?', 'position = ?');
      params.push(finalLocationId, finalCompartmentId, finalPosition);
    }
    if (list_type !== undefined) {
      updates.push('list_type = ?');
      params.push(list_type);
    }
    if (is_trade !== undefined) { updates.push('is_trade = ?'); params.push(is_trade ? 1 : 0); }
    if (favorite !== undefined) { updates.push('favorite = ?'); params.push(favorite ? 1 : 0); }
    if (game !== undefined) { updates.push('game = ?'); params.push(game); }
    if (missing !== undefined) { updates.push('missing = ?'); params.push(missing ? 1 : 0); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    // Grading. The three columns move together on purpose: sending grader:'Raw'
    // must clear the grade and cert in the same statement, or the row keeps a grade
    // it no longer claims to have. Cracking a slab is a real thing people do.
    if (grader !== undefined) {
      if (!GRADERS.includes(grader)) return res.status(400).json({ error: `Invalid grader. One of: ${GRADERS.join(', ')}` });
      const raw = grader === 'Raw';
      const g = raw || grade == null || grade === '' ? null : Number(grade);
      if (g != null && !(g > 0 && g <= 10)) return res.status(400).json({ error: 'grade must be between 0 and 10' });
      const cert = raw || !cert_number ? null : String(cert_number).trim();
      if (cert) {
        const dup = await db.get(
          `SELECT id FROM collection WHERE user_id = ? AND grader = ? AND cert_number = ? AND id != ?`,
          [req.user.id, grader, cert, id]
        );
        if (dup) return res.status(409).json({ error: `${grader} cert ${cert} is already in your collection.` });
      }
      updates.push('grader = ?', 'grade = ?', 'cert_number = ?');
      params.push(grader, g, cert);
    }
    // What this copy is worth, typed by the owner. Empty string and null both mean
    // "drop it and go back to the provider price" — the field is a text input, and
    // clearing it has to be possible or a mistyped 10000 is permanent.
    if (market_value !== undefined) {
      if (market_value === null || market_value === '') {
        updates.push('market_value = ?', 'market_value_source = ?', 'market_value_at = ?');
        params.push(null, null, null);
      } else {
        const value = Number(market_value);
        if (!Number.isFinite(value) || value < 0) {
          return res.status(400).json({ error: 'market_value must be a number of 0 or more' });
        }
        updates.push('market_value = ?', 'market_value_source = ?', "market_value_at = CURRENT_TIMESTAMP");
        params.push(value, 'manual');
      }
    }

    await db.withTransaction(async () => {
    if (updates.length > 0) {
      params.push(id, req.user.id);
      if (list_type === 'graveyard') await assertArchivable(req.user.id, [id]);
      await db.run(`UPDATE collection SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);
    }

    if (isMoving && finalCompartmentId && finalLocationId) {
      const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [finalLocationId, req.user.id]);
      if (loc) await rebalanceCompartmentByScheme(db, finalCompartmentId, loc.sort_order, loc.foil_sorting);
    }
    if (isMoving && entry.compartment_id && entry.compartment_id !== finalCompartmentId) {
      const oldLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [entry.location_id, req.user.id]);
      if (oldLoc) await rebalanceCompartmentByScheme(db, entry.compartment_id, oldLoc.sort_order, oldLoc.foil_sorting);
    }

    // Quantity is absolute — it is how many copies the user says they own, and
    // in the stacked collection view the number in the form is the total across
    // the identical rows, not this row alone. So reconcile the whole stack to
    // it, up or down. It used to only ever insert (quantity - 1) extra rows,
    // which made lowering the number a no-op and made every save duplicate the
    // entry instead of editing it.
    if (requestedQty !== null) {
      const changed = await setStackQuantity(db, req.user.id, id, requestedQty);
      if (changed !== 0) {
        const row = await db.get(`SELECT compartment_id, location_id FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (row && row.compartment_id && row.location_id) {
          const loc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [row.location_id, req.user.id]);
          if (loc) await rebalanceCompartmentByScheme(db, row.compartment_id, loc.sort_order, loc.foil_sorting);
        }
      }
    }
    });

    const finalPlacement = isMoving && finalCompartmentId ? await describePlacement(db, id, req.user.id) : null;
    res.json({ message: 'Collection entry updated successfully', placement: finalPlacement, rule_rejected: resolvedRejected });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});

// 4b. Manual tap-to-place (Custom order)
router.post('/collection/:id/place', async (req, res) => {
  const { id } = req.params;
  const { compartment_id, slot, swap_with } = req.body;
  try {
    const result = await db.withTransaction(async () => {
      const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) throw new AddCardError(404, 'Collection entry not found');

      const comp = await db.get(`
        SELECT c.id, c.capacity, l.id AS loc_id, l.type AS loc_type, l.sort_order, l.allow_stacking, l.inventory_type
        FROM compartments c JOIN locations l ON c.location_id = l.id
        WHERE c.id = ? AND l.user_id = ?`, [compartment_id, req.user.id]);
      if (!comp) throw new AddCardError(400, 'Invalid compartment');
      assertStorageInventory(comp, entry.list_type);
      if (comp.sort_order !== 'custom') throw new AddCardError(400, 'Manual placement is only available in Custom order');

      const isBinder = isBinderType(comp.loc_type);

      if (swap_with) {
        const other = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [swap_with, req.user.id]);
        if (!other) throw new AddCardError(400, 'Swap target not found');
        assertStorageInventory(comp, other.list_type);
        if (other.compartment_id !== Number(compartment_id)) throw new AddCardError(400, 'Swap target must belong to the destination compartment');
        if (entry.location_id) {
          const source = await db.get('SELECT inventory_type FROM locations WHERE id = ? AND user_id = ?', [entry.location_id, req.user.id]);
          if (!source) throw new AddCardError(400, 'Invalid source container');
          assertStorageInventory(source, other.list_type);
        }
        // Identical copies join a stacking pocket rather than trading places.
        if (comp.allow_stacking && stackKey(entry) === stackKey(other)) {
          await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
            [other.compartment_id, other.location_id, other.position, id, req.user.id]);
          return { message: 'Card stacked', placement: await describePlacement(db, id, req.user.id) };
        }
        await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [other.compartment_id, other.location_id, other.position, id, req.user.id]);
        await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [entry.compartment_id, entry.location_id, entry.position, swap_with, req.user.id]);
        return { message: 'Cards swapped', placement: await describePlacement(db, id, req.user.id) };
      }

      if (!Number.isInteger(slot) || slot < 1) throw new AddCardError(400, 'Invalid slot');

      const sourceComp = entry.compartment_id;
      if (isBinder) {
        await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [compartment_id, comp.loc_id, slot * 1000, id, req.user.id]);
      } else {
        await db.run(`UPDATE collection SET compartment_id = ?, location_id = ?, position = ? WHERE id = ? AND user_id = ?`,
          [compartment_id, comp.loc_id, slot * 1000 - 500, id, req.user.id]);
        await rebalanceCompartmentByScheme(db, compartment_id, 'custom');
      }

      if (sourceComp && sourceComp !== compartment_id) {
        const src = await db.get(`SELECT l.type AS loc_type FROM compartments c JOIN locations l ON c.location_id = l.id WHERE c.id = ?`, [sourceComp]);
        if (src && !isBinderType(src.loc_type)) {
          await rebalanceCompartmentByScheme(db, sourceComp, 'custom');
        }
      }

      return { message: 'Card placed', placement: await describePlacement(db, id, req.user.id) };
    });
    res.json(result);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Failed to place card' });
  }
});

// 5. Delete Card from Collection
router.delete('/collection/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.run(`DELETE FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Collection entry not found' });
    }
    res.json({ message: 'Card removed from collection' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to remove card' });
  }
});

// 5b. Bulk actions
const BULK_ACTIONS = ['delete', 'move', 'trade', 'untrade', 'list_type', 'condition', 'printing', 'purchase_split', 'add_to_deck', 'missing'];
// Allowed field values mirror the collection table CHECK constraints in db.js.
const BULK_CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const BULK_PRINTINGS = ['Normal', 'Holofoil'];
router.post('/collection/bulk', async (req, res) => {
  const { entry_ids = [], action, value } = req.body;
  if (!Array.isArray(entry_ids) || entry_ids.length === 0) {
    return res.status(400).json({ error: 'entry_ids is required' });
  }
  if (!BULK_ACTIONS.includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }
  const ids = entry_ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (ids.length === 0) return res.status(400).json({ error: 'No valid entry_ids' });
  const placeholders = ids.map(() => '?').join(',');

  try {
    if (action === 'add_to_deck') {
      const deckId = parseInt(value, 10);
      if (!deckId) return res.status(400).json({ error: 'Invalid deck_id' });
      const deck = await db.get(`SELECT id, inventory_type FROM decks WHERE id = ? AND user_id = ?`, [deckId, req.user.id]);
      if (!deck) return res.status(404).json({ error: 'Deck not found' });

      const rows = await db.all(
        `SELECT card_id, SUM(quantity) as total_qty FROM collection WHERE id IN (${placeholders}) AND user_id = ? AND COALESCE(list_type, 'collection') = ? GROUP BY card_id`,
        [...ids, req.user.id, deck.inventory_type ?? 'collection']
      );

      let added = 0;
      const rejected = [];
      for (const row of rows) {
        const check = await db.withTransaction(async () => {
          const existing = await db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ? AND card_id = ?`, [deckId, row.card_id]);
          const newQty = (existing?.quantity || 0) + row.total_qty;
          const validation = await validateDeckAddition({ deckId, userId: req.user.id, cardId: row.card_id, newQty });
          if (!validation.ok) return validation;
          await db.run(
            `INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)
             ON CONFLICT(deck_id, card_id) DO UPDATE SET quantity = excluded.quantity`,
            [deckId, row.card_id, newQty]
          );
          return validation;
        });
        if (!check.ok) { rejected.push(check.error); continue; }
        added += row.total_qty;
      }
      const msg = rejected.length
        ? (added ? `Added ${added} card(s). ${rejected[0]}` : rejected[0])
        : `Added ${added} card(s) to deck`;
      return res.json({ message: msg, affected: added, rejected: rejected.length });
    }

    if (action === 'delete') {
      const result = await db.run(`DELETE FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      return res.json({ message: `Deleted ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'trade' || action === 'untrade') {
      const result = await db.run(`UPDATE collection SET is_trade = ? WHERE id IN (${placeholders}) AND user_id = ?`, [action === 'trade' ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'missing') {
      const result = await db.run(`UPDATE collection SET missing = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value ? 1 : 0, ...ids, req.user.id]);
      return res.json({ message: `Updated ${result.changes} card(s)`, affected: result.changes });
    }

    if (action === 'list_type') {
      if (!LIST_TYPES.includes(value)) return res.status(400).json({ error: 'Invalid list_type' });
      const result = await db.withTransaction(async () => {
        if (value === 'graveyard') await assertArchivable(req.user.id, ids);
        return db.run(`UPDATE collection SET
          location_id = CASE WHEN COALESCE(list_type, 'collection') = ? THEN location_id ELSE NULL END,
          compartment_id = CASE WHEN COALESCE(list_type, 'collection') = ? THEN compartment_id ELSE NULL END,
          position = CASE WHEN COALESCE(list_type, 'collection') = ? THEN position ELSE 0 END,
          list_type = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, value, value, value, ...ids, req.user.id]);
      });
      return res.json({ message: `Moved ${result.changes} card(s) to ${value}`, affected: result.changes });
    }

    if (action === 'condition' || action === 'printing') {
      const allowed = action === 'condition' ? BULK_CONDITIONS : BULK_PRINTINGS;
      if (!allowed.includes(value)) return res.status(400).json({ error: `Invalid ${action}` });
      // Column name is action, drawn from the BULK_ACTIONS whitelist (not user
      // input), so it is safe to interpolate.
      const result = await db.run(`UPDATE collection SET ${action} = ? WHERE id IN (${placeholders}) AND user_id = ?`, [value, ...ids, req.user.id]);
      return res.json({ message: `Set ${action} on ${result.changes} card(s)`, affected: result.changes });
    }

    // Distribute a total price paid (a pack/deck) across the selected entries,
    // writing each entry's per-card purchase_price. method 'weighted' splits
    // proportional to market value (price_trend); 'equal' splits evenly. Weighted
    // falls back to equal when no selected card has a market price.
    if (action === 'purchase_split') {
      const total = parseFloat(value && value.total);
      const method = value && value.method === 'equal' ? 'equal' : 'weighted';
      if (!Number.isFinite(total) || total < 0 || !Number.isSafeInteger(Math.round(total * 100))) {
        return res.status(400).json({ error: 'total must be a finite non-negative cent amount' });
      }
      const result = await db.withTransaction(async () => {
        const rows = await db.all(
          `SELECT c.id, c.quantity, COALESCE(cc.price_trend, 0) AS price FROM collection c
           LEFT JOIN card_cache cc ON cc.id = c.card_id
           WHERE c.id IN (${placeholders}) AND c.user_id = ? ORDER BY c.id`,
          [...ids, req.user.id]
        );
        if (rows.length === 0) throw new AddCardError(400, 'No valid entries');
        const weighted = method === 'weighted' && rows.some(r => Number.isFinite(r.price) && r.price > 0);
        const weights = rows.map(r => r.quantity * (weighted ? (Number.isFinite(r.price) && r.price > 0 ? r.price : 0) : 1));
        const shares = splitPrice(weights, total, 'weighted');
        // Allocate cents per entry, retaining fractional-cent per-copy costs:
        // rounding each copy would lose money or require splitting reserved rows.
        for (let i = 0; i < rows.length; i++) {
          await db.run(`UPDATE collection SET purchase_price = ? WHERE id = ? AND user_id = ?`,
            [shares[i] / rows[i].quantity, rows[i].id, req.user.id]);
        }
        return { message: `Split $${total.toFixed(2)} across ${rows.reduce((n, r) => n + r.quantity, 0)} card(s) (${weighted ? 'by value' : 'evenly'})`, affected: rows.length };
      });
      return res.json(result);
    }

    const locationId = value ? parseInt(value, 10) : null;
    if (locationId) {
      const loc = await db.get(`SELECT id, inventory_type FROM locations WHERE id = ? AND user_id = ?`, [locationId, req.user.id]);
      if (!loc) return res.status(400).json({ error: 'Invalid location ID' });
      const entries = await db.all(`SELECT list_type FROM collection WHERE id IN (${placeholders}) AND user_id = ?`, [...ids, req.user.id]);
      for (const entry of entries) assertStorageInventory(loc, entry.list_type);
    }
    let moved = 0;
    const touched = new Map();
    for (const id of ids) {
      const entry = await db.get(`SELECT * FROM collection WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      if (!entry) continue;
      if (!locationId) {
        await db.run(`UPDATE collection SET location_id = NULL, compartment_id = NULL, position = 0 WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        moved++;
        continue;
      }
      const resolved = await resolveCompartmentAndPosition({
        locationId, userId: req.user.id, cardId: entry.card_id, printing: entry.printing, language: entry.language,
        listType: entry.list_type, quantity: entry.quantity, excludeEntryId: entry.id
      });
      const finalLoc = resolved.compartment_id ? (resolved.location_id ?? locationId) : null;
      await db.run(`UPDATE collection SET location_id = ?, compartment_id = ?, position = ? WHERE id = ? AND user_id = ?`, [finalLoc, resolved.compartment_id, resolved.position, id, req.user.id]);
      if (resolved.compartment_id) touched.set(resolved.compartment_id, finalLoc);
      moved++;
    }
    for (const [compId, locId] of touched) {
      const rbLoc = await db.get(`SELECT sort_order, foil_sorting FROM locations WHERE id = ? AND user_id = ?`, [locId, req.user.id]);
      if (rbLoc) await rebalanceCompartmentByScheme(db, compId, rbLoc.sort_order, rbLoc.foil_sorting);
    }
    return res.json({ message: `Moved ${moved} card(s)`, affected: moved });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Bulk action failed' });
  }
});

router.normalizeSearchParams = normalizeSearchParams;
router.addCardToCollection = addCardToCollection;
module.exports = router;
