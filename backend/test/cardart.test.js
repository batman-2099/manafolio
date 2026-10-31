// Real server middleware and image normalization, with a temporary database and local provider fixtures.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const sqlite3 = require('sqlite3');
const { spawnServer, waitForServer, stopServer } = require('./e2e/server-helper');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-card-art-'));
  const dbPath = path.join(dir, 'test.db');
  const server = spawnServer(['-r', path.join(__dirname, 'e2e/scryfall-mock.js'), path.join(__dirname, '../src/server.js')], {
    env: {
      DB_PATH: dbPath, DEFAULT_ADMIN_PASSWORD: '', BACKUP_INTERVAL_HOURS: '0',
      OIDC_ENABLED: 'false', CATALOG_AUTO_UPDATE: '0', TRUST_PROXY: '',
      MOCK_SCRYFALL_ERROR: 'false', MOCK_SCRYFALL_DELAY: 'false',
    },
  });
  try {
    const base = `http://127.0.0.1:${await waitForServer(server)}`;
    const db = new sqlite3.Database(dbPath);
    try {
      await new Promise((resolve, reject) => db.run(
        'INSERT INTO card_cache (id, name) VALUES (?, ?)', ['upload-fixture', 'Upload fixture'],
        error => error ? reject(error) : resolve(),
      ));
    } finally {
      await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
    const post = (route, body, token) => fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const owner = await post('/api/auth/bootstrap', { password: 'upload-fixture-password' });
    assert.strictEqual(owner.status, 201);
    const { token } = await owner.json();
    const artPath = '/api/card-art/upload-fixture';

    const unauthorized = await fetch(`${base}${artPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    });
    assert.strictEqual(unauthorized.status, 401, 'auth runs before even malformed upload JSON is parsed');
    await unauthorized.text();

    const image = await sharp(crypto.randomBytes(768 * 768 * 3), {
      raw: { width: 768, height: 768, channels: 3 },
    }).png({ compressionLevel: 0 }).toBuffer();
    assert(image.length > 1024 * 1024 && image.length < 8 * 1024 * 1024);
    const upload = bytes => post(artPath, { image: `data:image/png;base64,${bytes.toString('base64')}` }, token);
    const accepted = await upload(image);
    assert.strictEqual(accepted.status, 200, await accepted.text());

    // Base64 plus JSON at the decoded limit must pass; re-encoding drops padding.
    const boundary = Buffer.alloc(8 * 1024 * 1024);
    image.copy(boundary);
    const atLimit = await upload(boundary);
    assert.strictEqual(atLimit.status, 200, await atLimit.text());
    const publicImage = await fetch(`${base}${artPath}.png`);
    assert.strictEqual(publicImage.status, 200, 'public shared views can still load art without a session');
    const saved = Buffer.from(await publicImage.arrayBuffer());
    assert.strictEqual((await sharp(saved).metadata()).width, 745, 'uploads still resize and re-encode');
    assert(saved.length < boundary.length);
    const index = await fetch(`${base}/api/card-art/index`);
    assert.strictEqual(index.status, 200);
    assert((await index.json()).ids.includes('upload-fixture'));

    const tooLarge = await upload(Buffer.alloc(8 * 1024 * 1024 + 1));
    assert.strictEqual(tooLarge.status, 400, 'decoded size guard rejects above 8 MiB');
    assert.strictEqual((await tooLarge.json()).message, 'Image too large');
    const unchanged = await fetch(`${base}${artPath}.png`);
    assert.deepStrictEqual(Buffer.from(await unchanged.arrayBuffer()), saved, 'rejected upload preserves previous art');
    const parserLimit = await post(artPath, { image: 'x'.repeat(12 * 1024 * 1024) }, token);
    assert.strictEqual(parserLimit.status, 413, 'upload JSON remains bounded');
    await parserLimit.text();
    for (const route of ['/api/auth/login', '/api/auth/native/exchange']) {
      const smallDefault = await post(route, { padding: 'x'.repeat(1024 * 1024) });
      assert.strictEqual(smallDefault.status, 413, `${route} retains the 1 MiB parser limit`);
      await smallDefault.text();
    }
    console.log('PASS: production art upload limits, authenticated parsing, normalization and public reads');
  } finally {
    await stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
