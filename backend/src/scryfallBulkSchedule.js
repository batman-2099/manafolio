const db = require('./db');
const bulk = require('./scryfallBulk');

let timer;

function nextRunAt(time, now = Date.now()) {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(hours, minutes, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

function refresh() {
  return bulk.refresh()
    .then(status => console.log(`Scryfall bulk catalog ${status.updated ? 'updated' : 'unchanged'}: ${status.count} cards (${status.updated_at}).`))
    .catch(err => console.error('Scryfall bulk refresh failed; imports retain API fallback:', err.message));
}

function reschedule(time) {
  clearTimeout(timer);
  const now = Date.now();
  timer = setTimeout(() => {
    // Arm tomorrow before downloading: errors never cause a retry loop, and a
    // settings edit during the download cannot be overwritten when it finishes.
    reschedule(time);
    refresh();
  }, nextRunAt(time, now) - now);
  timer.unref();
}

async function start() {
  const row = await db.get('SELECT scryfall_bulk_download_time FROM app_settings WHERE id = 1');
  reschedule(row?.scryfall_bulk_download_time || '10:00');
  // Restarting skips missed occurrences; only a missing/corrupt catalog warms up.
  if (!await bulk.storedMetadata()) await refresh();
}

module.exports = { start, reschedule, nextRunAt };
