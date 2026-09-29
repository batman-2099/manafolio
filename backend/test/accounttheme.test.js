// Real auth routes and temporary SQLite: account themes survive login and stay isolated.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDb = path.join(os.tmpdir(), `manafolio-accounttheme-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
process.env.ALLOW_REGISTRATION = 'true';
delete process.env.DEFAULT_ADMIN_PASSWORD;
const db = require('../src/db');
const router = require('../src/routes/auth');
let server;
let base;

async function request(method, route, token, body) {
  const response = await fetch(`${base}/api/auth${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  // Upgrade an existing account from the schema before themes existed.
  await db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
    share_token TEXT UNIQUE NOT NULL, share_enabled INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES (?, ?, ?)`,
    ['alice', db.hashPassword('alice-password'), 'alice-share']);
  await db.initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const alice = await request('POST', '/login', null, { username: 'alice', password: 'alice-password' });
  assert.strictEqual(alice.status, 200);
  assert.strictEqual(alice.body.user.theme, 'dark', 'existing accounts migrate to dark');
  assert(!Object.hasOwn(alice.body.user, 'password_hash'));
  const bob = await request('POST', '/register', null, { username: 'bob', password: 'bob-password' });
  assert.strictEqual(bob.status, 201);
  assert.strictEqual(bob.body.user.theme, 'dark', 'new accounts do not inherit another account theme');
  const aliceToken = alice.body.token;
  const bobToken = bob.body.token;
  const bobId = (await db.get(`SELECT id FROM users WHERE username = 'bob'`)).id;

  assert.strictEqual((await request('PATCH', '/theme', null, { theme: 'jenny' })).status, 401);
  assert.deepStrictEqual(await request('PATCH', '/theme', aliceToken, { theme: 'jenny', user_id: bobId }),
    { status: 200, body: { theme: 'jenny' } });
  assert.strictEqual((await request('GET', '/me', bobToken)).body.user.theme, 'dark', 'client IDs cannot target another account');
  for (const theme of ['dark', 'jenny', 'mana-white', 'mana-blue', 'mana-black', 'mana-red', 'mana-green', 'mana-colorless']) {
    assert.deepStrictEqual(await request('PATCH', '/theme', bobToken, { theme }),
      { status: 200, body: { theme } });
    assert.strictEqual((await request('GET', '/me', bobToken)).body.user.theme, theme);
  }

  for (const theme of ['light', 'mtg', 'lcars', 'unknown', null, ['dark'], undefined]) {
    assert.strictEqual((await request('PATCH', '/theme', aliceToken, { theme })).status, 400);
  }
  assert.strictEqual((await request('GET', '/me', aliceToken)).body.user.theme, 'jenny', 'invalid saves leave the preference unchanged');
  const key = (await request('POST', '/api-key', aliceToken)).body.api_key;
  assert.strictEqual((await request('PATCH', '/theme', key, { theme: 'dark' })).status, 403);
  const apiProfile = await request('GET', '/me', key);
  assert.strictEqual(apiProfile.body.user.theme, 'jenny');
  assert(!Object.hasOwn(apiProfile.body.user, 'psa_api_token'), 'theme serialization must preserve API-key secret filtering');
  const settings = await request('PUT', '/settings', aliceToken, { share_enabled: true });
  assert.strictEqual(settings.body.user.theme, 'jenny', 'unrelated settings saves retain the theme in their user response');
  assert(!Object.hasOwn(settings.body.user, 'password_hash'));

  await request('POST', '/logout', aliceToken);
  const reloaded = await request('POST', '/login', null, { username: 'alice', password: 'alice-password' });
  assert.strictEqual(reloaded.body.user.theme, 'jenny', 'a new login restores the account preference');
  await db.initDb();
  assert.strictEqual((await request('GET', '/me', reloaded.body.token)).body.user.theme, 'jenny', 'startup migration preserves saved themes');
  assert.strictEqual((await request('GET', '/me', bobToken)).body.user.theme, 'mana-colorless', 'another account keeps its own preference');

  await db.run(`INSERT INTO card_cache (id, name, game) VALUES ('mtg-theme-sample', 'Theme migration sample', 'mtg')`);
  await db.run(`INSERT INTO collection (card_id, user_id, game, list_type, quantity) VALUES ('mtg-theme-sample', ?, 'mtg', 'arena', 3)`, [bobId]);
  await db.run(`UPDATE users SET theme = 'mtg' WHERE id = ?`, [bobId]);
  assert.strictEqual((await request('GET', '/me', bobToken)).body.user.theme, 'dark', 'profile serialization rejects retired saved themes');
  const legacyLogin = await request('POST', '/login', null, { username: 'bob', password: 'bob-password' });
  assert.strictEqual(legacyLogin.body.user.theme, 'dark', 'login serialization rejects retired saved themes');
  await db.initDb();
  assert.strictEqual((await db.get(`SELECT theme FROM users WHERE id = ?`, [bobId])).theme, 'dark', 'startup replaces retired preferences');
  assert.strictEqual((await request('GET', '/me', reloaded.body.token)).body.user.theme, 'jenny', 'retired-theme migration leaves valid preferences alone');
  assert.deepStrictEqual(await db.get(`SELECT c.game, c.list_type, c.quantity, cc.game AS cache_game FROM collection c JOIN card_cache cc ON cc.id = c.card_id WHERE c.user_id = ?`, [bobId]),
    { game: 'mtg', list_type: 'arena', quantity: 3, cache_game: 'mtg' }, 'theme migration must not relabel games or change inventory');
  console.log('PASS: theme migration, account isolation, invalid saves, and authenticated reload');
}

async function cleanup() {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(cleanup);
