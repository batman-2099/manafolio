const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const image = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-linux-window-'));
  try {
    execFileSync(image, ['--appimage-extract'], { cwd: root, stdio: 'ignore' });
    const appDir = path.join(root, 'squashfs-root');
    const appPath = path.join(appDir, 'desktop/resources/app');
    const manifest = JSON.parse(await fs.readFile(path.join(appPath, 'package.json'), 'utf8'));
    manifest.main = 'smoke.cjs';
    await fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify(manifest));
    await fs.copyFile(path.resolve('desktop/electron/smoke.cjs'), path.join(appPath, 'smoke.cjs'));
    const data = path.join(root, 'data', 'manafolio');
    await fs.mkdir(data, { recursive: true });
    for (let run = 0; run < 2; run++) {
      await fs.rm(path.join(output, 'export.txt'), { force: true });
      await fs.writeFile(path.join(data, '.env'), `PORT=0\nHTTPS_PORT=\nCATALOG_AUTO_UPDATE=0\nBACKUP_INTERVAL_HOURS=0\n${run === 0 ? 'DEFAULT_ADMIN_PASSWORD=Linux-window-smoke-7291\n' : ''}`);
      const env = { ...process.env, HOME: root, XDG_DATA_HOME: path.dirname(data), XDG_CONFIG_HOME: path.join(root, 'config'), APPIMAGE: image, MANAFOLIO_SMOKE_OUTPUT: output };
      env.MANAFOLIO_SMOKE_SIGNAL = String(run);
      for (const key of ['PORT', 'HTTPS_PORT', 'DB_PATH', 'CV_MODEL_DIR', 'DEFAULT_ADMIN_PASSWORD', 'MANAFOLIO_MAC_APP', 'MANAFOLIO_WINDOWS_APP', 'ELECTRON_RUN_AS_NODE']) delete env[key];
      const child = spawn(path.join(appDir, 'AppRun'), [], { env, stdio: 'inherit', detached: true });
      const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 120000);
      let result;
      try { result = await once(child, 'exit'); } finally { clearTimeout(timer); }
      assert.equal(result[0], 0, `Desktop smoke failed: ${result}`);
      const port = (await fs.readFile(path.join(output, 'port'), 'utf8')).trim();
      await assert.rejects(fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(2000) }), 'Desktop quit must stop its owned server');
      assert.equal((await fs.readFile(path.join(data, 'manafolio.db'))).subarray(0, 15).toString(), 'SQLite format 3');
    }
    console.log('PASS: extracted AppImage preserves its owner/database across restart and stops the server on quit.');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
