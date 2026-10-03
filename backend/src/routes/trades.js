const express = require('express');
const { createHash } = require('crypto');
const db = require('../db');
const cardApi = require('../utils/cardApi');
const languages = require('../utils/languages');
const { checkedOutAllocation } = require('../utils/collectionHelpers');
const router = express.Router();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const quantity = value => Number.isSafeInteger(value) && value > 0 && value <= 250;
const receiptId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);

async function entries(userId) {
  const reserved = await checkedOutAllocation(userId);
  const rows = await db.all(`SELECT c.*, cc.name, cc.printed_name, cc.set_name, cc.number,
    cc.image_url, cc.price_normal, cc.price_holofoil, cc.price_currency, cc.last_updated,
    l.name AS location_name, cp.label AS compartment_label, cp.idx AS compartment_idx
    FROM collection c JOIN card_cache cc ON cc.id = c.card_id AND cc.game = c.game
    LEFT JOIN locations l ON l.id = c.location_id AND l.user_id = c.user_id
    LEFT JOIN compartments cp ON cp.id = c.compartment_id AND cp.location_id = l.id
    WHERE c.user_id = ? AND c.game = 'mtg' AND c.list_type = 'collection'
      AND COALESCE(c.missing, 0) = 0 AND c.quantity > 0
      AND (c.location_id IS NULL OR (l.id IS NOT NULL AND l.inventory_type = 'collection' AND COALESCE(l.locked, 0) = 0))
      AND (c.compartment_id IS NULL OR (cp.id IS NOT NULL AND COALESCE(cp.locked, 0) = 0))
    ORDER BY cc.name, c.id`, [userId]);
  return rows.filter(row => !reserved.get(row.id)).map(row => ({ ...row, entry_id: row.id,
    snapshot: hash([row.id, row.card_id, row.quantity, row.printing, row.language, row.condition,
      row.location_id, row.compartment_id, row.position, row.grader, row.grade, row.cert_number, row.added_at]) }));
}

function quote(row) {
  const amount = Number(row.printing === 'Holofoil' ? row.price_holofoil : row.price_normal);
  const currency = ['USD', 'EUR'].includes(row.price_currency) ? row.price_currency : null;
  return { ...row, estimate: amount > 0 && Number.isFinite(amount) && currency ? amount : null,
    currency, quoted_at: row.last_updated ?? null };
}

function payload(body) {
  if (!receiptId(body?.trade_id)) fail('Invalid trade ID. Start a new trade.');
  if (!Array.isArray(body.giving) || !body.giving.length || body.giving.length > 100 ||
      !Array.isArray(body.receiving) || !body.receiving.length || body.receiving.length > 100) {
    fail('Choose 1–100 entries on each side.');
  }
  const giving = body.giving.map(row => {
    if (!row || !Number.isSafeInteger(row.entry_id) || row.entry_id < 1 || !quantity(row.quantity)
        || typeof row.snapshot !== 'string' || !/^[a-f0-9]{64}$/.test(row.snapshot)) fail('Invalid giving entry. Refresh available cards.');
    return { entry_id: row.entry_id, quantity: row.quantity, snapshot: row.snapshot };
  });
  if (new Set(giving.map(row => row.entry_id)).size !== giving.length) fail('Choose each giving entry only once.');
  const receiving = body.receiving.map(row => {
    if (!row || !cardApi.isMtgId(row.card_id) || !quantity(row.quantity)
        || !['Normal', 'Holofoil'].includes(row.printing)
        || !['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'].includes(row.condition)
        || !languages.LANGUAGES.some(language => language.name === row.language)) fail('Invalid receiving card details.');
    return { card_id: row.card_id, quantity: row.quantity, printing: row.printing, condition: row.condition, language: row.language };
  });
  return { trade_id: body.trade_id, giving, receiving };
}

