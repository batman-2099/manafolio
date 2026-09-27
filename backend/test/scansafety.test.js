const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-scansafety-'));
process.env.DB_PATH = path.join(dir, 'scan.db');
process.env.CV_MODEL_DIR = dir;

(async () => {
  const db = require('../src/db');
  await db.initDb();
  const cards = [
    { id: 'mtg-00000000-0000-0000-0000-000000000001', name: 'Lightning Bolt', set_id: 'neo', number: '007a', language: 'English' },
    { id: 'mtg-00000000-0000-0000-0000-000000000002', name: 'Lightning Bolt', set_id: 'm21', number: '42', language: 'English' },
    { id: 'mtg-00000000-0000-0000-0000-000000000003', name: 'Different Card', set_id: 'neo', number: '8', language: 'English' },
  ];
  for (const card of cards) {
    await db.run(`INSERT INTO card_cache (id, name, set_id, number, language, game, image_url) VALUES (?, ?, ?, ?, ?, 'mtg', 'https://example.test/card.jpg')`,
      [card.id, card.name, card.set_id, card.number, card.language]);
  }

  // Real matching/scoping code with deterministic model outputs and an isolated
  // three-row catalog. No installed model, catalog, database or network is used.
  const ort = require('onnxruntime-node');
  ort.InferenceSession.create = async () => ({ run: async () => ({ embedding: { data: new Float32Array([1, 0]) } }) });
  fs.writeFileSync(path.join(dir, 'cornelius.onnx'), 'fixture');
  fs.writeFileSync(path.join(dir, 'milo.onnx'), 'fixture');
  fs.writeFileSync(path.join(dir, 'milo-mtg-local.json'), JSON.stringify({ dim: 2, ids: cards.map(card => card.id) }));
  fs.writeFileSync(path.join(dir, 'milo-mtg-local.bin'), Buffer.from(new Float32Array([0.94, 0, 0.88, 0, 0.1, 0]).buffer));
  const cvScan = require('../src/cvScan');
  assert.throws(() => cvScan.isBuilt('unsupported'), /Unsupported game/);
  assert.throws(() => cvScan.builtLangs('unsupported'), /Unsupported game/);
  assert.throws(() => cvScan.reload('unsupported'), /Unsupported game/);
  await assert.rejects(cvScan.load('unsupported'), /Unsupported game/);
  await assert.rejects(cvScan.loadAll('unsupported'), /Unsupported game/);
  await assert.rejects(cvScan.match(null, 'unsupported'), /Unsupported game/);
  await assert.rejects(cvScan.scoreCards(null, 'unsupported', []), /Unsupported game/);
  const rgb = Buffer.alloc(448 * 448 * 3);
  for (let y = 0; y < 448; y++) {
    for (let x = 0; x < 448; x++) {
      const value = ((x >> 2) + (y >> 2)) % 2 ? 190 : 45;
      rgb.fill(value, (y * 448 + x) * 3, (y * 448 + x) * 3 + 3);
    }
  }
  const image = await sharp(rgb, { raw: { width: 448, height: 448, channels: 3 } }).png().toBuffer();
  assert.deepStrictEqual(await cvScan.imageQuality(rgb), { blurry: false, glare: false });
  const blurred = await sharp(rgb, { raw: { width: 448, height: 448, channels: 3 } }).blur(8).raw().toBuffer();
  assert.strictEqual((await cvScan.imageQuality(blurred)).blurry, true);
  const glared = Buffer.from(rgb);
  for (let y = 100; y < 210; y++) glared.fill(255, (y * 448 + 150) * 3, (y * 448 + 280) * 3);
  assert.strictEqual((await cvScan.imageQuality(glared)).glare, true);

  const scoped = await cvScan.match(image, 'mtg', 8, { cropped: true, sets: ['mtg-neo'] });
  assert.deepStrictEqual(scoped.candidates.map(c => c.cardId), [cards[0].id, cards[2].id]);
  assert.strictEqual(scoped.context.setFallback, false);
  const fallback = await cvScan.match(image, 'mtg', 8, { cropped: true, sets: ['missing'] });
  assert.strictEqual(fallback.context.setFallback, true);
  assert.strictEqual(fallback.candidates[0].cardId, cards[0].id);

  const scanOcr = require('../src/utils/scanOcr');
  let evidence = { status: 'unreadable' };
  scanOcr.readPrinting = async () => {
    if (evidence instanceof Error) throw evidence;
    return { ...evidence };
  };
  const router = require('../src/routes/collection');
  const route = router.stack.find(layer => layer.route?.path === '/scan-match').route;
  const handler = route.stack[route.stack.length - 1].handle;
  let match = scoped;
  cvScan.match = async () => structuredClone(match);
  const candidate = (index, score) => ({ cardId: cards[index].id, score });
  const clean = candidates => ({
    candidates, verified: false, detected: true, notInCatalog: false,
    quality: { blurry: false, glare: false }, context: { setFallback: false, languageFallback: false },
  });
  const scan = async (extra = {}) => {
    let body, status = 200;
    await handler({ body: { image: image.toString('base64'), cropped: true, ...extra }, user: {}, query: {} },
      { status(code) { status = code; return this; }, json(value) { body = value; } });
    assert.strictEqual(status, 200, JSON.stringify(body));
    return body;
  };

  match = clean([candidate(0, 0.94), candidate(2, 0.3)]);
  assert.strictEqual((await scan()).safety.autoAddSafe, true, 'unreadable legacy footer alone must not reject an unambiguous card');
  match = clean([candidate(0, 0.94), candidate(0, 0.93), candidate(2, 0.92)]);
  assert.ok((await scan()).safety.reasons.includes('ambiguous_printing'), 'distinct third candidate must block even with a different name');
  match = clean([candidate(0, 0.94), candidate(1, 0.92)]);
  evidence = { status: 'unreadable', number: '42', confidence: 0.9 };
  assert.strictEqual((await scan()).safety.autoAddSafe, false, 'number alone cannot break a printing tie');
  evidence = { status: 'read', setCode: 'm21', number: '42', confidence: 0.95 };
  let answer = await scan();
  assert.strictEqual(answer.safety.autoAddSafe, true);
  assert.strictEqual(answer.safety.ocr.status, 'matched');
  assert.strictEqual(answer.candidates[0].card.id, cards[1].id);
  assert.strictEqual(answer.alternatives[0].card.id, cards[0].id);

  evidence = { status: 'read', setCode: 'neo', number: '7a', confidence: 0.95 };
  answer = await scan();
  assert.strictEqual(answer.safety.ocr.status, 'matched', 'collector leading zeros normalize without losing suffix');
  evidence = { status: 'read', setCode: 'neo', number: '7', confidence: 0.95 };
  assert.ok((await scan()).safety.reasons.includes('ocr_conflict'), 'collector suffixes distinguish printings');

  evidence = { status: 'read', setCode: 'm21', number: '42', confidence: 0.95 };
  match = clean([candidate(0, 0.94), candidate(1, 0.4)]);
  answer = await scan();
  assert.strictEqual(answer.safety.ocr.status, 'conflict', 'OCR cannot promote a visually unrelated candidate');
  assert.strictEqual(answer.candidates[0].card.id, cards[0].id);
  match = clean([candidate(0, 0.94)]);
  answer = await scan({ set: 'neo' });
  assert.strictEqual(answer.safety.autoAddSafe, false, 'set preference must not override conflicting OCR');
  assert.ok(answer.candidates.some(c => c.card.id === cards[1].id), 'cached OCR printing remains available for manual review');

  evidence = { status: 'unreadable' };
  match = fallback;
  answer = await scan({ set: 'missing' });
  assert.ok(answer.safety.reasons.includes('set_fallback'));
  match = clean([candidate(0, 0.94)]);
  match.notInCatalog = true;
  assert.ok((await scan()).safety.reasons.includes('not_in_catalog'));
  match = clean([candidate(0, 0.54)]);
  assert.ok((await scan()).safety.reasons.includes('low_confidence'));
  match = clean([candidate(0, 0.94)]);
  match.quality = { blurry: true, glare: true };
  assert.deepStrictEqual((await scan()).safety.reasons, ['blur', 'glare']);
  match = clean([candidate(0, 0.94)]);
  for (const status of ['unavailable', 'error']) {
    evidence = { status };
    assert.ok((await scan()).safety.reasons.includes(`ocr_${status}`));
  }
  evidence = new Error('OCR process failed');
  assert.ok((await scan()).safety.reasons.includes('ocr_error'));

  // A cached same-art printing need not appear in the model's top K to be a tie.
  const sqlite3 = require('sqlite3');
  const bulk = new sqlite3.Database(`${process.env.DB_PATH}.scryfall-bulk.sqlite`);
  const sql = (method, ...args) => new Promise((resolve, reject) => bulk[method](...args, error => error ? reject(error) : resolve()));
  await sql('exec', `CREATE TABLE metadata (id INTEGER PRIMARY KEY, updated_at TEXT, card_count INTEGER);
    INSERT INTO metadata VALUES (1, '2026-01-01T00:00:00Z', 2);
    CREATE TABLE cards (id TEXT PRIMARY KEY, raw TEXT);
    CREATE TABLE names (name TEXT, card_id TEXT);`);
  for (const card of cards.slice(0, 2)) {
    const raw = { object: 'card', id: card.id.slice(4), name: card.name, set: card.set_id, collector_number: card.number, lang: 'en', illustration_id: 'same-art' };
    await sql('run', 'INSERT INTO cards VALUES (?, ?)', [raw.id, JSON.stringify(raw)]);
    await sql('run', 'INSERT INTO names VALUES (?, ?)', [raw.name.toLowerCase(), raw.id]);
  }
  await sql('close');
  evidence = { status: 'unreadable' };
  answer = await scan();
  assert.ok(answer.safety.reasons.includes('ambiguous_printing'));
  evidence = { status: 'read', setCode: 'neo', number: '7a', confidence: 0.95 };
  assert.strictEqual((await scan()).safety.autoAddSafe, true, 'exact OCR resolves cached same-art reprints');
  evidence = { status: 'unreadable' };
  assert.strictEqual((await scan({ set: 'neo' })).safety.autoAddSafe, true, 'explicit set can exclude other-set cached reprints');

  cvScan.isBuilt = () => false;
  let unavailable;
  await handler({ body: { image: image.toString('base64') } },
    { status(code) { assert.strictEqual(code, 503); return this; }, json(value) { unavailable = value; } });
  assert.strictEqual(unavailable.notBuilt, true);
  console.log('scansafety.test.js: quality, scope, catalog, OCR and cached-artwork decisions passed');
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
})().catch(error => { console.error(error); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
