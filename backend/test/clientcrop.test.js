// The browser dewarps the card itself and uploads only the rectified square
// (CameraScanner.localDewarp -> cvScan.match with `cropped`). That is two
// implementations of one geometry — a JS warp in the page and sharp/warpRgb on
// the server — and if they ever disagree the failure is silent: milo still
// returns a card, just a slightly worse-framed one, and accuracy drifts with
// nothing pointing at the cause.
//
// Deterministic shared geometry checks always run, without models or downloads.
// The optional --models diagnostic also compares real frame matches and cosine;
// it needs installed ONNX models, an MTG catalog and local scan-debug frames.
//
// Run: node test/clientcrop.test.js [--models]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');

const MODEL_DIR = path.join(__dirname, '..', 'data', 'models');
const FRAME_DIR = path.join(__dirname, '..', 'data', 'scan-debug');
const CORN = 384, EMBED = 448;

const cvScan = require('../src/cvScan');

function frames() {
  if (!fs.existsSync(FRAME_DIR)) return [];
  return fs.readdirSync(FRAME_DIR).filter(f => f.endsWith('-frame.jpg')).slice(0, 6);
}

async function corners(session, buf) {
  const { data } = await sharp(buf).resize(CORN, CORN, { fit: 'fill' }).removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const out = await session.run({ image: cvScan.toTensor(data, CORN) });
  const c = out.corners.data;
  const { orderQuad } = await import('../../shared/imgproc.mjs');
  return {
    sharpness: out.sharpness ? out.sharpness.data[0] : 1,
    quad: orderQuad(Array.from({ length: 4 }, (_, i) => ({ x: c[i * 2], y: c[i * 2 + 1] }))),
  };
}

// CameraScanner.localDewarp, in Node, over the same shared/imgproc the page uses.
async function clientCrop(buf, quad) {
  const { getPerspectiveTransform, warpPerspective } = await import('../../shared/imgproc.mjs');
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = EMBED - 1;
  const src = quad.map(p => ({ x: p.x * w, y: p.y * h }));
  const dst = [{ x: 0, y: 0 }, { x: N, y: 0 }, { x: N, y: N }, { x: 0, y: N }];
  const transform = getPerspectiveTransform(src, dst);
  assert(transform, 'diagnostic corners must define an invertible perspective transform');
  const rgba = warpPerspective(new Uint8ClampedArray(data), w, h, transform, EMBED, EMBED);
  return sharp(Buffer.from(rgba.buffer), { raw: { width: EMBED, height: EMBED, channels: 4 } })
    .jpeg({ quality: 90 }).toBuffer();
}

async function geometry() {
  const { orderQuad, getPerspectiveTransform, warpPerspective } = await import('../../shared/imgproc.mjs');
  const expected = [{ x: 1, y: 1 }, { x: 7, y: 2 }, { x: 6, y: 7 }, { x: 1, y: 6 }];
  const dst = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }];
  const pixels = new Uint8ClampedArray(9 * 9 * 4);
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    pixels.set([x * 20, y * 20, 80, 255], (y * 9 + x) * 4);
  }
  const permutations = points => points.length === 1 ? [points]
    : points.flatMap((point, index) => permutations(points.filter((_, i) => i !== index))
      .map(rest => [point, ...rest]));
  for (const points of permutations(expected)) {
    const src = orderQuad(points);
    assert.deepStrictEqual(src, expected, 'all detector corner permutations use the same non-crossing order');
    const transform = getPerspectiveTransform(src, dst);
    assert(transform);
    for (let k = 0; k < 4; k++) {
      const { x, y } = src[k];
      const denominator = transform[6] * x + transform[7] * y + 1;
      assert(Math.abs((transform[0] * x + transform[1] * y + transform[2]) / denominator - dst[k].x) < 1e-8);
      assert(Math.abs((transform[3] * x + transform[4] * y + transform[5]) / denominator - dst[k].y) < 1e-8);
    }
    const warped = warpPerspective(pixels, 9, 9, transform, 5, 5);
    for (let k = 0; k < 4; k++) {
      const offset = (dst[k].y * 5 + dst[k].x) * 4;
      assert(Math.abs(warped[offset] - src[k].x * 20) <= 1);
      assert(Math.abs(warped[offset + 1] - src[k].y * 20) <= 1);
      assert.strictEqual(warped[offset + 2], 80);
      assert.strictEqual(warped[offset + 3], 255);
    }
  }
  assert.deepStrictEqual(Array.from(warpPerspective(pixels, 9, 9,
    getPerspectiveTransform(dst, dst), 9, 9)), Array.from(pixels), 'identity preserves every pixel');
  const line = [0, 1, 2, 3].map(x => ({ x, y: x }));
  for (const invalid of [line, Array(4).fill(dst[0]), [dst[0], dst[0], dst[2], dst[3]],
    [{ x: NaN, y: 0 }, ...dst.slice(1)], dst.slice(1)]) {
    assert.strictEqual(getPerspectiveTransform(invalid, dst), null, 'invalid source is rejected');
    assert.strictEqual(getPerspectiveTransform(dst, invalid), null, 'invalid destination is rejected');
  }
  console.log('clientcrop.test.js: deterministic ordering, perspective and pixel geometry passed');
}

async function main() {
  await geometry();
  if (!process.argv.includes('--models')) return;
  const files = frames();
  if (!fs.existsSync(path.join(MODEL_DIR, 'cornelius.onnx')) || !cvScan.isBuilt('mtg') || !files.length) {
    console.log('clientcrop.test.js: no models/catalog/frames present — skipped');
    return;
  }
  const session = await ort.InferenceSession.create(path.join(MODEL_DIR, 'cornelius.onnx'),
    { intraOpNumThreads: 1, interOpNumThreads: 1 });

  let checked = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(FRAME_DIR, f));
    const { quad, sharpness } = await corners(session, buf);
    // Below the gate the browser uploads the whole frame instead, so there is no
    // client crop to compare.
    if (sharpness <= 0.02) continue;

    const viaServer = await cvScan.match(buf, 'mtg', 5);
    const viaClient = await cvScan.match(await clientCrop(buf, quad), 'mtg', 5, { cropped: true });
    const a = viaServer.candidates[0], b = viaClient.candidates[0];
    assert.ok(a && b, `${f}: both paths must return a candidate`);
    assert.strictEqual(b.cardId, a.cardId,
      `${f}: client crop picked ${b.cardId}, server crop picked ${a.cardId} — the two dewarps disagree`);
    // Same card is the requirement; near-identical cosine is what proves it is
    // the same CROP rather than a different one that happens to match anyway.
    assert.ok(Math.abs(a.score - b.score) < 0.02,
      `${f}: cosine ${a.score.toFixed(3)} vs ${b.score.toFixed(3)} — crops differ more than JPEG noise`);
    checked++;
  }
  assert.ok(checked > 0, 'every frame was below the sharpness gate — nothing was actually compared');
  console.log(`clientcrop.test.js: ${checked} frames, both dewarps agree`);
}

main().catch((e) => { console.error(e); process.exit(1); });
