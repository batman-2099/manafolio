const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-backup-consistency-'));
process.env.DB_PATH = path.join(directory, 'test.db');
const db = require('../src/db');
let server;
let releaseRead;
const originalAll = db.all;

async function main() {
  await db.initDb();
  const owner = (await db.run("INSERT INTO users(username,password_hash,share_token) VALUES ('snapshot','unused','snapshot-share')")).lastID;
  const destination = (await db.run("INSERT INTO users(username,password_hash,share_token) VALUES ('restore','unused','restore-share')")).lastID;
  const unit = (await db.run("INSERT INTO storage_units(user_id,name,type) VALUES (?,'Sample shelf','Shelf')", [owner])).lastID;
  const location = (await db.run("INSERT INTO locations(user_id,name,type,storage_unit_id) VALUES (?,'Sample box','Box',?)", [owner, unit])).lastID;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: req.method === 'GET' ? owner : destination }; next(); });
  app.use('/api', require('../src/routes/importExport'));
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let reachedRead;
  const reached = new Promise(resolve => { reachedRead = resolve; });
  const resume = new Promise(resolve => { releaseRead = resolve; });
  let paused = false;
  db.all = async (sql, params) => {
    if (!paused && sql.startsWith('SELECT id, name, type, cover_card_id, cover_image FROM storage_units')) {
      paused = true;
      reachedRead();
      await resume;
    }
    return originalAll(sql, params);
  };
  const exporting = fetch(`${base}/export?format=backup`, { signal: AbortSignal.timeout(5000) });
  await reached;
  // Queue an independent request between the export's location and storage-unit reads.
  const deletion = db.run('DELETE FROM storage_units WHERE id = ?', [unit]);
  releaseRead();
  const response = await exporting;
  assert.strictEqual(response.status, 200);
  const backup = await response.json();
  await deletion;
  db.all = originalAll;
  assert.strictEqual(await db.get('SELECT id FROM storage_units WHERE id = ?', [unit]), undefined);
  assert.strictEqual(backup.locations.find(row => row.id === location).storage_unit_id, unit);
  assert.deepStrictEqual(backup.storage_units.map(row => row.id), [unit], 'backup references and units describe the same snapshot');
  const restored = await fetch(`${base}/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: 'backup', data: backup }), signal: AbortSignal.timeout(5000)
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(await restored.json()));
  const restoredLocation = await db.get('SELECT l.name, s.name AS unit FROM locations l JOIN storage_units s ON s.id=l.storage_unit_id WHERE l.user_id=?', [destination]);
  assert.deepStrictEqual(restoredLocation, { name: 'Sample box', unit: 'Sample shelf' });
  console.log('backupconsistency.test.js passed: concurrent unit deletion cannot produce an unrestorable snapshot');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  releaseRead?.();
  db.all = originalAll;
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});
