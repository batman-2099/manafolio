const axios = require('axios');
const sqlite3 = require('sqlite3');
const fs = require('fs/promises');
const path = require('path');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { TextDecoder } = require('util');
const languages = require('./utils/languages');

// Separate, rebuildable storage: importing a catalog never writes the user DB.
const catalogPath = `${process.env.DB_PATH || path.join(__dirname, '../database/manafolio.db')}.scryfall-bulk.sqlite`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE = 4 * 1024 * 1024;
const client = axios.create({
  baseURL: 'https://api.scryfall.com',
  timeout: 30000,
  maxRedirects: 0,
  maxContentLength: 1024 * 1024,
  headers: { 'User-Agent': 'Manafolio/1.0', Accept: 'application/json' }
});
let refreshing = null;

function open(filename, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, mode, error => error ? reject(error) : resolve(db));
  });
}

// sqlite3's callback APIs all report errors first; get additionally returns a row.
function sql(db, method, ...args) {
  return new Promise((resolve, reject) => {
    db[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
}

function prepare(db, query) {
  return new Promise((resolve, reject) => {
    const statement = db.prepare(query, error => error ? reject(error) : resolve(statement));
  });
}

async function metadata(db) {
  const info = await sql(db, 'get', 'SELECT updated_at, card_count FROM metadata WHERE id = 1');
  if (!info || !Number.isFinite(Date.parse(info.updated_at)) || !(info.card_count > 0)) {
    throw new Error('Scryfall bulk catalog has no completed metadata');
  }
  const first = await sql(db, 'get', `SELECT c.raw FROM cards c JOIN names n ON n.card_id = c.id LIMIT 1`);
  if (!first) throw new Error('Scryfall bulk catalog is empty');
  validateCard(JSON.parse(first.raw));
  return info;
}

async function storedMetadata() {
  let db;
  try {
    await fs.access(catalogPath);
    db = await open(catalogPath, sqlite3.OPEN_READONLY);
    return await metadata(db);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Scryfall bulk catalog unavailable: ${error.message}`);
    return null;
  } finally {
    if (db) await sql(db, 'close');
  }
}

function validateCard(raw) {
  if (!raw || raw.object !== 'card' || !UUID.test(raw.id)
    || !['name', 'set', 'collector_number', 'lang'].every(key => typeof raw[key] === 'string' && raw[key])
    || (raw.card_faces != null && (!Array.isArray(raw.card_faces)
      || raw.card_faces.some(face => !face || typeof face.name !== 'string' || !face.name)))) {
    throw new Error('Invalid card in Scryfall bulk catalog');
  }
}

async function buildCatalog(filename, info) {
  const db = await open(filename, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  let cardInsert;
  let nameInsert;
  let count = 0;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  deadline.unref();
  try {
    await sql(db, 'exec', `
      PRAGMA journal_mode = DELETE;
      PRAGMA temp_store = FILE;
      CREATE TABLE cards (id TEXT PRIMARY KEY, set_code TEXT NOT NULL,
        collector_number TEXT NOT NULL, lang TEXT NOT NULL, raw TEXT NOT NULL);
      CREATE TABLE names (name TEXT NOT NULL, card_id TEXT NOT NULL,
        PRIMARY KEY (name, card_id)) WITHOUT ROWID;
      CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL, card_count INTEGER NOT NULL CHECK (card_count > 0));
      BEGIN;
    `);
    cardInsert = await prepare(db, 'INSERT INTO cards VALUES (?, ?, ?, ?, ?)');
    nameInsert = await prepare(db, 'INSERT INTO names VALUES (?, ?)');
    const insert = async line => {
      if (!line.trim()) return;
      if (line.length > MAX_LINE) throw new Error('Scryfall bulk card exceeds line size limit');
      const raw = JSON.parse(line);
      validateCard(raw);
      await sql(cardInsert, 'run', [raw.id.toLowerCase(), raw.set.toLowerCase(),
        raw.collector_number.toLowerCase(), raw.lang.toLowerCase(), line]);
      const names = [raw.name, ...(raw.card_faces || []).map(face => face.name)];
      for (const name of new Set(names.map(value => value.toLowerCase()))) {
        await sql(nameInsert, 'run', [name, raw.id.toLowerCase()]);
      }
      count++;
    };

    const response = await client.get(info.jsonl_download_uri, {
      responseType: 'stream', decompress: false, signal: controller.signal,
      maxContentLength: info.compressed_size,
      headers: { Accept: 'application/gzip', 'Accept-Encoding': 'identity' }
    });
    let compressedBytes = 0;
    const meter = new Transform({
      transform(chunk, encoding, callback) {
        compressedBytes += chunk.length;
        callback(compressedBytes > info.compressed_size
          ? new Error('Scryfall bulk download exceeds metadata size') : null, chunk);
      }
    });
    // Await the whole pipeline: a valid last JSON row is NOT proof that the gzip
    // trailer arrived. Gunzip verifies the checksum and rejects truncated streams.
    await pipeline(response.data, meter, createGunzip(), async source => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let pending = '';
      for await (const chunk of source) {
        pending += decoder.decode(chunk, { stream: true });
        let newline;
        let start = 0;
        while ((newline = pending.indexOf('\n', start)) !== -1) {
          await insert(pending.slice(start, newline));
          start = newline + 1;
        }
        pending = pending.slice(start);
        if (pending.length > MAX_LINE) throw new Error('Scryfall bulk card exceeds line size limit');
      }
      pending += decoder.decode();
      if (pending) await insert(pending);
    }, { signal: controller.signal });
    if (compressedBytes !== info.compressed_size) throw new Error('Incomplete Scryfall bulk download');
    if (!count) throw new Error('Scryfall bulk download contained no cards');
    await sql(db, 'run', 'INSERT INTO metadata VALUES (1, ?, ?)', [info.updated_at, count]);
    await sql(db, 'exec', `
      CREATE INDEX cards_printing ON cards (set_code, collector_number, lang);
      COMMIT;
    `);
    const check = await sql(db, 'get', 'PRAGMA quick_check');
    if (check.quick_check !== 'ok') throw new Error('Scryfall bulk catalog integrity check failed');
    await metadata(db);
    return count;
  } finally {
    clearTimeout(deadline);
    // Finalize even when parsing/network/SQLite fails; closing rolls back the
    // unfinished temporary transaction, without touching the published catalog.
    try {
      if (cardInsert) await sql(cardInsert, 'finalize');
    } finally {
      try {
        if (nameInsert) await sql(nameInsert, 'finalize');
      } finally {
        await sql(db, 'close');
      }
    }
  }
}

async function refreshCatalog(force) {
  const response = await client.get('/bulk-data/default_cards', { signal: AbortSignal.timeout(30000) });
  const info = response.data;
  if (!info || info.object !== 'bulk_data' || info.type !== 'default_cards'
    || typeof info.updated_at !== 'string' || !Number.isFinite(Date.parse(info.updated_at))
    || !Number.isSafeInteger(info.compressed_size) || info.compressed_size <= 0
    || typeof info.jsonl_download_uri !== 'string') {
    throw new Error('Invalid Scryfall default_cards metadata');
  }
  const url = new URL(info.jsonl_download_uri);
  if (url.protocol !== 'https:' || url.hostname !== 'data.scryfall.io'
    || url.port || url.username || url.password || url.hash
    || !/^\/default-cards\/[^/]+\.jsonl\.gz$/.test(url.pathname)) {
    throw new Error('Untrusted Scryfall bulk download URL');
  }
  const previous = await storedMetadata();
  if (!force && previous && Date.parse(previous.updated_at) >= Date.parse(info.updated_at)) {
    return { updated: false, updated_at: previous.updated_at, count: previous.card_count };
  }
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  const tempDir = await fs.mkdtemp(`${catalogPath}.tmp-`);
  try {
    const filename = path.join(tempDir, 'catalog.sqlite');
    const count = await buildCatalog(filename, info);
    // Closed, committed and validated first; rename replaces atomically on the
    // same filesystem. Any download/build/rename failure leaves the old file.
    await fs.rename(filename, catalogPath);
    return { updated: true, updated_at: info.updated_at, count };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(error => {
      console.warn(`Could not remove Scryfall bulk temporary catalog: ${error.message}`);
    });
  }
}

function refresh({ force = false } = {}) {
  if (refreshing) {
    // A forced caller may join a download, but not an unchanged metadata check.
    return force ? refreshing.then(status => status.updated ? status : refresh({ force: true })) : refreshing;
  }
  refreshing = refreshCatalog(force).finally(() => { refreshing = null; });
  return refreshing;
}

async function resolveRows(rows) {
  if (!rows.length) return { pairs: [], unmatchedRows: [] };
  let db;
  try {
    // Each import owns its read-only connection. An atomic replacement cannot
    // close a reader underneath an import, and the next import opens the new file.
    db = await open(catalogPath, sqlite3.OPEN_READONLY);
    await metadata(db);
    const pairs = [];
    const unmatchedRows = [];
    for (const row of rows) {
      const id = String(row.id || row.card_id || '').replace(/^mtg-/, '').toLowerCase();
      let result;
      if (UUID.test(id)) {
        // default_cards omits most foreign UUIDs: never substitute an English
        // printing for an absent UUID, even when the set and number match.
        result = await sql(db, 'get', 'SELECT raw FROM cards WHERE id = ?', [id]);
      } else {
        const set = String(row.set_id || '').toLowerCase();
        const number = row.number == null ? '' : String(row.number).toLowerCase();
        const name = String(row.name || '').toLowerCase();
        const lang = row.language || row.lang;
        const conditions = [];
        const params = [];
        if (set) { conditions.push('c.set_code = ?'); params.push(set); }
        if (set && number) { conditions.push('c.collector_number = ?'); params.push(number); }
        else if (name) {
          conditions.push('c.id IN (SELECT card_id FROM names WHERE name = ?)');
          params.push(name);
        } else { unmatchedRows.push(row); continue; }
        if (lang) { conditions.push('c.lang = ?'); params.push(languages.resolve(lang).scryfall); }
        const candidates = await sql(db, 'all', `SELECT c.raw, c.lang FROM cards c
          WHERE ${conditions.join(' AND ')} ORDER BY (c.lang = 'en') DESC, c.id LIMIT 2`, params);
        // Prefer English to a foreign-only variant. Multiple equally suitable
        // printings stay API fallbacks rather than guessing a set/treatment.
        if (candidates.length === 1 || (candidates[0]?.lang === 'en' && candidates[1]?.lang !== 'en')) {
          result = candidates[0];
        }
      }
      if (result) {
        const raw = JSON.parse(result.raw);
        validateCard(raw);
        pairs.push({ row, raw });
      } else unmatchedRows.push(row);
    }
    return { pairs, unmatchedRows };
  } catch (error) {
    console.warn(`Scryfall bulk lookup unavailable; falling back to API: ${error.message}`);
    return { pairs: [], unmatchedRows: rows };
  } finally {
    if (db) await sql(db, 'close');
  }
}

// Match the API modules' client export convention for deterministic HTTP fixtures.
module.exports = { refresh, resolveRows, storedMetadata, client };
