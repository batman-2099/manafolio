// Run the real AppKit/WebKit window with isolated sample data; no browser mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

async function main() {
  const [bundle, home] = process.argv.slice(2).map(value => path.resolve(value));
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, PORT: '0', HTTPS_PORT: '', CATALOG_AUTO_UPDATE: '0', BACKUP_INTERVAL_HOURS: '0', DEFAULT_ADMIN_PASSWORD: 'Native-window-smoke-7291' };
  delete env.DB_PATH;
  delete env.CV_MODEL_DIR;
  execFileSync(path.join(bundle, 'Contents/MacOS/Manafolio'), [], { env, stdio: 'inherit', timeout: 120000 });
  const data = path.join(home, 'Library/Application Support/Manafolio');
  assert.equal(fs.readFileSync(path.join(data, 'smoke-export.txt'), 'utf8'), 'Manafolio export smoke');
  assert.deepEqual([...fs.readFileSync(path.join(data, 'wrapper.png')).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const port = fs.readFileSync(path.join(data, 'desktop.log'), 'utf8').match(/MANAFOLIO_READY:(\d+)/)?.[1];
  assert.ok(port, 'Server must report its actual listening port');
  await assert.rejects(fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) }), 'Quitting the native app must stop its server');
  console.log('PASS: Native app saved its export and screenshot, then stopped its owned server on quit.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
