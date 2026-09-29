const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const express = require('express');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-admin-lifecycle-'));
  process.env.DB_PATH = path.join(directory, 'test.db');
  process.env.DEFAULT_ADMIN_PASSWORD = 'admin-lifecycle-password';
  const db = require('../src/db');
  const codex = require('../src/codexDeckClient');
  const { generateSession, verifyPassword } = require('../src/utils/authHelpers');
  const spawn = childProcess.spawn;
  const rm = fs.rm;
  let server;
  try {
    await db.initDb();
    const owner = await db.get("SELECT * FROM users WHERE username = 'admin'");
    const member = await db.run(`INSERT INTO users (username, password_hash, role, share_token)
      VALUES ('member', ?, 'member', 'member-share')`, [db.hashPassword('member-password')]);
    const memberId = member.lastID;
    const token = await generateSession(owner.id);
    await generateSession(memberId);
    const app = express();
    app.use(express.json());
    app.use('/api/admin', require('../src/routes/admin'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const request = (method, id, body) => fetch(`http://127.0.0.1:${server.address().port}/api/admin/users/${id}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const before = await db.get('SELECT * FROM users WHERE id = ?', [memberId]);
    assert.strictEqual((await request('PUT', memberId, { password: 'replacement-password', role: 'invalid' })).status, 400);
    assert.deepStrictEqual(await db.get('SELECT * FROM users WHERE id = ?', [memberId]), before);
    assert.strictEqual((await request('PUT', owner.id, { password: 'replacement-password', role: 'member' })).status, 400);
    assert.deepStrictEqual(await db.get('SELECT * FROM users WHERE id = ?', [owner.id]), owner,
      'a refused self-demotion must not change the password');
    for (const password of [null, 12345678, {}, 'short']) {
      assert.strictEqual((await request('PUT', memberId, { password, role: 'admin' })).status, 400);
      assert.deepStrictEqual(await db.get('SELECT * FROM users WHERE id = ?', [memberId]), before);
    }
    await db.run(`CREATE TRIGGER reject_role BEFORE UPDATE OF role ON users
      BEGIN SELECT RAISE(ABORT, 'role storage failure fixture'); END`);
    assert.strictEqual((await request('PUT', memberId, { password: 'replacement-password', role: 'admin' })).status, 500);
    assert.deepStrictEqual(await db.get('SELECT * FROM users WHERE id = ?', [memberId]), before,
      'a failed role write must not leave a changed password');
    await db.run('DROP TRIGGER reject_role');
    assert.strictEqual((await request('PUT', memberId, { password: 'replacement-password', role: 'admin' })).status, 200);
    const updated = await db.get('SELECT * FROM users WHERE id = ?', [memberId]);
    assert.strictEqual(updated.role, 'admin');
    assert.strictEqual(verifyPassword('replacement-password', updated.password_hash), true);
    assert.strictEqual(verifyPassword('member-password', updated.password_hash), false);

    const home = path.join(directory, 'codex', String(memberId));
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, 'auth.json'), '{"fixture":"not-a-real-token"}');
    childProcess.spawn = () => { throw new Error('Administrative deletion must not start Codex'); };
    fs.rm = async (target, options) => {
      if (target === home) throw Object.assign(new Error('credential removal failure fixture'), { code: 'EACCES' });
      return rm(target, options);
    };
    assert.strictEqual((await request('DELETE', memberId)).status, 500, 'failed credential removal must not report successful deletion');
    assert.deepStrictEqual(await db.get('SELECT * FROM users WHERE id = ?', [memberId]), updated);
    assert.ok(await db.get('SELECT user_id FROM sessions WHERE user_id = ?', [memberId]));
    assert.strictEqual(await fs.readFile(path.join(home, 'auth.json'), 'utf8'), '{"fixture":"not-a-real-token"}');
    fs.rm = rm;
    assert.strictEqual((await request('DELETE', memberId)).status, 200);
    assert.strictEqual(await db.get('SELECT id FROM users WHERE id = ?', [memberId]), undefined);
    assert.strictEqual(await db.get('SELECT user_id FROM sessions WHERE user_id = ?', [memberId]), undefined);
    await assert.rejects(fs.stat(home), error => error.code === 'ENOENT');
    await assert.rejects(codex.account(memberId), error => error.status === 410,
      'a request authenticated before deletion cannot recreate account storage');
    assert.deepStrictEqual(await db.get('SELECT * FROM users WHERE id = ?', [owner.id]), owner);
    console.log('Admin update atomicity and local-only Codex account disposal checks passed.');
  } finally {
    childProcess.spawn = spawn;
    fs.rm = rm;
    await codex.shutdown();
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