async function prepareReceiving(rows) {
  const result = [];
  for (const row of rows) {
    const card = await db.get('SELECT * FROM card_cache WHERE id = ?', [row.card_id])
      || await cardApi.getCardById(row.card_id, { game: 'mtg' });
    if (!card || card.game !== 'mtg' || languages.toName(card.language) !== row.language) {
      fail('Receiving printing or language no longer matches. Search for the exact printing again.');
    }
    result.push(quote({ ...card, ...row }));
  }
  return result;
}

async function validateGiving(userId, rows) {
  const available = new Map((await entries(userId)).map(row => [row.entry_id, row]));
  return rows.map(row => {
    const entry = available.get(row.entry_id);
    if (!entry || entry.snapshot !== row.snapshot || entry.quantity < row.quantity) {
      fail('A giving entry changed or is unavailable. Refresh available cards and review again.', 409);
    }
    return quote({ ...entry, quantity: row.quantity });
  });
}

function sendError(res, error) {
  if (error.status) return res.status(error.status).json({ error: error.message });
  console.error('Trade failed:', error);
  res.status(500).json({ error: 'Trade could not be completed. Retry the same confirmation safely.' });
}
router.get('/entries', async (req, res) => {
  try { res.json(await entries(req.user.id)); } catch (error) { sendError(res, error); }
});
router.post('/review', async (req, res) => {
  try {
    const request = payload(req.body);
    const receiving = await prepareReceiving(request.receiving);
    const giving = await db.withTransaction(() => validateGiving(req.user.id, request.giving));
    res.json({ request, giving, receiving });
  } catch (error) { sendError(res, error); }
});
router.post('/confirm', async (req, res) => {
  try {
    const request = payload(req.body);
    const requestHash = hash(request);
    const previous = await db.get('SELECT * FROM completed_trades WHERE user_id = ? AND trade_id = ?', [req.user.id, request.trade_id]);
    if (previous) {
      if (previous.request_hash !== requestHash) fail('This trade ID has already been used. Start a new trade.', 409);
      return res.json({ trade_id: previous.trade_id, given: previous.given, received: previous.received });
    }
    await prepareReceiving(request.receiving);
    const result = await db.withTransaction(async () => {
      const completed = await db.get('SELECT * FROM completed_trades WHERE user_id = ? AND trade_id = ?', [req.user.id, request.trade_id]);
      if (completed) {
        if (completed.request_hash !== requestHash) fail('This trade ID has already been used. Start a new trade.', 409);
        return { trade_id: completed.trade_id, given: completed.given, received: completed.received };
      }
      await validateGiving(req.user.id, request.giving);
      // Revalidate cached receiving identities inside the same write boundary.
      for (const row of request.receiving) {
        const card = await db.get('SELECT game, language FROM card_cache WHERE id = ?', [row.card_id]);
        if (!card || card.game !== 'mtg' || languages.toName(card.language) !== row.language) fail('Receiving printing changed. Review again.', 409);
      }
      for (const row of request.giving) {
        await db.run('UPDATE collection SET quantity = quantity - ? WHERE id = ? AND user_id = ?', [row.quantity, row.entry_id, req.user.id]);
        await db.run('DELETE FROM collection WHERE id = ? AND user_id = ? AND quantity = 0', [row.entry_id, req.user.id]);
      }
      for (const row of request.receiving) {
        await db.run(`INSERT INTO collection (user_id, card_id, quantity, printing, language, condition,
          list_type, game, purchase_price, location_id, compartment_id) VALUES (?, ?, ?, ?, ?, ?, 'collection', 'mtg', NULL, NULL, NULL)`,
        [req.user.id, row.card_id, row.quantity, row.printing, row.language, row.condition]);
      }
      const given = request.giving.reduce((sum, row) => sum + row.quantity, 0);
      const received = request.receiving.reduce((sum, row) => sum + row.quantity, 0);
      await db.run('INSERT INTO completed_trades (user_id, trade_id, request_hash, given, received) VALUES (?, ?, ?, ?, ?)',
        [req.user.id, request.trade_id, requestHash, given, received]);
      return { trade_id: request.trade_id, given, received };
    });
    res.json(result);
  } catch (error) { sendError(res, error); }
});
module.exports = router;
