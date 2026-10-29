const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-modelassets-'));
process.env.CV_MODEL_DIR = dir;
const assets = require('../src/utils/modelAssets');
const originalFetch = global.fetch;

(async () => {
  try {
    const asset = { name: 'download.onnx', repo: 'fixture/model', file: 'model.onnx', bytes: 8 };
    const dest = path.join(dir, asset.name);
    const installed = Buffer.from('previous installed model');
    fs.writeFileSync(dest, installed);
    const failures = [
      [() => ({ ok: false, status: 503 }), /503/],
      [() => ({ ok: true, body: Readable.from([Buffer.from('short')]) }), /expected 8/],
      [() => ({ ok: true, body: Readable.from((async function* () {
        yield Buffer.from('part');
        throw new Error('connection lost');
      })()) }), /connection lost/],
    ];
    for (const [response, error] of failures) {
      global.fetch = async () => response();
      await assert.rejects(assets.fetchAsset(asset), error);
      assert.deepStrictEqual(fs.readFileSync(dest), installed, 'failed download must preserve the installed model');
      assert.strictEqual(fs.existsSync(`${dest}.tmp`), false, 'failed download must remove its temporary file');
    }
    for (const chunks of [[Buffer.alloc(9)], [Buffer.alloc(4), Buffer.alloc(5), Buffer.alloc(2)]]) {
      const body = Readable.from(chunks);
      global.fetch = async () => ({ ok: true, body });
      const createWriteStream = fs.createWriteStream;
      let written = 0;
      fs.createWriteStream = (...args) => {
        const stream = createWriteStream(...args);
        const write = stream.write;
        stream.write = function (chunk, ...rest) {
          written += chunk.length;
          return write.call(this, chunk, ...rest);
        };
        return stream;
      };
      const progress = [];
      try {
        await assert.rejects(assets.fetchAsset(asset, got => progress.push(got)), /exceeded expected 8/);
      } finally {
        fs.createWriteStream = createWriteStream;
      }
      assert(written <= 4, 'the chunk crossing the limit must never reach the file stream');
      assert(progress.every(got => got <= asset.bytes), 'progress never exceeds the declared size');
      assert(body.destroyed, 'oversized response is closed');
      assert.deepStrictEqual(fs.readFileSync(dest), installed);
      assert.strictEqual(fs.existsSync(`${dest}.tmp`), false);
    }

    global.fetch = async () => ({ ok: true, body: Readable.from([Buffer.from('1234'), Buffer.from('5678')]) });
    await assets.fetchAsset(asset);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), '12345678', 'exact-size downloads still install');
    assert.strictEqual(fs.existsSync(`${dest}.tmp`), false);

    const [cornelius, milo] = assets.MODELS;
    const corneliusPath = path.join(dir, cornelius.name);
    const legacy = Buffer.alloc(4407545, 17);
    fs.writeFileSync(corneliusPath, legacy);
    fs.writeFileSync(path.join(dir, milo.name), Buffer.alloc(milo.bytes));
    global.fetch = async () => { throw new Error('admin must accept the installed legacy model'); };
    assert.strictEqual(assets.status().models.find(a => a.name === cornelius.name).present, true);
    assets.start('models');
    while (assets.state()) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(assets.lastResult().phase, 'done');
    assert.deepStrictEqual(fs.readFileSync(corneliusPath), legacy, 'admin must not replace a supported legacy model');

    const upgraded = Buffer.alloc(cornelius.bytes, 29);
    global.fetch = async url => {
      assert.ok(url.endsWith(`/${cornelius.file}`), 'only the legacy model needs downloading');
      return { ok: true, body: Readable.from((function* () {
        for (let offset = 0; offset < upgraded.length; offset += 65536) {
          yield upgraded.subarray(offset, offset + 65536);
        }
      })()) };
    };
    await import('../scripts/fetch-models.mjs');
    assert.deepStrictEqual(fs.readFileSync(corneliusPath), upgraded, 'CLI must replace the legacy model with the current exact-size download');
    assert.strictEqual(fs.existsSync(`${corneliusPath}.tmp`), false);
    console.log('Model asset download boundaries passed');
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
