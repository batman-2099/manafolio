// The owner account created by POST /api/auth/bootstrap has to inherit the rows a
// pre-multi-user database left behind (`user_id IS NULL`). initDb cannot do it —
// at that point there is no account to hand them to — so the bootstrap route calls
// db.adoptOrphanRows itself. Exercise the real public registration/bootstrap routes.
//
// Framework-free (node + assert), throwaway SQLite. Run via `npm test`.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const express = require('express');

const tmpDb = path.join(os.tmpdir(), `manafolio-bootstrap-test-${process.pid}.db`);
process.env.DB_PATH = tmpDb;
// Deliberately unset: this is the wizard path, where initDb leaves users empty.
delete process.env.DEFAULT_ADMIN_PASSWORD;
process.env.ALLOW_REGISTRATION = 'true';

const db = require('../src/db');
const router = require('../src/routes/auth');
let server;

function cleanup() {
  server?.closeAllConnections();
  server?.close();
  try { db.dbConnection.close(); } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
  }
}

async function main() {
  await db.initDb();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const post = async (route, body) => {
    const response = await fetch(`${base}/${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const password = 'a-long-enough-password';

  const users = await db.get(`SELECT COUNT(*) AS count FROM users`);
  assert.strictEqual(users.count, 0, 'no DEFAULT_ADMIN_PASSWORD => users table stays empty');

  const settings = await db.get(`SELECT setup_complete FROM app_settings WHERE id = 1`);
  assert.strictEqual(settings.setup_complete, 0, 'a new install has not completed the wizard');

  // Stand in for a database written before `user_id` existed.
  await db.run(`INSERT INTO card_cache (id, name) VALUES (?, ?)`, ['test-card-1', 'Test Card']);
  const loc = await db.run(`INSERT INTO locations (name, type, user_id) VALUES (?, ?, NULL)`, ['Old Binder', 'Binder']);
  await db.run(`INSERT INTO collection (card_id, quantity, user_id) VALUES (?, ?, NULL)`, ['test-card-1', 3]);

  const premature = await Promise.all(['member', 'admin'].map(username => post('register', { username, password })));
  assert(premature.every(result => result.status === 403), 'public registration cannot claim the first account, including admin');
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM users')).count, 0);
  assert.strictEqual((await db.get('SELECT COUNT(*) AS count FROM sessions')).count, 0);
  assert.strictEqual((await (await fetch(`${base}/config`)).json()).setupRequired, true);

  const racing = await Promise.all([
    post('bootstrap', { password }),
    post('bootstrap', { password }),
    post('register', { username: 'racing-member', password }),
  ]);
  assert.deepStrictEqual(racing.slice(0, 2).map(result => result.status).sort(), [201, 409], 'exactly one concurrent bootstrap wins');
  assert([201, 403].includes(racing[2].status), 'registration either follows the owner or is rejected');
  const winner = racing.find(result => result.status === 201 && result.body.user.role === 'admin').body;
  const owner = await db.get(
    'SELECT users.id, users.username, users.role FROM users JOIN sessions ON sessions.user_id = users.id WHERE sessions.token = ?',
    [winner.token]
  );
  assert(owner, 'bootstrap returns a session belonging to the created owner');
  assert.strictEqual(owner.username, winner.user.username);
  assert.strictEqual(owner.role, winner.user.role);
  const firstUser = await db.get('SELECT id, username, role FROM users ORDER BY id LIMIT 1');
  assert.strictEqual(firstUser.id, owner.id);
  assert.strictEqual(firstUser.username, 'admin');
  assert.strictEqual(firstUser.role, 'admin', 'registration can never win first-owner bootstrap');
  assert.strictEqual((await (await fetch(`${base}/config`)).json()).setupRequired, false);

  const registered = await post('register', { username: 'later-member', password });
  assert.strictEqual(registered.status, 201, 'registration works after owner creation');
  assert.strictEqual(registered.body.user.role, 'member');
  assert.match(registered.body.token, /^[a-f0-9]{64}$/);
  assert.strictEqual((await post('bootstrap', { password })).status, 409, 'setup stays closed');

  const orphanCards = await db.get(`SELECT COUNT(*) AS count FROM collection WHERE user_id IS NULL`);
  const orphanLocs = await db.get(`SELECT COUNT(*) AS count FROM locations WHERE user_id IS NULL`);
  assert.strictEqual(orphanCards.count, 0, 'orphan collection rows must be adopted');
  assert.strictEqual(orphanLocs.count, 0, 'orphan location rows must be adopted');

  const adopted = await db.get(`SELECT user_id FROM locations WHERE id = ?`, [loc.lastID]);
  assert.strictEqual(adopted.user_id, owner.id, 'rows go to the owner account, not some other id');

  // An install with existing locations does not get starter binders on top.
  await db.seedStarterLocations(owner.id);
  const locCount = await db.get(`SELECT COUNT(*) AS count FROM locations`);
  assert.strictEqual(locCount.count, 1, 'starter locations must not be added to a populated database');

  console.log('bootstrap owner adoption: OK');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch(err => { console.error(err); cleanup(); process.exit(1); });
