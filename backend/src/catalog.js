// Catalog builds: the one job that makes scanning work.
//
// A catalog is one (game, language) pair. Building it has two phases, and the
// first is the one that was missing for years:
//
//   1. CACHE — walk every set the provider lists and pull its cards into
//      card_cache so every available printing can be scanned.
//   2. EMBED — run every cached card's artwork through milo and write the
//      embedding table the scanner searches.
//
// Phase 2 can only ever be as complete as phase 1, which is why they are one job
// rather than two buttons. Both resume: phase 1 is idempotent, and phase 2 keeps
// every embedding whose image_url has not changed.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const db = require('./db');
const cardSets = require('./cardSets');
const languages = require('./utils/languages');
const cvScan = require('./cvScan');
const { binaryPath, readCatalog, publishCatalog } = require('./utils/localCatalog');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
const SIZE = 448;
const GAMES = ['mtg'];

const suffix = (lang) => (!lang || lang === 'en' || lang === 'English' ? '' : `-${String(lang).toLowerCase()}`);
const binPath = (game, lang) => {
  if (game !== 'mtg') throw new Error('Unsupported game');
  const file = metaPath(game, lang);
  try {
    return binaryPath(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return file.replace(/\.json$/, '.bin');
  }
};
const metaPath = (game, lang) => {
  if (game !== 'mtg') throw new Error('Unsupported game');
  return path.join(MODEL_DIR, `milo-mtg${suffix(lang)}-local.json`);
};

// One build at a time. Two concurrent builds would fight over the same provider
// rate limits and the same single-threaded ONNX session, and finish later than
// running them in sequence.
let current = null;

const state = () => (current ? {
  game: current.game, lang: current.lang, phase: current.phase,
  done: current.done, total: current.total, message: current.message,
  // So the panel can say WHICH sets are building rather than implying the whole game.
  sets: current.sets,
  startedAt: current.startedAt, cancelled: current.cancelled,
} : null);

function stop() {
  if (!current) return false;
  current.cancelled = true;
  current.message = 'stopping…';
  return true;
}

// What exists, and how complete it is. The counts come from card_cache and the
// set catalogue, so the UI can say "9,604 of 20,460 cards" rather than only
// "built" — a catalog can be perfectly built and still cover a third of the game.

// How many sets exist that this install has no cards for at all — a newly released
// set, in other words. The weekly refresh keeps the set list current (server.js
// calls fetchAndCacheSets with force), so a release surfaces here on its own.
//
// The `sets` table stores ids prefixed ("mtg-fdn") while card_cache stores the
// bare Scryfall code ("fdn"). Comparing them raw reports every set as new.
async function newSetCount(game, lang = 'English') {
  if (game !== 'mtg') throw new Error('Unsupported game');
  try {
    // Do not repeatedly rebuild sets the provider cannot serve.
    const gaps = new Set((await db.all(
      `SELECT set_id FROM set_data_gaps WHERE game = ? AND language = ?`, [game, lang]
    ).catch(() => [])).map(r => String(r.set_id).toLowerCase()));

    // Scoped to the language, or a Spanish catalog would be measured against the
    // ENGLISH cache and report whatever English happens to be missing: measured
    // 98 for both mtg/English and mtg/Spanish while the Spanish cache held 1,205
    // cards against English's 103,656.
    //
    // Compare in JS because the id namespaces differ: check both prefixed and
    // bare forms with case-insensitive matching. Neither side can
    // use idx_card_cache_set_num, so as a correlated NOT EXISTS this re-scanned the
    // WHOLE of card_cache once per set. Measured against 1,047 MTG sets and 126k
    // cached rows: 9.6s with 50 sets uncached, 28s with 400 — on the single sqlite3
    // connection, so every other request in the app queues behind it. That is why
    // one Admin page load 504'd and took Users and the dashboard down with it (#49).
    // It only ever ran once an MTG catalog was built, because list() asks for
    // newSets only when `built` — which is why deleting the milo-mtg-local files
    // "fixed" it. One pass over each table instead: same answer, ~80ms.
    const cached = new Set((await db.all(
      `SELECT DISTINCT LOWER(set_id) sid FROM card_cache WHERE game = ? AND language = ?`,
      [game, lang]
    )).map(r => r.sid));
    const rows = await db.all(
      `SELECT id FROM sets WHERE game = ? AND COALESCE(total, 0) > 0`, [game]
    );
    // The `sets` table prefixes ids ("mtg-fdn") while card_cache
    // holds the bare code ("fdn"). Both forms are checked, which is what the OR in
    // the old query did — dropping either one reports every set as new.
    const bare = (id) => String(id).toLowerCase().replace(/^mtg-/, '');
    return rows.filter(r =>
      !gaps.has(bare(r.id))
      && !cached.has(String(r.id).toLowerCase())
      && !cached.has(bare(r.id))).length;
  } catch {
    return null;
  }
}

async function list() {
  const out = [];
  for (const game of GAMES) {
    const langs = await db.all(
      `SELECT language, COUNT(*) cached,
              SUM(CASE WHEN image_url IS NOT NULL AND image_url != '' THEN 1 ELSE 0 END) withArt
         FROM card_cache WHERE game = ? GROUP BY language`,
      [game]
    );
    // Always offer English even with an empty cache — that is exactly the state a
    // fresh install is in, and it is the case the build button exists for.
    if (!langs.some(l => l.language === 'English')) langs.unshift({ language: 'English', cached: 0, withArt: 0 });
    const claimed = await db.get(`SELECT SUM(total) t FROM sets WHERE game = ?`, [game]);
    for (const l of langs) {
      const lang = l.language || 'English';
      let built = null;
      try {
        if (fs.existsSync(metaPath(game, lang))) {
          const meta = JSON.parse(fs.readFileSync(metaPath(game, lang), 'utf8'));
          built = {
            rows: meta.ids.length,
            builtAt: meta.builtAt,
            bytes: fs.statSync(binaryPath(metaPath(game, lang), meta)).size,
          };
        }
      } catch { built = null; }
      out.push({
        game, lang,
        cached: l.cached, withArt: l.withArt,
        claimed: lang === 'English' ? (claimed?.t || 0) : null,
        built,
        // Sets that exist and have NOTHING cached — which is what a newly released
        // set looks like. The panel's other warning compares cached against
        // embedded, so it stays silent for exactly this case: a new set is not in
        // card_cache at all yet, and until someone rebuilds, scanning one of its
        // cards returns the nearest wrong card at a confident-looking score.
        //
        // Only for a catalog that EXISTS: a language with nothing built has nothing
        // to have fallen behind, and asking anyway cost a provider round-trip per
        // language on a list() the panel polls every second during a build — which
        // made this function take longer than its own 120s test harness allowed.
        newSets: built ? await newSetCount(game, lang) : null,
        // The published fallback still answers when nothing local is built.
        published: !built && cvScan.isBuilt(game, lang),
      });
    }
  }
  return out;
}


// Per-set counts for one (game, language): how many cards are cached, and how many
// of those are actually IN the catalog the scanner searches.
//
//   · A set can be cached but not embedded (a build stopped, or a set released
//     since), and scanning it returns the nearest wrong card rather than nothing.
//
// Keyed by lowercased set_id, which is what the scan filter matches on.
async function setCounts(game, lang = 'English') {
  if (game !== 'mtg') throw new Error('Unsupported game');
  const rows = await db.all(
    `SELECT id, LOWER(set_id) sid FROM card_cache
      WHERE game = ? AND language = ? AND set_id IS NOT NULL AND set_id != ''
        AND image_url IS NOT NULL AND image_url != ''`,
    [game, lang]
  );
  let embedded = null;
  try {
    if (fs.existsSync(metaPath(game, lang))) {
      embedded = new Set(JSON.parse(fs.readFileSync(metaPath(game, lang), 'utf8')).ids);
    }
  } catch { embedded = null; }

  const sets = {};
  for (const r of rows) {
    const sid = r.sid;
    const bare = sid.replace(/^mtg-/, '');
    const e = sets[sid] || (sets[sid] = { cached: 0, embedded: 0 });
    e.cached++;
    if (embedded && embedded.has(r.id)) e.embedded++;
    if (bare !== sid) {
      const eBare = sets[bare] || (sets[bare] = { cached: 0, embedded: 0 });
      eBare.cached++;
      if (embedded && embedded.has(r.id)) eBare.embedded++;
    }
  }
  return {
    game, lang, sets,
    // Whether `embedded` means anything. A published .npz catalog is keyed by
    // provider ids rather than card_cache ids, so it cannot be counted per set —
    // say so instead of reporting zeros that read as "nothing is built".
    local: !!embedded,
    published: !embedded && cvScan.isBuilt(game, lang),
  };
}

// --- phase 1 -----------------------------------------------------------------
async function cachePhase(job) {
  // A scoped build walks only the sets asked for. Everything else about the job is
  // identical — same fetch, same cache writes — so "the sets in front of me" and
  // "the whole game" are one code path with a different list, not two builders.
  const sets = job.sets && job.sets.length
    ? job.sets
    : await cardSets.listAllSets(job.game, job.lang);
  job.phase = 'cache';
  job.total = sets.length;
  job.done = 0;
  let cards = 0, failed = 0, gaps = 0;
  for (const set of sets) {
    if (job.cancelled) return { cards, failed, gaps, stopped: true };
    job.message = `${set}`;
    try {
      const got = await cardSets.cacheSetCards(job.game, set, job.lang);
      cards += got.length;
      // Data appeared for a set previously recorded as empty: forget the gap so it
      // counts as a normal set again.
      await db.run(`DELETE FROM set_data_gaps WHERE game = ? AND language = ? AND set_id = ?`,
        [job.game, job.lang, String(set).toLowerCase()]).catch(() => {});
    } catch (e) {
      // A set with no cards in this language is an expected gap, not a failure —
      // provider coverage is patchy per language and treating gaps as errors
      // would abort every non-English build partway through.
      if (!e.absent) failed++;
      else {
        gaps++;
        // Remember it, so the panel stops telling the user to build a set the
        // provider cannot serve and the auto-update stops chasing it.
        await db.run(
          `INSERT OR REPLACE INTO set_data_gaps (game, language, set_id, reason) VALUES (?, ?, ?, ?)`,
          [job.game, job.lang, String(set).toLowerCase(), e.message.slice(0, 200)]
        ).catch(() => {});
      }
    }
    job.done++;
  }
  return { cards, failed, gaps, stopped: false };
}

// Which of the previous catalog's cards a SCOPED build must carry forward: every
// one it did not just re-embed.
//
// This is what makes per-set builds additive. embedPhase writes exactly the rows
// it embedded, so without this, building Bloomburrow would delete the Foundations
// vectors built last week — the catalog is one file per (game, language), not one
// per set.
//
// Deliberately NOT applied to an unscoped build: that walks every row for the
// language, so a card in `prev` and absent from `embeddedIds` is one that left
// card_cache. Keeping it would leave a vector that can win a scan and then resolve
// to no card at all.
function keptFromPrev(prev, embeddedIds) {
  const embedded = new Set(embeddedIds);
  const out = [];
  for (const [id, vec] of prev.vecs) {
    if (embedded.has(id)) continue;
    out.push({ id, vec, src: prev.srcs.get(id) });
  }
  return out;
}

// --- phase 2 -----------------------------------------------------------------
async function embedPhase(job) {
  // A scoped build embeds only the chosen sets' cards. The catalog it writes is
  // still the whole table, because the vectors for every OTHER set are MERGED back
  // in below — without that, "build Bloomburrow" would silently delete the
  // Foundations vectors built last week, since this phase writes exactly the rows
  // it embedded.
  const scoped = job.sets && job.sets.length;
  const setFilter = scoped ? job.sets.flatMap(s => {
    const bare = s.replace(/^mtg-/, '');
    return [bare, `${job.game}-${bare}`];
  }) : [];
  const rows = await db.all(
    `SELECT id, image_url FROM card_cache
      WHERE game = ? AND language = ? AND image_url IS NOT NULL AND image_url != ''
        ${scoped ? `AND LOWER(set_id) IN (${setFilter.map(() => '?').join(',')})` : ''}
      ORDER BY id`,
    scoped ? [job.game, job.lang, ...setFilter.map(s => String(s).toLowerCase())] : [job.game, job.lang]
  );
  job.phase = 'embed';
  job.total = rows.length;
  job.done = 0;
  if (!rows.length) return { built: 0, reused: 0, failed: 0, wrote: false };

  // Resume: keep every embedding whose source image has not changed.
  let prev = null;
  try {
    if (fs.existsSync(metaPath(job.game, job.lang))) {
      const { meta, bin: buf } = readCatalog(metaPath(job.game, job.lang));
      if ((meta.model && meta.model !== 'milo1') || (meta.views || 1) !== 1) throw new Error('Different embedding configuration; run a full rebuild');
      const vecs = new Map();
      for (let i = 0; i < meta.ids.length; i++) {
        vecs.set(meta.ids[i], new Float32Array(buf.buffer, buf.byteOffset + i * meta.dim * 4, meta.dim));
      }
      prev = { vecs, srcs: new Map(Object.entries(meta.srcs || {})) };
    }
  } catch (e) {
    if (scoped) throw e;
    prev = null;
  }

  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'milo.onnx'), {
    intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
  });

  const ids = [], vecs = [], srcs = {};
  let built = 0, reused = 0, failed = 0;
  const queue = rows.slice();
  const inflight = new Map();
  const CONCURRENCY = 8;

  // Scryfall's image CDN rejects a request with no User-Agent — 400, not 403, which
  // reads like a bad URL. Read the version from package.json.
  const HEADERS = {
    'User-Agent': `Manafolio/${require('../package.json').version}`,
    Accept: 'image/*',
  };
  const fetchOne = async (row) => {
    const res = await fetch(row.image_url, {
      signal: AbortSignal.timeout(30000),
      headers: HEADERS,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  // Download ahead while the CPU embeds: the network is the slow half and the
  // model is single-threaded, so overlapping them is most of the wall clock.
  const pump = () => {
    while (inflight.size < CONCURRENCY && queue.length && !job.cancelled) {
      const row = queue.shift();
      // Rebuild a vector when its source artwork changes.
      if (prev && prev.vecs.has(row.id) && prev.srcs.get(row.id) === row.image_url) {
        ids.push(row.id); vecs.push(prev.vecs.get(row.id)); srcs[row.id] = row.image_url;
        reused++; job.done++;
        continue;
      }
      inflight.set(row.id, fetchOne(row).then(buf => ({ row, buf }), err => ({ row, err })));
    }
  };

  pump();
  while (inflight.size) {
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.row.id);
    if (settled.err) failed++;
    else {
      try {
        const { data } = await sharp(settled.buf).resize(SIZE, SIZE, { fit: 'fill' })
          .removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const out = await session.run({ image: cvScan.toTensor(data, SIZE) });
        vecs.push(out.embedding.data);
        ids.push(settled.row.id);
        srcs[settled.row.id] = settled.row.image_url;
        built++;
      } catch { failed++; }
    }
    job.done++;
    job.message = `${built + reused}/${rows.length}`;
    pump();
  }

  if (scoped && prev) {
    for (const { id, vec, src } of keptFromPrev(prev, ids)) {
      ids.push(id); vecs.push(vec);
      if (src) srcs[id] = src;
      reused++;
    }
  }

  // Only complete builds replace the working catalog. Cached card data survives
  // cancellation; uncommitted embeddings are deliberately discarded.
  if (job.cancelled) return { built, reused, failed, wrote: false };
  if (failed) throw new Error(`${failed} card(s) failed to embed; catalog unchanged`);
  if (!vecs.length) return { built, reused, failed, wrote: false };
  const dim = vecs[0].length;
  publishCatalog(metaPath(job.game, job.lang), {
    dim, ids, srcs, game: job.game, lang: job.lang,
    model: 'milo1', views: 1, builtAt: new Date().toISOString(),
  }, vecs);
  cvScan.reload(job.game, job.lang);
  return { built, reused, failed, wrote: true, rows: ids.length };
}

function start(game, lang = 'English', opts = {}) {
  if (game !== 'mtg') throw new Error('Unsupported game');
  if (current) throw new Error('a catalog build is already running');
  const job = {
    game, lang: languages.toName(lang) || 'English',
    // Which sets this build covers, or empty for the whole game. Lowercased once
    // here so neither phase has to think about case: cachePhase passes them to the
    // provider and embedPhase matches them against LOWER(set_id).
    sets: (opts.sets || []).map(s => String(s).trim().toLowerCase()).filter(Boolean),
    phase: 'starting', done: 0, total: 0, message: '',
    startedAt: Date.now(), cancelled: false,
  };
  current = job;
  (async () => {
    try {
      const cached = opts.skipCache ? { cards: 0, failed: 0 } : await cachePhase(job);
      if (cached.failed) throw new Error(`${cached.failed} set(s) failed to cache; catalog unchanged`);
      const embedded = job.cancelled ? null : await embedPhase(job);
      job.phase = job.cancelled ? 'cancelled' : 'done';
      // Say what was skipped and why, or a build that could not touch 46 listed sets
      // reports success and leaves the user wondering why the coverage did not move.
      const skipped = cached.gaps ? `, ${cached.gaps} set(s) skipped — no card data upstream` : '';
      job.message = job.cancelled ? `build cancelled; catalog unchanged, cached ${cached.cards} cards${skipped}` : embedded
        ? `${embedded.rows || 0} cards embedded (${embedded.built} new, ${embedded.reused} reused, ${embedded.failed} failed)${skipped}`
        : `cached ${cached.cards} cards${skipped}`;
      console.log(`catalog: ${job.game}/${job.lang} ${job.phase} — ${job.message}`);
    } catch (e) {
      job.phase = 'error';
      job.message = e.message;
      console.error(`catalog: ${job.game}/${job.lang} failed:`, e.message);
    } finally {
      job.finishedAt = Date.now();
      last = state();
      current = null;
    }
  })();
  return state();
}

let last = null;
const lastResult = () => last;

module.exports = { list, setCounts, newSetCount, keptFromPrev, start, stop, state, lastResult, binPath, metaPath, GAMES };
