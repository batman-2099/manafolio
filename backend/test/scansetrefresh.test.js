const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-scan-sets-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.CV_MODEL_DIR = dir;
const ort = require('onnxruntime-node');
const create = ort.InferenceSession.create;
// Fixed artwork vectors isolate set eligibility from model recognition.
ort.InferenceSession.create = async () => ({ run: async () => ({ embedding: { data: new Float32Array([1, 0]) } }) });
fs.writeFileSync(path.join(dir, 'milo-mtg-local.json'), JSON.stringify({ dim: 2, ids: ['mtg-target', 'mtg-other'] }));
fs.writeFileSync(path.join(dir, 'milo-mtg-local.bin'), Buffer.from(new Float32Array([1, 0, 0.6, 0.8]).buffer));
const db = require('../src/db');
const cv = require('../src/cvScan');
(async () => {
  await db.initDb();
  await db.run("INSERT INTO card_cache (id, name, game, set_id) VALUES ('mtg-other', 'Other', 'mtg', 'msh')");
  const image = await sharp({ create: { width: 448, height: 448, channels: 3, background: '#777' } }).png().toBuffer();
  const scan = () => cv.match(image, 'mtg', 8, { cropped: true, lang: 'English', sets: ['msh'] });
  assert.strictEqual((await scan()).candidates[0].cardId, 'mtg-other');
  await db.run("INSERT INTO card_cache (id, name, game, set_id) VALUES ('mtg-target', 'Target', 'mtg', 'msh')");
  assert.strictEqual((await scan()).candidates[0].cardId, 'mtg-target', 'newly cached printing must enter scope without reloading models');
  await db.run("UPDATE card_cache SET set_id = 'other' WHERE id = 'mtg-target'");
  assert.deepStrictEqual((await scan()).candidates.map(c => c.cardId), ['mtg-other'], 'corrected metadata must remove an out-of-set printing');
  console.log('scansetrefresh.test.js: live set membership assertions passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  ort.InferenceSession.create = create;
  fs.rmSync(dir, { recursive: true, force: true });
});
