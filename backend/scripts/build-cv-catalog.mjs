// Build a CollectorVision embedding catalog from THIS install's card_cache.
//
// Local catalogs use card_cache IDs, so every match resolves to a known printing.
// Unlike published snapshots, they can incorporate newly cached cards.
//
// Output, beside the models:
//   milo-<game>-local.bin    Float32 embeddings, n * dim, row-major
//   milo-<game>-local.json   { dim, ids: [...], builtAt, model, views }
//
// Resumable: re-running keeps every embedding already computed and only fetches
// cards that are new or whose image_url changed. A full MTG build takes hours.
//
// Usage, from backend/:
//   node scripts/build-cv-catalog.mjs --game lorcana
//   node scripts/build-cv-catalog.mjs --game mtg --limit 2000
//   node scripts/build-cv-catalog.mjs --game mtg --views 3   # augmented mean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const db = require('../src/db');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const game = arg('--game', 'mtg');
if (!['mtg', 'lorcana'].includes(game)) throw new Error('Unsupported game');
const lang = arg('--lang', 'English');
const limit = parseInt(arg('--limit', '0'), 10);
const views = Math.max(1, parseInt(arg('--views', '1'), 10));
const concurrency = Math.max(1, parseInt(arg('--concurrency', '8'), 10));

const MODEL_DIR = process.env.CV_MODEL_DIR || path.join(__dirname, '..', 'data', 'models');
const SIZE = 448;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// MUST match cvScan's naming, including the English special case: English keeps
// the bare filename so existing builds stay valid, every other language gets its
// own file. Without the suffix a `--lang Japanese` build silently OVERWRITES the
// English catalog with 3k Japanese cards, which looks like a working build and
// is a total loss of the English one.
const langSuffix = (l) => (!l || l === 'en' || l === 'English' ? '' : `-${String(l).toLowerCase()}`);
const binPath = path.join(MODEL_DIR, `milo-${game}${langSuffix(lang)}-local.bin`);
const metaPath = path.join(MODEL_DIR, `milo-${game}${langSuffix(lang)}-local.json`);

function toTensor(rgb) {
  const plane = SIZE * SIZE;
  const x = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    x[p] = (rgb[p * 3] / 255 - MEAN[0]) / STD[0];
    x[plane + p] = (rgb[p * 3 + 1] / 255 - MEAN[1]) / STD[1];
    x[2 * plane + p] = (rgb[p * 3 + 2] / 255 - MEAN[2]) / STD[2];
  }
  return new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]);
}

// The reference image is already a flat, square-on card render — there is nothing
// to dewarp. `--views` insets the crop instead, which moves the reference a little
// way toward what a photographed card looks like after an imperfect dewarp. It is
// the catalog-side half of the test-time averaging the scanner does.
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
    const out = await session.run({ image: toTensor(data) });
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
  if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const buf = fs.readFileSync(binPath);
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
    const res = await fetch(row.image_url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const pump = () => {
    while (inflight.size < concurrency && queue.length) {
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

  if (!out.length) { console.error('nothing embedded; refusing to write an empty catalog'); process.exit(1); }
  const dim = out[0].length;
  const bin = Buffer.allocUnsafe(out.length * dim * 4);
  out.forEach((v, i) => Buffer.from(v.buffer, v.byteOffset, dim * 4).copy(bin, i * dim * 4));

  // Write beside the target and rename, so an interrupted run never leaves a
  // half-written catalog that loads as garbage.
  fs.writeFileSync(binPath + '.tmp', bin);
  fs.writeFileSync(metaPath + '.tmp', JSON.stringify({
    dim, ids, srcs, views, game, lang,
    model: 'milo1', builtAt: new Date().toISOString(),
  }));
  fs.renameSync(binPath + '.tmp', binPath);
  fs.renameSync(metaPath + '.tmp', metaPath);

  console.log(`\nwrote ${ids.length} x ${dim} to ${path.basename(binPath)} (${(bin.length / 1e6).toFixed(1)} MB)`);
  console.log(`built ${built}, reused ${reused}, failed ${failed}`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
