// Smoke tests for the security-critical auth + per-user isolation paths.
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const express = require('express');

const tmpDb = path.join(os.tmpdir(), `manafolio-auth-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
// initDb only seeds the 'admin' user when this is set — the wizard creates the
// owner account otherwise, and these tests want a user id 1 to exist.
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';


const db = require('../src/db');
const { verifyPassword, generateSession } = require('../src/utils/authHelpers');
const { authenticateToken } = require('../src/middleware/auth');

function cleanup() {
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

function testPasswordHashing() {
  const hash = db.hashPassword('correct horse battery');
  assert(verifyPassword('correct horse battery', hash), 'correct password must verify');
  assert(!verifyPassword('wrong password', hash), 'wrong password must not verify');

  // Legacy 2-part (salt:hash, implied 10000 iterations) hashes must still verify.
  const salt = 'deadbeef';
  const legacyHex = crypto.pbkdf2Sync('legacy-pw', salt, 10000, 64, 'sha512').toString('hex');
  assert(verifyPassword('legacy-pw', `${salt}:${legacyHex}`), 'legacy 2-part hash must verify');
  assert(!verifyPassword('nope', `${salt}:${legacyHex}`), 'legacy hash must reject wrong password');

  // Malformed / empty stored hashes must return false, never throw.
  assert(!verifyPassword('x', ''), 'empty hash => false');
  assert(!verifyPassword('x', 'garbage'), 'unparseable hash => false');
  assert(!verifyPassword('x', 'a:b:c:d'), '4-part hash => false');

  console.log('PASS: password hashing round-trip, legacy format, and malformed input');
}

async function testCollectionIsolation() {
  const alice = 1; // default admin created by initDb
  const bob = (await db.run(
    `INSERT INTO users (username, password_hash, role, share_token, share_enabled) VALUES (?, ?, ?, ?, ?)`,
    ['bob', db.hashPassword('bobpassword'), 'member', crypto.randomBytes(8).toString('hex'), 0]
  )).lastID;

  await db.run(
    `INSERT OR REPLACE INTO card_cache (id, name, supertype, subtypes, types, rarity, set_id, set_name, number, image_url, price_trend)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['card-x', 'Llanowar Elves', 'Creature', '[]', '[]', 'Common', 's1', 'Set One', '1', '', 5]
  );

  // Alice owns 3 copies, Bob owns 1.
  for (let i = 0; i < 3; i++) {
    await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES (?, ?, ?)`, ['card-x', 1, alice]);
  }
  await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES (?, ?, ?)`, ['card-x', 1, bob]);

  const app = express();
  app.use('/api', authenticateToken, require('../src/routes/collection'));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const aliceToken = await generateSession(alice);
    const bobToken = await generateSession(bob);
    const request = (token, route = '/collection', method = 'GET') =>
      fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
        method, headers: { Authorization: `Bearer ${token}` }
      });
    const aliceResponse = await request(aliceToken);
    const bobResponse = await request(bobToken);
    assert.strictEqual(aliceResponse.status, 200);
    assert.strictEqual(bobResponse.status, 200);
    const aliceRows = await aliceResponse.json();
    const bobRows = await bobResponse.json();
    assert.strictEqual(aliceRows.length, 3);
    assert.strictEqual(bobRows.length, 1);
    const aliceIds = aliceRows.map(row => row.entry_id);
    assert(!bobRows.some(row => aliceIds.includes(row.entry_id)), 'collection reads cannot expose another account’s entries');
    assert.strictEqual((await request(bobToken, `/collection/${aliceIds[0]}`, 'DELETE')).status, 404);
    assert.deepStrictEqual(await (await request(aliceToken)).json(), aliceRows, 'a foreign delete leaves the owner’s collection unchanged');
    assert.strictEqual((await request(aliceToken, `/collection/${aliceIds[0]}`, 'DELETE')).status, 200);
    assert.deepStrictEqual((await (await request(aliceToken)).json()).map(row => row.entry_id),
      aliceIds.slice(1), 'the owner can still delete their own entry');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('PASS: real HTTP collection reads and deletes enforce account isolation');
}

async function main() {
  await db.initDb();
  testPasswordHashing();
  await testCollectionIsolation();
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch(err => { console.error('FAIL:', err.stack || err.message); cleanup(); process.exit(1); });
