// Copied only into a test installation, never shipped in desktop packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, dialog } = require('electron');
const destination = path.join(process.env.MANAFOLIO_SMOKE_OUTPUT, 'export.txt');
let checked = false;
let childPort;
let promptAction = 'submit';
const timeout = setTimeout(() => { console.error('FAIL: desktop smoke timed out'); app.exit(1); }, 90000);
// Native dialog selections are deterministic; renderer, server and downloads are real.
dialog.showSaveDialogSync = () => destination;
dialog.showMessageBox = async (_window, options) => {
  const settings = options || _window;
  const index = settings.buttons?.findIndex(label => /^(quit|exit|close)/i.test(label)) ?? -1;
  if (index < 0) throw new Error(`Unexpected native dialog: ${settings.message}`);
  return { response: index };
};
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('did-finish-load', async () => {
    if (window.webContents.getURL().startsWith('data:')) {
      if (promptAction === 'cancel') {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      } else {
        await window.webContents.executeJavaScript("document.querySelector('input').value = 'Renamed & saved'; document.querySelector('form').requestSubmit()");
      }
      return;
    }
    if (checked || !/^http:\/\/(localhost|127\.0\.0\.1):/.test(window.webContents.getURL())) return;
    checked = true;
    try {
      childPort = new URL(window.webContents.getURL()).port;
      const result = await window.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 100 && !document.querySelector('input[type=password]'); i++) await new Promise(r => setTimeout(r, 100));
        const input = document.querySelector('input[type=password]');
        if (!input) throw new Error('Login form did not render');
        input.focus();
        const config = await (await fetch('/api/auth/config')).json();
        return { setupRequired: config.setupRequired, focused: document.activeElement === input,
          nodeExposed: typeof window.require !== 'undefined' || typeof window.process !== 'undefined' };
      })()`, true);
      assert.deepEqual(result, { setupRequired: false, focused: true, nodeExposed: false });
      assert.equal(await window.webContents.executeJavaScript("window.prompt('Rename sample container', 'Old name')", true), 'Renamed & saved');
      promptAction = 'cancel';
      assert.equal(await window.webContents.executeJavaScript("window.prompt('Cancel sample rename', 'Keep name')", true), null);
      fs.writeFileSync(path.join(process.env.MANAFOLIO_SMOKE_OUTPUT, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(420, 720);
      await new Promise(resolve => setTimeout(resolve, 250));
      fs.writeFileSync(path.join(process.env.MANAFOLIO_SMOKE_OUTPUT, 'narrow.png'), (await window.webContents.capturePage()).toPNG());
      const downloaded = new Promise((resolve, reject) => {
        window.webContents.session.once('will-download', (_event, item) => {
          item.once('done', (_event, state) => state === 'completed' ? resolve() : reject(new Error(state)));
        });
      });
      await window.webContents.executeJavaScript(`(() => {
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['Manafolio desktop export'], {type:'text/plain'}));
        a.download = 'export.txt'; document.body.append(a); a.click(); a.remove();
      })()`, true);
      await downloaded;
      assert.equal(fs.readFileSync(destination, 'utf8'), 'Manafolio desktop export');
      fs.writeFileSync(path.join(process.env.MANAFOLIO_SMOKE_OUTPUT, 'port'), childPort);
      if (process.platform === 'win32') {
        const nativeDirectory = path.join(process.env.MANAFOLIO_SMOKE_INSTALL, 'app/backend/node_modules/onnxruntime-node/bin/napi-v6/win32/x64');
        const modules = JSON.parse(require('node:child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
          $ErrorActionPreference = 'Stop'
          $backend = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'manafolio-server.exe'")
          if ($backend.Count -ne 1) { throw 'Expected one owned server process' }
          $paths = @((Get-Process -Id $backend[0].ProcessId).Modules | Where-Object { $_.ModuleName -match '^(msvcp140(_1|_atomic_wait)?|vcruntime140(_1)?)\\.dll$' } | Select-Object -ExpandProperty FileName)
          ConvertTo-Json -InputObject $paths -Compress
        `], { windowsHide: true, encoding: 'utf8', timeout: 30000 }));
        assert.deepEqual(modules.map(file => path.basename(file).toLowerCase()).sort(),
          ['msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].sort());
        for (const file of modules) assert.equal(path.dirname(file).toLowerCase(), nativeDirectory.toLowerCase(),
          'Native runtime must load shipped DLLs, not depend on the CI machine redistributable');
        const blocked = require('node:child_process').spawnSync(process.env.MANAFOLIO_SMOKE_INSTALLER,
          ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${process.env.MANAFOLIO_SMOKE_INSTALL}`],
          { windowsHide: true, timeout: 30000 });
        assert.equal(blocked.status, 7, 'Installer must refuse to overwrite the running app');
      }
      clearTimeout(timeout);
      console.log('PASS: desktop window renders login, isolates Node, preserves focus, and exports exact bytes.');
      if (process.platform !== 'win32' && process.env.MANAFOLIO_SMOKE_SIGNAL === '1') process.kill(process.pid, 'SIGTERM');
      else app.quit();
    } catch (error) { console.error(error); app.exit(1); }
  });
});
require('./main.cjs');
