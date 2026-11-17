// Backups: snapshot, prune to BACKUP_KEEP_LAST, and the due check behind auto-backup.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-backup-'));
process.env.DB_PATH = path.join(directory, 'test.db');
process.env.BACKUP_KEEP_LAST = '2';
const db = require('../src/db');
const backup = require('../src/backup');

async function main() {
  await db.initDb();
  assert.deepStrictEqual(backup.listBackups(), []);
  const first = await backup.backupIfDue(24);
  assert.ok(first.size > 0);
  assert.strictEqual(path.dirname(path.join(backup.BACKUP_DIR, first.file)), path.join(directory, 'backups'));
  assert.strictEqual(await backup.backupIfDue(24), null, 'a recent backup is not repeated, whatever the uptime');
  assert.strictEqual(backup.listBackups().length, 1);

  // An old newest backup is due again; pruning keeps only the newest two.
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(path.join(backup.BACKUP_DIR, first.file), old, old);
  const second = await backup.backupIfDue(24);
  assert.ok(second && second.file !== first.file);
  await new Promise(resolve => setTimeout(resolve, 5));
  const third = await backup.createBackup();
  assert.deepStrictEqual(backup.listBackups().map(b => b.file), [third.file, second.file]);
  console.log('backup.test.js: snapshot, due check and pruning passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});
