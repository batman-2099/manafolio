// Real auth middleware, HTTP routes, and isolated SQLite: password changes revoke only other sessions.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-passwordsessions-'));
process.env.DB_PATH = path.join(directory, 'test.db');
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

async function snapshot() {
  return {
    users: await db.all('SELECT * FROM users ORDER BY id'),
    sessions: await db.all('SELECT * FROM sessions ORDER BY token')
  };
}

// Pause after real middleware authentication, before the route obtains its transaction lock.
async function pausedPasswordChange(token, body, whilePaused) {
  const original = db.withTransaction;
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  db.withTransaction = async callback => {
    enter();
    await released;
    return original(callback);
  };
  const pending = request('PUT', '/settings', token, body);
  try {
    await Promise.race([
      entered,
      pending.then(() => { throw new Error('Password change did not enter a transaction'); })
    ]);
    db.withTransaction = original;
    await whilePaused();
  } finally {
    db.withTransaction = original;
    release();
    await pending;
  }
  return pending;
}

async function main() {
  await db.initDb();
  const { lastID: alice } = await db.run(`INSERT INTO users (username, password_hash, share_token, api_key)
    VALUES ('alice', ?, 'alice-share', 'bnd_alice-test')`, [db.hashPassword('original-password')]);
  const { lastID: bob } = await db.run(`INSERT INTO users (username, password_hash, share_token)
    VALUES ('bob', ?, 'bob-share')`, [db.hashPassword('foreign-password')]);
  const currentToken = 'alice-current-session';
  const otherToken = 'alice-other-session';
  const foreignToken = 'bob-session';
  for (const [token, userId] of [[currentToken, alice], [otherToken, alice], [foreignToken, bob]]) {
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, '9999-12-31 23:59:59')`, [token, userId]);
  }
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;

  const initial = await snapshot();
  const settings = await request('PUT', '/settings', currentToken, {
    share_enabled: true, share_locations: true, regenerate_share_token: true, psa_api_token: '  provider-token  '
  });
  assert.strictEqual(settings.status, 200);
  assert.strictEqual(settings.body.user.share_enabled, 1);
  assert.strictEqual(settings.body.user.share_locations, 1);
  assert.strictEqual(settings.body.user.psa_api_token, 'provider-token');
  assert.notStrictEqual(settings.body.user.share_token, 'alice-share');
  const before = await snapshot();
  assert.strictEqual(before.users[0].password_hash, initial.users[0].password_hash);
  assert.deepStrictEqual(before.sessions, initial.sessions, 'unrelated settings do not revoke sessions');

  for (const password of [null, true, 12345678, {}, { length: 10 }, [], ['replacement-password'], '', 'short']) {
    assert.strictEqual((await request('PUT', '/settings', currentToken, {
      current_password: 'original-password', password, share_enabled: false
    })).status, 400);
    assert.deepStrictEqual(await snapshot(), before, 'invalid new passwords change neither settings nor sessions');
  }
  for (const current_password of [undefined, null, true, 12345678, {}, [], ['original-password'], '', 'wrong-password']) {
    assert.strictEqual((await request('PUT', '/settings', currentToken, {
      current_password, password: 'replacement-password', share_enabled: false
    })).status, 401);
    assert.deepStrictEqual(await snapshot(), before, 'incorrect or malformed current passwords change nothing');
  }
  assert.strictEqual((await request('PUT', '/settings', 'bnd_alice-test', {
    current_password: 'original-password', password: 'replacement-password'
  })).status, 403, 'read-only API keys cannot change passwords');
  assert.deepStrictEqual(await snapshot(), before);

  // FAIL preserves the trigger's deleted row until the enclosing transaction rolls back.
  await db.run(`CREATE TRIGGER reject_session_delete AFTER DELETE ON sessions
    WHEN OLD.user_id = ${alice} BEGIN SELECT RAISE(FAIL, 'injected session deletion failure'); END`);
  assert.strictEqual((await request('PUT', '/settings', currentToken, {
    current_password: 'original-password', password: 'replacement-password', share_enabled: false
  })).status, 500);
  assert.deepStrictEqual(await snapshot(), before, 'failed revocation rolls back the password and the deleted session');
  await db.run('DROP TRIGGER reject_session_delete');
  for (const token of [currentToken, otherToken, foreignToken]) {
    assert.strictEqual((await request('GET', '/me', token)).status, 200, 'all sessions survive a failed change');
  }

  const changed = await request('PUT', '/settings', currentToken, {
    current_password: 'original-password', password: 'replacement-password', user_id: bob
  });
  assert.strictEqual(changed.status, 200);
  assert.strictEqual(changed.body.message, 'Settings updated successfully');
  assert(!Object.hasOwn(changed.body.user, 'password_hash'));
  const after = await snapshot();
  assert.notStrictEqual(after.users[0].password_hash, before.users[0].password_hash);
  assert.deepStrictEqual({ ...after.users[0], password_hash: before.users[0].password_hash }, before.users[0],
    'password changes retain sharing, provider credentials, and API keys');
  assert.deepStrictEqual(after.users[1], before.users[1], 'another account is untouched');
  assert.deepStrictEqual(after.sessions, before.sessions.filter(session => session.token !== otherToken));
  assert.strictEqual((await request('GET', '/me', currentToken)).status, 200);
  assert.strictEqual((await request('GET', '/me', otherToken)).status, 401);
  assert.strictEqual((await request('GET', '/me', foreignToken)).status, 200);
  assert.strictEqual((await request('GET', '/me', 'bnd_alice-test')).status, 200, 'API keys remain valid');
  assert.strictEqual((await request('POST', '/login', null, { username: 'alice', password: 'original-password' })).status, 401);
  const newLogin = await request('POST', '/login', null, { username: 'alice', password: 'replacement-password' });
  assert.strictEqual(newLogin.status, 200);
  assert.strictEqual((await request('GET', '/me', newLogin.body.token)).status, 200);

  let winnerState;
  const stalePassword = await pausedPasswordChange(currentToken, {
    current_password: 'replacement-password', password: 'stale-password-change'
  }, async () => {
    assert.strictEqual((await request('PUT', '/settings', currentToken, {
      current_password: 'replacement-password', password: 'winning-password'
    })).status, 200);
    winnerState = await snapshot();
  });
  assert.strictEqual(stalePassword.status, 401, 'a queued request must recheck the password inside its transaction');
  assert.deepStrictEqual(await snapshot(), winnerState);
  assert.strictEqual((await request('GET', '/me', newLogin.body.token)).status, 401);

  const concurrentLogin = await request('POST', '/login', null, { username: 'alice', password: 'winning-password' });
  assert.strictEqual(concurrentLogin.status, 200);
  const revokedSession = await pausedPasswordChange(concurrentLogin.body.token, {
    current_password: 'winning-password', password: 'revoked-session-password'
  }, async () => {
    // Keeping the password value unchanged makes the session recheck independently necessary.
    assert.strictEqual((await request('PUT', '/settings', currentToken, {
      current_password: 'winning-password', password: 'winning-password'
    })).status, 200);
    winnerState = await snapshot();
  });
  assert.strictEqual(revokedSession.status, 401, 'a request authenticated before revocation cannot change the password');
  assert.deepStrictEqual(await snapshot(), winnerState, 'a revoked request cannot delete the surviving session');
  assert.strictEqual((await request('GET', '/me', concurrentLogin.body.token)).status, 401);
  assert.strictEqual((await request('GET', '/me', currentToken)).status, 200);
  assert.strictEqual((await request('GET', '/me', foreignToken)).status, 200);

  const expiredSession = await pausedPasswordChange(currentToken, {
    current_password: 'winning-password', password: 'expired-session-password'
  }, async () => {
    await db.run(`UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE token = ?`, [currentToken]);
    winnerState = await snapshot();
  });
  assert.strictEqual(expiredSession.status, 401, 'session expiry is also rechecked inside the transaction');
  assert.deepStrictEqual(await snapshot(), winnerState);
  assert.strictEqual((await request('GET', '/me', foreignToken)).status, 200);
  assert.strictEqual((await request('GET', '/me', 'bnd_alice-test')).status, 200);
  console.log('PASS: own password validation, atomic session revocation, rollback, and queued-request protection');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});
