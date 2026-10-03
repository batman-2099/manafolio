const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-request-types-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'request-types-password';
process.env.ALLOW_REGISTRATION = 'true';
const db = require('../src/db');
const { generateSession } = require('../src/utils/authHelpers');
const { authenticateToken } = require('../src/middleware/auth');
let server;

async function main() {
  await db.initDb();
  const owner = await db.get("SELECT id FROM users WHERE username = 'admin'");
  const token = await generateSession(owner.id);
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
  app.use('/api', authenticateToken, require('../src/routes/notes'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const request = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000)
    });
    return { status: response.status, body: await response.json() };
  };
  const usersBefore = await db.all('SELECT * FROM users');
  for (const route of ['/auth/login', '/auth/register', '/admin/users']) {
    for (const body of [{ username: {}, password: 'valid-password' }, { username: 'sample', password: 12345678 }, { username: ['sample'], password: 'valid-password' }, { username: '   ', password: 'valid-password' }]) {
      assert.strictEqual((await request('POST', route, body)).status, 400, `${route} rejects non-string/empty credentials`);
    }
  }
  assert.strictEqual((await request('POST', '/auth/bootstrap', { password: {} })).status, 400);
  assert.deepStrictEqual(await db.all('SELECT * FROM users'), usersBefore, 'invalid credentials do not create or modify accounts');
  const login = await request('POST', '/auth/login', { username: ' ADMIN ', password: 'request-types-password' });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.user.username, 'admin', 'valid normalized login remains available after malformed requests');

  const created = await request('POST', '/notes', { title: ' Sample ', body: 'Keep this note' });
  assert.strictEqual(created.status, 201);
  const note = created.body.note;
  assert.strictEqual(note.title, 'Sample');
  for (const body of [{ title: null }, { title: 7 }, { body: {} }, { body: ['text'] }]) {
    assert.strictEqual((await request('POST', '/notes', body)).status, 400);
    assert.strictEqual((await request('PUT', `/notes/${note.id}`, body)).status, 400);
  }
  assert.deepStrictEqual(await db.all('SELECT * FROM notes'), [note], 'invalid note fields leave existing notes unchanged');
  assert.strictEqual((await request('PUT', `/notes/${note.id}`, { body: 'Updated text' })).status, 200);
  assert.strictEqual((await db.get('SELECT body FROM notes WHERE id = ?', [note.id])).body, 'Updated text');
  console.log('requesttypes.test.js passed: malformed auth/admin/note fields rejected; valid login and note edits preserved');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});
