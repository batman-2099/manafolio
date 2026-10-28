// Run only on an ephemeral GitHub-hosted Windows account: installer registration
// and shortcuts use that account; only the desktop app gets an isolated profile.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

// Must match desktop/windows/installer.iss.
const uninstallKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8B26A6D8-3DD2-4B60-91D2-1A823E1E2390}_is1';
function powershell(script, env = process.env) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; ${script}`],
    { env, windowsHide: true, encoding: 'utf8', timeout: 30000 }).trim();
}
function registration() {
  return JSON.parse(powershell(`$key = '${uninstallKey}'; $exists = Test-Path $key; $location = if ($exists) { (Get-ItemProperty $key).InstallLocation } else { '' }; @{ Installed = $exists; Location = $location; Programs = [Environment]::GetFolderPath('Programs') } | ConvertTo-Json -Compress`));
}
async function run(executable, args, env) {
  const child = spawn(executable, args, { env, windowsHide: true, stdio: 'inherit' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Never kill by image name: only this test's process tree.
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 }); } catch {}
  }, 120000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.ok(!timedOut, `${executable} timed out`);
    assert.equal(code, 0, `${executable} failed (${code}, ${signal})`);
  } finally { clearTimeout(timer); }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This smoke requires Windows');
  assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows',
    'Use an ephemeral GitHub-hosted Windows runner, never a personal or self-hosted account');
  assert.ok(process.argv[2] && process.argv[3], 'Usage: node backend/scripts/smoke-windows.js <installer.exe> <output-dir>');
  const installer = path.resolve(process.argv[2]);
  const output = path.resolve(process.argv[3]);
  await fs.access(installer);
  const before = registration();
  assert.equal(before.Installed, false, 'Refusing to replace an existing Manafolio installation');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'Manafolio Windows smoke ')));
  const install = path.join(root, 'Installed app with spaces');
  const home = path.join(root, 'User profile');
  const local = path.join(home, 'AppData', 'Local');
  const data = path.join(local, 'Manafolio');
  const group = `Manafolio smoke ${path.basename(root)}`;
  const shortcuts = path.join(before.Programs, group);
  const uninstaller = path.join(install, 'unins000.exe');
  const desktop = path.join(install, 'desktop', 'Manafolio.exe');
  const appPath = path.join(install, 'desktop', 'resources', 'app');
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: local, APPDATA: path.join(home, 'AppData', 'Roaming'), MANAFOLIO_SMOKE_INSTALL: install };
  for (const key of ['PORT', 'HTTPS_PORT', 'DB_PATH', 'CV_MODEL_DIR', 'DEFAULT_ADMIN_PASSWORD', 'MANAFOLIO_MAC_APP', 'MANAFOLIO_WINDOWS_APP', 'APPIMAGE', 'ELECTRON_RUN_AS_NODE', 'MANAFOLIO_SMOKE_SIGNAL']) delete env[key];
  const silent = ['/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
  const config = 'PORT=0\nHTTPS_PORT=\nCATALOG_AUTO_UPDATE=0\nBACKUP_INTERVAL_HOURS=0\n';
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(env.APPDATA, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  let installed = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const preserved = attempt ? await fs.readFile(path.join(data, 'manafolio.db')) : null;
      await run(installer, [...silent, `/DIR=${install}`, `/GROUP=${group}`, '/TASKS=', `/LOG=${path.join(output, `install-${attempt + 1}.log`)}`], process.env);
      installed = true;
      const current = registration();
      assert.equal(current.Installed, true);
      assert.equal(path.resolve(current.Location).toLowerCase(), install.toLowerCase());
      const shortcut = path.join(shortcuts, 'Manafolio.lnk');
      await fs.access(shortcut);
      const target = powershell("$shell = New-Object -ComObject WScript.Shell; $shell.CreateShortcut($env:MANAFOLIO_SMOKE_SHORTCUT).TargetPath", { ...env, MANAFOLIO_SMOKE_SHORTCUT: shortcut });
      assert.equal(target.toLowerCase(), desktop.toLowerCase());
      await assert.rejects(fs.access(path.join(appPath, 'smoke.cjs')), 'Smoke harness must never ship');
      if (preserved) assert.deepEqual(await fs.readFile(path.join(data, 'manafolio.db')), preserved, 'Upgrade must not change user data');

      const manifestPath = path.join(appPath, 'package.json');
      const originalManifest = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(originalManifest);
      manifest.main = 'smoke.cjs';
      await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await fs.copyFile(path.resolve('desktop/electron/smoke.cjs'), path.join(appPath, 'smoke.cjs'));
      const runOutput = path.join(output, `run-${attempt + 1}`);
      await fs.rm(runOutput, { recursive: true, force: true });
      await fs.mkdir(runOutput, { recursive: true });
      await fs.writeFile(path.join(data, '.env'), config + (attempt === 0 ? 'DEFAULT_ADMIN_PASSWORD=Windows-window-smoke-7291\n' : ''));
      await run(desktop, [], { ...env, MANAFOLIO_SMOKE_OUTPUT: runOutput, MANAFOLIO_SMOKE_INSTALLER: installer });
      // The shared harness asserts setupRequired=false on both launches: the
      // second run has no bootstrap password and must retain the existing owner.
      const port = (await fs.readFile(path.join(runOutput, 'port'), 'utf8')).trim();
      assert.match(port, /^\d+$/);
      await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }), 'Desktop quit must stop its owned server');
      assert.equal((await fs.readFile(path.join(data, 'manafolio.db'))).subarray(0, 16).toString(), 'SQLite format 3\0');
      assert.equal(await fs.readFile(path.join(runOutput, 'export.txt'), 'utf8'), 'Manafolio desktop export');
      await fs.writeFile(path.join(data, '.env'), config);
      await fs.writeFile(manifestPath, originalManifest);
      await fs.rm(path.join(appPath, 'smoke.cjs'));
    }
    const database = await fs.readFile(path.join(data, 'manafolio.db'));
    await run(uninstaller, [...silent, `/LOG=${path.join(output, 'uninstall.log')}`], process.env);
    installed = false;
    assert.equal(registration().Installed, false, 'Uninstall must remove its registration');
    await assert.rejects(fs.access(desktop), 'Uninstall must remove the desktop executable');
    await assert.rejects(fs.access(path.join(shortcuts, 'Manafolio.lnk')), 'Uninstall must remove its shortcut');
    assert.deepEqual(await fs.readFile(path.join(data, 'manafolio.db')), database, 'Uninstall must preserve the database');
    assert.equal(await fs.readFile(path.join(data, '.env'), 'utf8'), config, 'Uninstall must preserve configuration');
    console.log('PASS: installed Windows desktop renders, exports, retains its owner through upgrade, stops its server, and uninstalls without deleting user data.');
  } catch (error) {
    console.error(error);
    console.error(await fs.readFile(path.join(data, 'desktop.log'), 'utf8').catch(() => 'No desktop log was created.'));
    throw error;
  } finally {
    try {
      // Also catch a server orphaned by a failed harness. Exact paths confine
      // force-cleanup to the temporary installation, never another Manafolio.
      powershell("$paths = @((Join-Path $env:MANAFOLIO_SMOKE_INSTALL 'desktop\\Manafolio.exe'), (Join-Path $env:MANAFOLIO_SMOKE_INSTALL 'manafolio-server.exe')); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -in $paths } | ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }", env);
      if (installed || registration().Installed) await run(uninstaller, silent, process.env);
    } finally {
      await fs.rm(shortcuts, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
