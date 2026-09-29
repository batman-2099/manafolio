const fs = require('fs');
const path = require('path');
const db = require('./db');

// Art for cards the upstream APIs have no image for. Two layers, checked in this
// order:
//
//   1. USER_DIR  — art somebody added on THIS instance. Lives beside the database
//                  on the persistent volume, so it survives an image upgrade.
//   2. BUNDLED_DIR — art contributed back and committed to the repo. Ships inside
//                  the image (Dockerfile copies shared/), so every install gets it
//                  with no upload of their own.
//
// User art wins so a local fix is never overwritten by a release, and so somebody
// can replace bundled art they think is wrong without editing the image.
const BUNDLED_DIR = path.join(__dirname, '../../shared/card-art');
const USER_DIR = path.join(path.dirname(db.dbPath), 'card-art');

// The widest the app ever displays a card (the inspector's zoom). Scryfall's own
// `png` size is 745x1040, so this matches the sharpest art the rest of the
// collection has and stops a 12MP phone photo from being stored as-is.
const MAX_WIDTH = 745;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Provider card IDs may mix case and separators, but none of them contain
// a path separator or a dot-segment. Anything else is refused rather than
// escaped: the id becomes a filename, so a permissive rule here is a directory
// traversal.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const isValidId = (id) => typeof id === 'string' && ID_RE.test(id) && !id.includes('..');

const fileFor = (dir, cardId) => path.join(dir, `${cardId}.png`);

// Absolute path of the art to serve for this card, or null when neither layer has
// any. Callers must treat null as "fall back to the card back".
function resolve(cardId) {
  if (!isValidId(cardId)) return null;
  for (const dir of [USER_DIR, BUNDLED_DIR]) {
    const f = fileFor(dir, cardId);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// Which cards have art, so the frontend can decide without probing one URL per
// missing card. Cached because it is read on nearly every page load and both
// directories only change when somebody uploads.
let idCache = null;
function listIds() {
  if (idCache) return idCache;
  const ids = new Set();
  for (const dir of [BUNDLED_DIR, USER_DIR]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; } // absent dir = no art
    for (const n of names) {
      if (n.toLowerCase().endsWith('.png')) ids.add(n.slice(0, -4));
    }
  }
  idCache = [...ids];
  return idCache;
}
const invalidate = () => { idCache = null; };

// Normalize whatever the user picked to a PNG the app can display: strips EXIF
// orientation (`rotate()` with no argument applies it, then drops the tag), caps
// the width, and re-encodes. Re-encoding is the point — it means an upload cannot
// smuggle anything but pixels into a file the server later serves back.
async function save(cardId, buffer) {
  if (!isValidId(cardId)) throw new Error('Invalid card id');
  if (!buffer || !buffer.length) throw new Error('Empty image');
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error('Image too large');

  const sharp = require('sharp');
  const meta = await sharp(buffer).metadata();
  if (!meta.width || !meta.height) throw new Error('Not a readable image');

  const png = await sharp(buffer)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(fileFor(USER_DIR, cardId), png);
  invalidate();
  return { bytes: png.length, width: Math.min(meta.width, MAX_WIDTH) };
}

// Removes only this instance's copy. Bundled art is part of the image and is left
// alone — deleting it would be undone by the next release anyway.
function remove(cardId) {
  if (!isValidId(cardId)) return false;
  const f = fileFor(USER_DIR, cardId);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  invalidate();
  return true;
}

// True when the art being served came from this instance rather than the repo,
// which is what decides whether the UI offers "remove" and "contribute".
const isUserArt = (cardId) => isValidId(cardId) && fs.existsSync(fileFor(USER_DIR, cardId));

module.exports = {
  BUNDLED_DIR, USER_DIR, MAX_WIDTH, MAX_UPLOAD_BYTES,
  isValidId, resolve, listIds, invalidate, save, remove, isUserArt,
};
