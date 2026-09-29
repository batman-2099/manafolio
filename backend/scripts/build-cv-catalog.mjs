// Build a CollectorVision embedding catalog from THIS install's card_cache.
//
// Local catalogs use card_cache IDs, so every match resolves to a known printing.
// Unlike published snapshots, they can incorporate newly cached cards.
//
// Experimental multi-view builder. Production builds use build-catalog.mjs.
// An explicit JSON output outside CV_MODEL_DIR keeps limited experiments from
// replacing the scanner's working catalog. Only complete runs are published.
//
// Usage, from backend/:
//   node scripts/build-cv-catalog.mjs --game mtg --limit 2000 --output /tmp/milo-test/catalog.json
//   node scripts/build-cv-catalog.mjs --game mtg --views 3 --output /tmp/milo-test/catalog.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const db = require('../src/db');
const { toTensor } = require('../src/cvScan');
const { readCatalog, publishCatalog } = require('../src/utils/localCatalog');
const languages = require('../src/utils/languages');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const game = arg('--game', 'mtg');
if (game !== 'mtg') throw new Error('Unsupported game');
const lang = languages.toName(arg('--lang', 'English'));
const limit = Number(arg('--limit', '0'));
const views = Number(arg('--views', '1'));
const concurrency = Number(arg('--concurrency', '8'));
if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(views) || views < 1 || views > 25
    || !Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid limit, views (1–25), or concurrency');

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
const SIZE = 448;
const output = arg('--output', '');
if (!output || !output.endsWith('.json')) throw new Error('--output must name an experimental .json catalog outside CV_MODEL_DIR; use build-catalog.mjs for production');
const metaPath = path.resolve(output);
fs.mkdirSync(MODEL_DIR, { recursive: true });
fs.mkdirSync(path.dirname(metaPath), { recursive: true });
const relative = path.relative(fs.realpathSync(MODEL_DIR), fs.realpathSync(path.dirname(metaPath)));
if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
  throw new Error('--output must be outside CV_MODEL_DIR');
}
let cancelled = false;
process.on('SIGINT', () => { cancelled = true; });
process.on('SIGTERM', () => { cancelled = true; });

// The reference image is already a flat, square-on card render — there is nothing
// to dewarp. `--views` insets the crop to test robustness to imperfect dewarping.
async function embedCard(session, buf) {
  const vecs = [];
  for (let v = 0; v < views; v++) {
    const inset = v === 0 ? 0 : 0.02 * v;          // 0%, 2%, 4% ...
    const meta = await sharp(buf).metadata();
    const w = meta.width || SIZE, h = meta.height || SIZE;
    const dx = Math.round(w * inset), dy = Math.round(h * inset);
    const pipe = inset > 0
      ? sharp(buf).extract({ left: dx, top: dy, width: w - 2 * dx, height: h - 2 * dy })
      : sharp(buf);
    const { data } = await pipe.resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha()
      .raw().toBuffer({ resolveWithObject: true });
    const out = await session.run({ image: toTensor(data, SIZE) });
    vecs.push(out.embedding.data);
  }
  if (vecs.length === 1) return vecs[0];
  const acc = new Float32Array(vecs[0].length);
  for (const v of vecs) for (let d = 0; d < acc.length; d++) acc[d] += v[d];
  let n = 0;
  for (let d = 0; d < acc.length; d++) n += acc[d] * acc[d];
  n = Math.sqrt(n) || 1;
  for (let d = 0; d < acc.length; d++) acc[d] /= n;
  return acc;
}

function loadExisting() {
  if (!fs.existsSync(metaPath)) return null;
  try {
    const { meta, bin: buf } = readCatalog(metaPath);
    if (meta.model !== 'milo1' || (meta.views || 1) !== views || meta.game !== game || meta.lang !== lang) return null;
    const vecs = new Map();
    const dim = meta.dim;
    for (let i = 0; i < meta.ids.length; i++) {
      vecs.set(meta.ids[i], new Float32Array(buf.buffer, buf.byteOffset + i * dim * 4, dim));
    }
    return { meta, vecs, dim, srcs: new Map(Object.entries(meta.srcs || {})) };
  } catch (e) {
    console.warn(`existing catalog unreadable (${e.message}); rebuilding from scratch`);
    return null;
  }
}

async function main() {
  await db.initDb();
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const rows = await db.all(
    `SELECT id, name, image_url FROM card_cache
      WHERE game = ? AND language = ? AND image_url IS NOT NULL AND image_url != ''
      ORDER BY id` + (limit ? ` LIMIT ${limit}` : ''),
    [game, lang]
  );
  console.log(`${rows.length} ${game} cards with artwork in card_cache (${lang})`);

  const prev = loadExisting();
  if (prev) console.log(`resuming: ${prev.vecs.size} embeddings already built`);

  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'milo.onnx'), {
    intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential',
  });

  const ids = [], out = [], srcs = {};
  let built = 0, reused = 0, failed = 0, done = 0;

  // Fetch a window ahead while the CPU embeds: downloads are the slow half and
  // the model is single-threaded, so overlapping them is most of the wall clock.
  const queue = rows.slice();
  const inflight = new Map();
  const fetchOne = async (row) => {
    const res = await fetch(row.image_url, {
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': `Manafolio/${require('../package.json').version}`, Accept: 'image/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const pump = () => {
    while (inflight.size < concurrency && queue.length && !cancelled) {
      const row = queue.shift();
      if (prev && prev.vecs.has(row.id) && prev.srcs.get(row.id) === row.image_url) {
        ids.push(row.id); out.push(prev.vecs.get(row.id)); srcs[row.id] = row.image_url;
        reused++; done++;
        continue;
      }
      inflight.set(row.id, fetchOne(row).then(buf => ({ row, buf }), err => ({ row, err })));
    }
  };

  pump();
  while (inflight.size) {
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.row.id);
    if (settled.err) {
      failed++;
    } else {
      try {
        out.push(await embedCard(session, settled.buf));
        ids.push(settled.row.id);
        srcs[settled.row.id] = settled.row.image_url;
        built++;
      } catch (e) {
        failed++;
      }
    }
    done++;
    if (done % 250 === 0) console.log(`  ${done}/${rows.length}  built ${built}  reused ${reused}  failed ${failed}`);
    pump();
  }

  if (cancelled) throw new Error('Build cancelled; catalog unchanged');
  if (failed) throw new Error(`${failed} card(s) failed to embed; catalog unchanged`);
  if (!out.length) throw new Error('nothing embedded; refusing to write an empty catalog');
  const dim = out[0].length;
  publishCatalog(metaPath, {
    dim, ids, srcs, views, game, lang,
    model: 'milo1', builtAt: new Date().toISOString(),
  }, out);

  console.log(`\nwrote ${ids.length} x ${dim} to ${metaPath}`);
  console.log(`built ${built}, reused ${reused}, failed ${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
