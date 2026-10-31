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
let behavior = 'normal', calls = 0, sessions = 0, releases = 0;
ort.InferenceSession.create = async () => {
  sessions++;
  if (behavior === 'init-fail') throw new Error('invalid model protobuf');
  let released = false;
  return {
    run: async ({ image }) => {
      calls++;
      if (behavior === 'cancel' && calls === 1) catalog.stop();
      if (behavior === 'fail') throw new Error('inference failed');
      return { embedding: { data: new Float32Array(behavior === 'faces' && image.data[0] > 0 ? [0, 1] : [1, 0]) } };
    },
    release: async () => {
      assert.strictEqual(released, false, 'each owned session is released once');
      released = true;
      releases++;
    },
  };
};
const build = async (opts = {}) => {
  calls = 0; sessions = 0; releases = 0;
  catalog.start('mtg', 'English', { skipCache: true, ...opts });
  const deadline = Date.now() + 10000;
  while (catalog.state()) {
    assert(Date.now() < deadline, 'catalog job must finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.strictEqual(sessions, behavior === 'init-fail' ? 1 : calls ? 1 : 0,
    'model initialization is attempted once, only for builds needing inference');
  assert.strictEqual(releases, behavior === 'init-fail' ? 0 : sessions,
    'success, cancellation and failure release their acquired session');
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
  await db.run(`UPDATE card_cache SET supertype = 'Token' WHERE id IN (?, ?)`, [ids[1], ids[2]]);
  await db.run('INSERT INTO collection (card_id, reverse_card_id, user_id) VALUES (?, ?, 1)', [ids[1], ids[2]]);
  fs.writeFileSync(metaFile, JSON.stringify({ dim: 2, ids, model: 'milo1', srcs: {} }));
  fs.writeFileSync(catalog.binPath('mtg'), Buffer.from(new Float32Array(24).fill(0.5).buffer));
  fs.writeFileSync(path.join(models, 'milo.onnx'), 'fixture');
  fs.writeFileSync(path.join(models, 'cornelius.onnx'), 'fixture');
  const createSession = ort.InferenceSession.create;
  for (const failedModel of ['cornelius.onnx', 'milo.onnx']) {
    const failure = new Error(`${failedModel} initialization failed`);
    let finishSibling, attempts = 0, released = 0, settled = false;
    ort.InferenceSession.create = file => {
      attempts++;
      return path.basename(file) === failedModel ? Promise.reject(failure)
        : new Promise(resolve => { finishSibling = resolve; });
    };
    const pending = Promise.allSettled([cv.load(), cv.load()]).then(results => {
      settled = true;
      return results;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false, 'failed initialization waits for the sibling session');
    assert.strictEqual(attempts, 2, 'concurrent loads share one initialization');
    finishSibling({ release: async () => {
      released++;
      if (failedModel === 'milo.onnx') throw new Error('cleanup failure');
    } });
    for (const result of await pending) {
      assert.strictEqual(result.status, 'rejected');
      assert.strictEqual(result.reason, failure, 'cleanup does not hide the initialization error');
    }
    assert.strictEqual(released, 1, 'late successful sibling is released exactly once');
  }
  ort.InferenceSession.create = createSession;
  assert.deepStrictEqual((await cv.load()).ids, ids, 'installed legacy pairs remain readable');
  const before = snapshot();
  behavior = 'cancel';
  assert.strictEqual((await build()).phase, 'cancelled');
  assert(calls < 12, 'cancel interrupts a full rebuild before its queue completes');
  assert.deepStrictEqual(snapshot(), before);
  behavior = 'fail';
  assert.strictEqual((await build()).phase, 'error');
  assert.deepStrictEqual(snapshot(), before);
  behavior = 'init-fail';
  const failedInit = await build();
  assert.strictEqual(failedInit.phase, 'error');
  assert.match(failedInit.message, /initialize milo\.onnx: invalid model protobuf.*catalog unchanged/);
  assert.deepStrictEqual(snapshot(), before, 'initialization failure preserves the published catalog');
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
  const backPng = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#fff' } }).png().toBuffer();
  const backImage = `data:image/png;base64,${backPng.toString('base64')}`;
  const backId = `${ids[0]}_back`;
  await db.run(`UPDATE card_cache SET image_url_back = ?, set_id = 'mtg-dfc' WHERE id = ?`, [backImage, ids[0]]);
  assert.deepStrictEqual((await catalog.setCounts('mtg')).sets.dfc, { cached: 1, embedded: 0 },
    'legacy front-only coverage must flag the missing reverse');
  behavior = 'faces';
  assert.strictEqual((await build({ sets: ['DFC'] })).phase, 'done');
  assert.strictEqual(calls, 1, 'adding a native reverse reuses the unchanged front');
  const faces = readCatalog(metaFile);
  assert.deepStrictEqual(faces.meta.ids.slice().sort(), [...ids, backId].sort());
  assert.strictEqual(faces.meta.srcs[backId], backImage);
  const reverseIndex = faces.meta.ids.indexOf(backId);
  assert.strictEqual(faces.bin.readFloatLE(reverseIndex * 8 + 4), 1);
  assert.strictEqual((await catalog.list())[0].built.rows, 12, 'coverage counts printings, not faces');
  assert.deepStrictEqual((await catalog.setCounts('mtg')).sets.dfc, { cached: 1, embedded: 1 });
  for (const face of [png, backPng]) {
    const match = await cv.match(face, 'mtg', 8, { cropped: true, sets: ['dfc'] });
    assert.strictEqual(match.candidates.length, 1, 'both faces deduplicate to one printing');
    assert.strictEqual(match.candidates[0].cardId, ids[0]);
    assert.strictEqual(match.candidates[0].score, 1);
    assert.strictEqual(match.context.setFallback, false, 'reverse IDs retain the base printing set');
    const scored = await cv.scoreCards(face, 'mtg', [{ id: ids[1] }, { id: ids[0] }], { cropped: true });
    assert.strictEqual(scored.find(card => card.id === ids[0]).score, 1);
  }
  const tokens = await cv.match(png, 'mtg', 12, { cropped: true, sets: ['tst'] });
  assert.ok([ids[1], ids[2]].every(id => tokens.candidates.some(card => card.cardId === id)),
    'owned paired token faces retain their separate provider identities');
  assert.strictEqual((await build({ sets: ['tst'] })).phase, 'done');
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(readCatalog(metaFile).meta.srcs, faces.meta.srcs, 'another set preserves both face sources');
  assert.deepStrictEqual(readCatalog(metaFile).meta.ids.slice().sort(), faces.meta.ids.slice().sort(),
    'another set carries both native face vectors forward');
  assert.strictEqual((await build({ sets: ['mtg-dfc'] })).phase, 'done');
  assert.strictEqual(calls, 0, 'scoped resume reuses both native faces');
  await db.run('UPDATE card_cache SET image_url_back = ? WHERE id = ?', [image, ids[0]]);
  assert.strictEqual((await build({ sets: ['dfc'] })).phase, 'done');
  assert.strictEqual(calls, 1, 'only changed reverse artwork is re-embedded');
  assert.strictEqual(readCatalog(metaFile).meta.srcs[backId], image);
  await db.run('UPDATE card_cache SET image_url_back = NULL WHERE id = ?', [ids[0]]);
  assert.strictEqual((await build({ sets: ['dfc'] })).phase, 'done');
  assert.strictEqual(readCatalog(metaFile).meta.ids.includes(backId), false, 'removed native faces are not carried forward');
  await db.run('UPDATE card_cache SET image_url_back = ? WHERE id = ?', [backImage, ids[0]]);
  assert.strictEqual((await build()).phase, 'done');
  assert.strictEqual(calls, 1, 'full resume restores the reverse without rebuilding unchanged fronts');
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
  fs.writeFileSync(preload, `const ort = require(${JSON.stringify(require.resolve('onnxruntime-node'))}); let n = 0; ort.InferenceSession.create = async () => ({ run: async () => ({ embedding: { data: new Float32Array(n++ % 2 ? [0, 1] : [1, 0]) } }), release: async () => {} });`);
  const script = path.resolve(__dirname, '../scripts/build-cv-catalog.mjs');
  const cli = args => spawnSync(process.execPath, ['--require', preload, script, ...args], { env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.notStrictEqual(cli(['--limit', '1']).status, 0, 'limited build needs explicit isolated output');
  assert.notStrictEqual(cli(['--limit', '1', '--output', metaFile]).status, 0);
  const output = path.join(dir, 'experiment.json');
  let result = cli(['--limit', '1', '--views', '1', '--concurrency', '1', '--output', output]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(readCatalog(output).meta.ids.slice().sort(), [ids[0], backId].sort(),
    'experimental printing limits include both native faces');
  assert.strictEqual(readCatalog(output).meta.srcs[backId], backImage);
  result = cli(['--limit', '1', '--views', '2', '--concurrency', '1', '--output', output]);
  assert.strictEqual(result.status, 0, result.stderr);
  const experiment = readCatalog(output);
  assert(Math.abs(experiment.bin.readFloatLE(4) - Math.SQRT1_2) < 1e-6, 'changed views re-embed rather than reuse old vectors');
  assert.deepStrictEqual(snapshot(), stable, 'experiments never replace production');

  await cv.load();
  const read = fs.readFileSync;
  let metadataReads = 0;
  fs.readFileSync = (file, ...args) => {
    if (file === metaFile) metadataReads++;
    return read(file, ...args);
  };
  try {
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(cv.isBuilt(), true);
      await cv.load();
    }
    assert.strictEqual(metadataReads, 0, 'warm availability and loads do not parse the manifest again');
    const external = spawnSync(process.execPath, ['-e', `
      const { publishCatalog } = require(${JSON.stringify(require.resolve('../src/utils/localCatalog'))});
      publishCatalog(${JSON.stringify(metaFile)}, { dim: 2, ids: ['mtg-external'] }, [new Float32Array([0, 1])]);
    `], { encoding: 'utf8' });
    assert.strictEqual(external.status, 0, external.stderr);
    const replaced = await cv.load();
    assert.deepStrictEqual(replaced.ids, ['mtg-external'], 'out-of-process publication refreshes a warm catalog');
    assert.deepStrictEqual(Array.from(replaced.cat), [0, 1]);
    const readsAfterReplacement = metadataReads;
    await cv.load();
    assert.strictEqual(metadataReads, readsAfterReplacement, 'replacement is cached after its first load');
  } finally {
    fs.readFileSync = read;
  }
  console.log('catalogsafety.test.js: publication faults, cancellation, failed cache/inference, legacy loading, reuse and isolated multi-view CLI passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  ort.InferenceSession.create = create;
  api.client.get = get;
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});
