const assert = require('assert');
const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ort = require('onnxruntime-node');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-candidate-sort-'));
process.env.CV_MODEL_DIR = dir;
const create = ort.InferenceSession.create;
let embedding = [0, 1];
ort.InferenceSession.create = async () => ({
  run: async () => ({ embedding: { data: new Float32Array(embedding) } }),
});
fs.writeFileSync(path.join(dir, 'cornelius.onnx'), 'fixture');
fs.writeFileSync(path.join(dir, 'milo.onnx'), 'fixture');
fs.writeFileSync(path.join(dir, 'milo-mtg-local.json'), JSON.stringify({ dim: 2, ids: ['A', 'A_back', 'B'] }));
fs.writeFileSync(path.join(dir, 'milo-mtg-local.bin'), Buffer.from(new Float32Array([1, 0, 0, 1, 0.6, 0.8]).buffer));
const cvScan = require('../src/cvScan');

async function noise() {
  const w = 448, h = 448;
  const buf = Buffer.alloc(w * h * 3);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 2654435761) % 251;
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  // Test 1: Empty or single card inputs return cleanly
  const empty = await cvScan.scoreCards(null, 'mtg', []);
  assert.deepStrictEqual(empty, []);

  const single = [{ id: 'mtg-test-1', name: 'Test Card' }];
  const singleRes = await cvScan.scoreCards(await noise(), 'mtg', single);
  assert.strictEqual(singleRes.length, 1);

  const image = await noise();
  for (const face of [[0, 1], [1, 0]]) {
    embedding = face;
    const scored = await cvScan.scoreCards(image, 'mtg', [
      { id: 'mtg-B', name: 'Single face' },
      { id: 'mtg-A', name: 'Double face' },
      { id: 'mtg-unknown', name: 'Not catalogued' },
    ], { cropped: true });
    assert.deepStrictEqual(scored.map(card => card.id), ['mtg-A', 'mtg-B', 'mtg-unknown'],
      'either stored face must outrank a merely similar printing');
    assert.strictEqual(scored[0].score, 1);
    assert.strictEqual(scored[0].__match.score, 1);
    assert.ok(Math.abs(scored[1].score - (face[0] ? 0.6 : 0.8)) < 1e-6);
    assert.strictEqual(scored[2].score, undefined);
  }

  console.log('scancandidatesort.test.js: all assertions passed');
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  ort.InferenceSession.create = create;
  fs.rmSync(dir, { recursive: true, force: true });
});
