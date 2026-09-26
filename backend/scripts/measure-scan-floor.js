// What cosine says "this card is not in the catalog at all"?
//
// The nearest catalog row always exists even when the photographed card is absent.
//
// cvScan.FLOOR is the line under which the top hit is reported as
// `notInCatalog`. This measures where that line belongs, per catalog:
//
//   GENUINE  — the card IS catalogued. Its own art, degraded to look like a
//              capture, searched against the whole catalog. Top hit should be
//              itself; the score is what a correct answer looks like.
//   IMPOSTOR — the same images searched with their own row MASKED OUT, which is
//              exactly the missing-card case: same game, same era, same layout,
//              and no right answer available.
//
// A floor is only useful if it sits above most impostors and below most genuines.
// Both numbers are optimistic in the same direction — synthetic degradation
// (downscale + JPEG + slight blur) is kinder than a phone in a card shop — so
// prefer a floor near the impostor tail over one hugging the genuine tail.
//
// Run: node scripts/measure-scan-floor.js [game] [language] [sampleSize]
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const db = require('../src/db');
const cvScan = require('../src/cvScan');

const SIZE = 448;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

function toTensor(rgb) {
  const plane = SIZE * SIZE;
  const x = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < 3; c++) x[c * plane + p] = (rgb[p * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  return new ort.Tensor('float32', x, [1, 3, SIZE, SIZE]);
}

// A capture, not a scan of the reference image. Two regimes, because they answer
// different questions:
//
//   mild  — the reference image itself, downscaled and JPEG'd like the client does.
//           Near-perfect input: an upper bound on what any answer can score.
//   harsh — blur, a crooked hold, a tighter crop, brightness drift and a low JPEG
//           quality. This is the regime that matters, and it is calibrated to land
//           genuine scores near the 0.55-0.95 band the real eval sample produced;
//           mild input scores ~0.99 and says nothing about a live scan.
//
// Neither models glare or a shadow across the art, so both are still optimistic.
async function asCapture(buf, harsh) {
  let img = sharp(buf).resize(SIZE, SIZE, { fit: 'fill' });
  if (harsh) {
    // Rotate-then-crop: a hand-held card is never square to the sensor, and the
    // frame it lands in is tighter than the reference scan.
    // Three separate pipelines on purpose: sharp applies extract BEFORE resize
    // within one chain, so crop-then-rescale has to be crop, output, rescale.
    const tilted = await img.rotate(3, { background: '#000' }).resize(SIZE, SIZE, { fit: 'fill' }).toBuffer();
    const cropped = await sharp(tilted)
      .extract({ left: 14, top: 14, width: SIZE - 28, height: SIZE - 28 }).toBuffer();
    img = sharp(cropped).resize(SIZE, SIZE, { fit: 'fill' })
      .modulate({ brightness: 1.12 })
      .blur(1.4);
  } else {
    img = img.blur(0.6);
  }
  const jpeg = await img.jpeg({ quality: harsh ? 55 : 85 }).toBuffer();
  const { data } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return data;
}

// Same cosine cvScan does, with one row optionally masked. Returns the top TWO,
// because the gap between them is the other thing a gate could read: a card the
// catalog does not have produces a flat cluster of strangers, not a winner.
function top2(emb, cat, n, dim, skip) {
  // Ranks 1..11. The mean of 2..11 is the "how flat is this neighbourhood" signal:
  // both it and the top score fall together when the photo is bad, so their GAP is
  // a candidate gate that does not need the capture quality held constant.
  const K = 11;
  const best = new Float64Array(K).fill(-Infinity);
  let at = -1;
  for (let i = 0; i < n; i++) {
    if (i === skip) continue;
    const off = i * dim;
    let s = 0;
    for (let d = 0; d < dim; d++) s += emb[d] * cat[off + d];
    if (s <= best[K - 1]) continue;
    let j = K - 1;
    while (j > 0 && best[j - 1] < s) { best[j] = best[j - 1]; j--; }
    best[j] = s;
    if (j === 0) at = i;
  }
  let tail = 0;
  for (let j = 1; j < K; j++) tail += best[j];
  return { sim: best[0], i: at, margin: best[0] - best[1], gap: best[0] - tail / (K - 1) };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function main() {
  const [game = 'mtg', lang = 'English', sizeArg = '60'] = process.argv.slice(2);
  if (!['mtg', 'lorcana'].includes(game)) throw new Error('Unsupported game');
  const sample = Number(sizeArg);
  const s = await cvScan.load(game, lang);
  if (!s.local) throw new Error(`${game}/${lang} has no locally built catalog to measure`);
  console.log(`catalog: ${game}/${s.lang}, ${s.n} rows x ${s.dim}d`);

  const rows = await db.all(
    `SELECT id, image_url FROM card_cache WHERE game = ? AND language = ?
       AND image_url IS NOT NULL AND image_url != ''`,
    [game, s.lang]
  );
  const byId = new Map(rows.map(r => [r.id, r.image_url]));
  const at = new Map(s.ids.map((id, i) => [String(id), i]));

  // Evenly spaced through the catalog rather than the first N: ids are ordered by
  // set, and the first N would measure one set's internal confusability.
  const step = Math.max(1, Math.floor(s.n / sample));
  const picks = [];
  for (let i = 0; i < s.n && picks.length < sample; i += step) {
    const id = String(s.ids[i]);
    if (byId.has(id)) picks.push({ id, i });
  }

  const runs = { mild: { genuine: [], impostor: [] }, harsh: { genuine: [], impostor: [] } };
  let wrongTop = 0, failed = 0;
  for (const { id, i } of picks) {
    try {
      // The url the catalog was BUILT from, so this measures the pipeline rather
      // than a resolution mismatch (see catalog.js embedUrl).
      const url = byId.get(id);
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const art = Buffer.from(await res.arrayBuffer());
      for (const regime of ['mild', 'harsh']) {
        const rgb = await asCapture(art, regime === 'harsh');
        const out = await s.milo.run({ image: toTensor(rgb) });
        const emb = out.embedding.data;
        const hit = top2(emb, s.cat, s.n, s.dim, -1);
        if (regime === 'harsh' && hit.i !== i) wrongTop++;
        // The top hit either way: a genuine score is what the WINNER scores, and a
        // sample whose winner is a different printing of the same art is still the
        // kind of answer the pipeline calls correct.
        runs[regime].genuine.push(hit);
        // Its own row masked out — the missing-card case, with no right answer
        // available anywhere in the catalog.
        runs[regime].impostor.push(top2(emb, s.cat, s.n, s.dim, i));
      }
    } catch (e) {
      failed++;
      if (failed < 4) console.warn(`  ${id}: ${e.message}`);
    }
  }

  const num = (a, b) => a - b;
  const show = (label, arr, field) => {
    const v = arr.map(x => x[field]).sort(num);
    console.log(`  ${label.padEnd(9)} ${field.padEnd(6)} n=${v.length}  min ${pct(v, 0).toFixed(3)}`
      + `  p5 ${pct(v, 5).toFixed(3)}  p50 ${pct(v, 50).toFixed(3)}  p95 ${pct(v, 95).toFixed(3)}`
      + `  max ${v[v.length - 1].toFixed(3)}`);
  };
  console.log(`sampled ${picks.length}, ${failed} unfetchable, harsh top-1 wrong on ${wrongTop}`);
  for (const regime of ['mild', 'harsh']) {
    console.log(regime + ':');
    show('genuine', runs[regime].genuine, 'sim');
    show('impostor', runs[regime].impostor, 'sim');
    show('genuine', runs[regime].genuine, 'margin');
    show('impostor', runs[regime].impostor, 'margin');
    show('genuine', runs[regime].genuine, 'gap');
    show('impostor', runs[regime].impostor, 'gap');
  }
  // What each candidate floor would actually cost, in the harsh regime — the two
  // errors are not symmetric. A rejected genuine answer still shows its candidate
  // list and only loses the auto-add; an accepted impostor files the wrong card.
  const h = runs.harsh;
  for (const [field, from, to, step] of [['sim', 0.55, 0.9, 0.05], ['gap', 0.02, 0.20, 0.02]]) {
    console.log(`${field} threshold   impostors passed   genuines rejected (mild | harsh)`);
    for (let f = from; f <= to + 1e-9; f += step) {
      const cell = (r) => `${String(r.impostor.filter(x => x[field] >= f).length).padStart(2)}/${r.impostor.length}`
        + ` ${String(r.genuine.filter(x => x[field] < f).length).padStart(2)}/${r.genuine.length}`;
      console.log(`  ${f.toFixed(2)}            ${cell(runs.mild)}   |   ${cell(runs.harsh)}`);
    }
  }
  console.log(`current cvScan.GAP_FLOOR = ${cvScan.GAP_FLOOR}`);
  for (const regime of ['mild', 'harsh']) {
    const r = runs[regime];
    console.log(`  ${regime}: strangers passed ${r.impostor.filter(x => x.gap >= cvScan.GAP_FLOOR).length}/${r.impostor.length}`
      + `, correct answers rejected ${r.genuine.filter(x => x.gap < cvScan.GAP_FLOOR).length}/${r.genuine.length}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
