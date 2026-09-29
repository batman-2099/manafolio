const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-catalog-'));
const models = path.join(dir, 'models');
fs.mkdirSync(models);
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.CV_MODEL_DIR = models;
process.env.DEFAULT_ADMIN_PASSWORD = 'catalog-test';
const db = require('../src/db');
const ort = require('onnxruntime-node');
const create = ort.InferenceSession.create;
const catalog = require('../src/catalog');
const cv = require('../src/cvScan');
const { readCatalog, binaryPath } = require('../src/utils/localCatalog');
const api = require('../src/scryfallApi');
const get = api.client.get;
const metaFile = catalog.metaPath('mtg', 'English');
let behavior = 'normal', calls = 0;
ort.InferenceSession.create = async () => ({ run: async () => {
  calls++;
  if (behavior === 'cancel' && calls === 1) catalog.stop();
  if (behavior === 'fail') throw new Error('inference failed');
  return { embedding: { data: new Float32Array([1, 0]) } };
} });
const build = async (opts = {}) => {
  calls = 0;
  catalog.start('mtg', 'English', { skipCache: true, ...opts });
  const deadline = Date.now() + 10000;
  while (catalog.state()) {
    assert(Date.now() < deadline, 'catalog job must finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return catalog.lastResult();
};
const snapshot = () => {
  const meta = fs.readFileSync(metaFile);
  const bin = fs.readFileSync(binaryPath(metaFile, JSON.parse(meta)));
  return { meta, bin };
};
(async () => {
  await db.initDb();
  const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#777' } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString('base64')}`;
  const ids = Array.from({ length: 12 }, (_, i) => `mtg-${String(i).padStart(2, '0')}`);
  for (const id of ids) await db.run(`INSERT INTO card_cache (id, name, game, language, image_url, set_id) VALUES (?, ?, 'mtg', 'English', ?, 'tst')`, [id, id, image]);
  fs.writeFileSync(metaFile, JSON.stringify({ dim: 2, ids, model: 'milo1', srcs: {} }));
  fs.writeFileSync(catalog.binPath('mtg'), Buffer.from(new Float32Array(24).fill(0.5).buffer));
  fs.writeFileSync(path.join(models, 'milo.onnx'), 'fixture');
  fs.writeFileSync(path.join(models, 'cornelius.onnx'), 'fixture');
  assert.deepStrictEqual((await cv.load()).ids, ids, 'installed legacy pairs remain readable');
  const before = snapshot();
  behavior = 'cancel';
  assert.strictEqual((await build()).phase, 'cancelled');
  assert(calls < 12, 'cancel interrupts a full rebuild before its queue completes');
  assert.deepStrictEqual(snapshot(), before);
  behavior = 'fail';
  assert.strictEqual((await build()).phase, 'error');
  assert.deepStrictEqual(snapshot(), before);
  behavior = 'normal';
  const write = fs.writeFileSync, rename = fs.renameSync;
  for (const point of ['binary', 'metadata', 'commit']) {
    fs.writeFileSync = (file, ...args) => {
      const result = write(file, ...args);
      if ((point === 'binary' && String(file).endsWith('.bin')) || (point === 'metadata' && String(file).endsWith('.json.tmp'))) throw new Error('injected publication failure');
      return result;
    };
    fs.renameSync = (src, dest) => {
      if (point === 'commit' && dest === metaFile) throw new Error('injected commit failure');
      return rename(src, dest);
    };
    try { assert.strictEqual((await build()).phase, 'error'); }
    finally { fs.writeFileSync = write; fs.renameSync = rename; }
    assert.deepStrictEqual(snapshot(), before, point);
    assert.deepStrictEqual(fs.readdirSync(models).sort(), ['cornelius.onnx', 'milo-mtg-local.bin', 'milo-mtg-local.json', 'milo.onnx']);
  }
  assert.strictEqual((await build()).phase, 'done');
  const committed = readCatalog(metaFile);
  assert.deepStrictEqual(committed.meta.ids.slice().sort(), ids);
  assert.deepStrictEqual(Array.from((await cv.load()).cat), Array.from({ length: 24 }, (_, i) => i % 2 ? 0 : 1));
  assert.strictEqual((await catalog.list())[0].built.bytes, 96);
  assert.strictEqual((await catalog.setCounts('mtg')).sets.tst.embedded, 12);
  assert(!fs.existsSync(metaFile.replace(/\.json$/, '.bin')), 'successful generation retires legacy binary');
  assert.deepStrictEqual(fs.readFileSync(catalog.binPath('mtg')), committed.bin, 'exported path resolves the committed generation');
  const oldBinary = committed.meta.binary;
  assert.strictEqual((await build()).phase, 'done');
  assert.strictEqual(calls, 0, 'unchanged committed images can be reused');
  assert(!fs.existsSync(path.join(models, oldBinary)), 'successful replacement retires previous generation');
  const stable = snapshot();
  api.client.get = async url => {
    if (new URL(url).pathname === '/sets') return { data: { data: [{ code: 'tst', card_count: 12 }] } };
    return { data: { data: [{ id: 'new', name: 'New', image_uris: { normal: image } }] } };
  };
  await db.run(`CREATE TRIGGER fail_cache BEFORE INSERT ON card_cache BEGIN SELECT RAISE(FAIL, 'cache write failed'); END`);
  const failedCache = await build({ skipCache: false });
  assert.strictEqual(failedCache.phase, 'error');
  assert.match(failedCache.message, /1 set\(s\) failed to cache/);
  assert.strictEqual(calls, 0, 'failed card persistence must not proceed to embedding');
  assert.deepStrictEqual(snapshot(), stable);
  await db.run('DROP TRIGGER fail_cache');

  const preload = path.join(dir, 'inference.cjs');
  fs.writeFileSync(preload, `const ort = require(${JSON.stringify(require.resolve('onnxruntime-node'))}); let n = 0; ort.InferenceSession.create = async () => ({ run: async () => ({ embedding: { data: new Float32Array(n++ % 2 ? [0, 1] : [1, 0]) } }) });`);
  const script = path.resolve(__dirname, '../scripts/build-cv-catalog.mjs');
  const cli = args => spawnSync(process.execPath, ['--require', preload, script, ...args], { env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(cli(['--limit', '1']).status, 0, 'limited build needs explicit isolated output');
  assert.notStrictEqual(cli(['--limit', '1', '--output', metaFile]).status, 0);
  const output = path.join(dir, 'experiment.json');
  let result = cli(['--limit', '1', '--views', '1', '--concurrency', '1', '--output', output]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(readCatalog(output).meta.ids.length, 1);
  result = cli(['--limit', '1', '--views', '2', '--concurrency', '1', '--output', output]);
  assert.strictEqual(result.status, 0, result.stderr);
  const experiment = readCatalog(output);
  assert(Math.abs(experiment.bin.readFloatLE(4) - Math.SQRT1_2) < 1e-6, 'changed views re-embed rather than reuse old vectors');
  assert.deepStrictEqual(snapshot(), stable, 'experiments never replace production');
  console.log('catalogsafety.test.js: publication faults, cancellation, failed cache/inference, legacy loading, reuse and isolated multi-view CLI passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  ort.InferenceSession.create = create;
  api.client.get = get;
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
