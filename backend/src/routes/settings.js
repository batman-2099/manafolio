const express = require('express');
const axios = require('axios');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const scryfallBulk = require('../scryfallBulk');
const scryfallBulkSchedule = require('../scryfallBulkSchedule');

const router = express.Router();

// --- Version + update check ---

// Report the installed backend package's version.
const APP_VERSION = require('../../package.json').version;
const RELEASES_API = 'https://api.github.com/repositories/1389194597/releases/latest';
// GitHub allows 60 unauthenticated calls/hour per IP, shared by every user of
// this instance. Cache hard: a new release is not urgent to the minute.
const UPDATE_CACHE_MS = 1000 * 60 * 60 * 6;
let updateCache = { at: 0, data: null };

// "1.4.9" < "1.4.10" — string compare gets this wrong, so compare numerically
// part by part. Anything non-numeric (a "-beta" suffix) is ignored.
function isNewer(candidate, current) {
  const parts = v => String(v).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

async function checkForUpdate() {
  if (updateCache.data && Date.now() - updateCache.at < UPDATE_CACHE_MS) return updateCache.data;
  const resp = await axios.get(RELEASES_API, {
    timeout: 8000,
    headers: { 'User-Agent': 'Manafolio', Accept: 'application/vnd.github+json' }
  });
  const latest = String(resp.data.tag_name || '').replace(/^v/i, '');
  const data = {
    latest,
    update_available: !!latest && isNewer(latest, APP_VERSION),
    release_url: resp.data.html_url || null,
    releases_url: resp.data.html_url?.replace(/\/tag\/[^/]+$/, '') || null,
    published_at: resp.data.published_at || null
  };
  updateCache = { at: Date.now(), data };
  return data;
}

// Current version always answers offline; the update check is best-effort and
// reports its own failure rather than pretending the app is up to date.
router.get('/version', async (req, res) => {
  const base = { version: APP_VERSION };
  if (req.query.check !== '1') return res.json(base);
  try {
    res.json({ ...base, ...(await checkForUpdate()) });
  } catch (error) {
    console.warn('Update check failed:', error.message);
    res.json({ ...base, check_failed: true });
  }
});

async function getEffectiveSettings() {
  const row = await db.get(`
    SELECT public_base_url, price_refresh_days, scryfall_bulk_download_time,
           scan_exclude_tokens, scan_exclude_art_cards, scan_exclude_jumpstart, scan_exclude_promos,
           setup_complete
    FROM app_settings WHERE id = 1
  `);
  const public_base_url = (row && row.public_base_url) || process.env.PUBLIC_BASE_URL || '';
  const scan_exclude_tokens = !!(row && row.scan_exclude_tokens);
  const scan_exclude_art_cards = !!(row && row.scan_exclude_art_cards);
  const scan_exclude_jumpstart = !!(row && row.scan_exclude_jumpstart);
  const scan_exclude_promos = !!(row && row.scan_exclude_promos);
  const setup_complete = !!(row && row.setup_complete);
  // Daily unless an admin says otherwise, matching what every install did before
  // the column existed. 0 means automatic refreshes are off.
  const n = Number(row && row.price_refresh_days);
  const price_refresh_days = Number.isInteger(n) && n >= 0 ? n : 1;
  return {
    public_base_url,
    price_refresh_days,
    scryfall_bulk_download_time: row?.scryfall_bulk_download_time || '10:00',
    scan_exclude_tokens,
    scan_exclude_art_cards,
    scan_exclude_jumpstart,
    scan_exclude_promos,
    setup_complete,
  };
}

// Any logged-in user can read effective settings (needed to render share links)
router.get('/', async (req, res) => {
  try {
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to retrieve settings' });
  }
});

// Only admins can override settings
router.put('/', requireAdmin, async (req, res) => {
  const {
    public_base_url,
    price_refresh_days,
    scryfall_bulk_download_time,
    scan_exclude_tokens,
    scan_exclude_art_cards,
    scan_exclude_jumpstart,
    scan_exclude_promos,
    setup_complete,
  } = req.body;

  if (scryfall_bulk_download_time !== undefined &&
      (typeof scryfall_bulk_download_time !== 'string' || scryfall_bulk_download_time.length !== 5 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(scryfall_bulk_download_time))) {
    return res.status(400).json({ error: 'Scryfall bulk download time must be HH:mm in UTC (00:00–23:59).' });
  }

  if (price_refresh_days !== undefined) {
    // Rejected rather than clamped: a typo that silently becomes 365 is a
    // collection whose prices quietly stop moving, which looks like the app
    // being broken and not like a setting being wrong.
    const n = Number(price_refresh_days);
    if (!Number.isInteger(n) || n < 0 || n > 30) {
      return res.status(400).json({ error: 'Price refresh interval must be a whole number of days from 0 (off) to 30.' });
    }
    await db.run(`UPDATE app_settings SET price_refresh_days = ? WHERE id = 1`, [n]);
  }
  if (scan_exclude_tokens !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_tokens = ? WHERE id = 1`, [scan_exclude_tokens ? 1 : 0]);
  }
  if (scan_exclude_art_cards !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_art_cards = ? WHERE id = 1`, [scan_exclude_art_cards ? 1 : 0]);
  }
  if (scan_exclude_jumpstart !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_jumpstart = ? WHERE id = 1`, [scan_exclude_jumpstart ? 1 : 0]);
  }
  if (scan_exclude_promos !== undefined) {
    await db.run(`UPDATE app_settings SET scan_exclude_promos = ? WHERE id = 1`, [scan_exclude_promos ? 1 : 0]);
  }

  if (setup_complete !== undefined) {
    await db.run(`UPDATE app_settings SET setup_complete = ? WHERE id = 1`, [setup_complete ? 1 : 0]);
  }

  if (public_base_url !== undefined) {
    const trimmed = public_base_url.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      return res.status(400).json({ error: 'Public base URL must start with http:// or https://' });
    }
    const cleaned = trimmed.replace(/\/+$/, '');
    await db.run(`UPDATE app_settings SET public_base_url = ? WHERE id = 1`, [cleaned]);
  }

  try {
    if (scryfall_bulk_download_time !== undefined) {
      await db.run('UPDATE app_settings SET scryfall_bulk_download_time = ? WHERE id = 1', [scryfall_bulk_download_time]);
      scryfallBulkSchedule.reschedule(scryfall_bulk_download_time);
    }
    res.json(await getEffectiveSettings());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

router.post('/scryfall-bulk/download', requireAdmin, async (req, res) => {
  try {
    res.json(await scryfallBulk.refresh({ force: true }));
  } catch (error) {
    console.error('Scryfall bulk download failed:', error.message);
    res.status(502).json({ error: 'Scryfall bulk download failed. The previous catalog has been kept; try again later.' });
  }
});

module.exports = router;
// Exported for tests.
module.exports.isNewer = isNewer;
