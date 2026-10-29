'use strict';

// The only renderer capability is a text prompt; no Node objects cross the bridge.
if (process.type === 'renderer') {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.executeInMainWorld({
    func: prompt => { window.prompt = prompt; },
    args: [(message = '', value = '') => ipcRenderer.sendSync('manafolio:prompt', String(message), String(value))],
  });
} else {
  const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { createInterface } = require('node:readline');

  process.umask(0o077);
  app.setName('Manafolio');
  const isWindows = process.platform === 'win32';
  if (isWindows) app.setAppUserModelId('Manafolio.Desktop');
  app.enableSandbox();
  const dataDirectory = isWindows
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Manafolio')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'manafolio');
  const logPath = path.join(dataDirectory, 'desktop.log');
  let window, server, log, origin, promptWindow, startupTimer;
  let stopping = false, failed = false, confirming = false, loaded = false, authFlow = false;
  let logBytes = 0;

  function record(message) {
    if (log === undefined || logBytes >= 4 * 1024 * 1024) return;
    const bytes = Buffer.from(String(message));
    try { logBytes += fs.writeSync(log, bytes, 0, Math.min(bytes.length, 4 * 1024 * 1024 - logBytes)); }
    catch { /* A full disk must not stop shutdown or obscure the error dialog. */ }
  }

  async function fail(message) {
    if (failed || stopping) return;
    failed = true;
    clearTimeout(startupTimer);
    record(`\n${message}\n`);
    if (promptWindow && !promptWindow.isDestroyed()) promptWindow.destroy();
    await app.whenReady();
    const { response } = await dialog.showMessageBox({
      type: 'error', title: 'Manafolio could not continue', message,
      detail: `Quit and reopen Manafolio after correcting the problem. Diagnostics: ${logPath}`,
      buttons: ['Quit', 'Show log'], defaultId: 0, cancelId: 0,
    });
    if (response === 1) shell.showItemInFolder(logPath);
    app.quit();
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    if (promptWindow && !promptWindow.isDestroyed()) promptWindow.destroy();
    if (!server || server.exitCode !== null || server.signalCode !== null || !server.pid) {
      app.exit(failed ? 1 : 0);
      return;
    }
    let shutdownTimer;
    const waitForShutdown = () => {
      shutdownTimer = setTimeout(async () => {
        if (server.exitCode !== null || server.signalCode !== null) return;
        const message = 'The local server has not stopped after 30 seconds.';
        record(`${message}\n`);
        const { response } = await dialog.showMessageBox({
          type: 'warning', title: 'Manafolio is still saving', message,
          detail: `Wait to let active requests and database writes finish. Force quit may lose data or interrupt a save. Diagnostics: ${logPath}`,
          buttons: ['Keep waiting', 'Force quit'], defaultId: 0, cancelId: 0,
        });
        if (server.exitCode !== null || server.signalCode !== null) return;
        if (response === 1) {
          failed = true;
          record('User chose to force quit the local server; unfinished writes may be lost.\n');
          if (!server.kill('SIGKILL')) {
            record('Could not force quit the local server; continuing to wait.\n');
            waitForShutdown();
          }
        } else waitForShutdown();
      }, 30000);
    };
    server.once('exit', (code, signal) => {
      clearTimeout(shutdownTimer);
      if (!failed && (code !== 0 || signal)) {
        failed = true;
        dialog.showErrorBox('Manafolio could not stop cleanly', `The local server exited (${signal || code}). Check ${logPath} before reopening Manafolio.`);
      }
      app.exit(failed ? 1 : 0);
    });
    waitForShutdown();
    if (isWindows) {
      if (server.connected) server.send({ type: 'shutdown' }, error => {
        if (error) record(`Could not request server shutdown: ${error.message}\n`);
      });
    } else server.kill('SIGTERM');
  }

  app.on('before-quit', async event => {
    event.preventDefault();
    if (stopping || confirming) return;
    if (!failed && loaded) {
      confirming = true;
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: 'Quit Manafolio?', message: 'Quit Manafolio?',
        detail: 'The local server will stop. Finish imports and saves first; unsaved changes will be lost.',
        buttons: ['Cancel', 'Quit'], defaultId: 0, cancelId: 0,
      });
      confirming = false;
      if (response !== 1) return;
    }
    stop();
  });
  process.on('uncaughtException', error => { void fail(error.stack || String(error)); });
  process.on('unhandledRejection', error => { void fail(String(error)); });
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  function isLocal(value) {
    try { return Boolean(origin) && new URL(value).origin === origin; } catch { return false; }
  }

  function openExternal(value) {
    try {
      if (['http:', 'https:', 'mailto:'].includes(new URL(value).protocol)) {
        void shell.openExternal(value).catch(error => dialog.showErrorBox('Could not open link', error.message));
      }
    } catch { /* Invalid and custom URLs are not executable destinations. */ }
  }

  // Electron has no native text-input dialog. A sandboxed modal form preserves
  // synchronous prompt semantics without giving the page a general IPC bridge.
  ipcMain.on('manafolio:prompt', (event, message, value) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
        !isLocal(event.senderFrame.url) || promptWindow || typeof message !== 'string' || typeof value !== 'string' ||
        message.length > 16384 || value.length > 16384) {
      event.returnValue = null;
      return;
    }
    const escape = text => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    const modal = new BrowserWindow({
      parent: window, modal: true, width: 520, height: 260, minWidth: 320, minHeight: 240,
      title: 'Manafolio', autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    promptWindow = modal;
    modal.setMenu(null);
    let result = null;
    modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    modal.webContents.on('will-navigate', (navigation, url) => {
      navigation.preventDefault();
      const destination = new URL(url);
      if (destination.origin === 'https://manafolio.invalid' && destination.pathname === '/prompt') {
        result = destination.searchParams.has('cancel') ? null : destination.searchParams.get('value');
        modal.close();
      }
    });
    modal.webContents.on('before-input-event', (inputEvent, input) => {
      if (input.key === 'Escape') { inputEvent.preventDefault(); modal.close(); }
    });
    modal.webContents.on('render-process-gone', () => {
      modal.destroy();
      dialog.showErrorBox('Prompt failed', 'The text-entry window stopped. Your changes were not submitted; try again.');
    });
    modal.on('closed', () => {
      promptWindow = undefined;
      event.returnValue = result;
      if (!window.isDestroyed()) window.webContents.focus();
    });
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action https://manafolio.invalid">
      <title>Manafolio</title><style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui;margin:24px}label{display:block;overflow-wrap:anywhere}input{box-sizing:border-box;width:100%;font:inherit;margin:12px 0}button{font:inherit;min-height:44px;padding:4px 16px}div{display:flex;justify-content:end;gap:8px}input:focus-visible,button:focus-visible{outline:2px solid Highlight;outline-offset:2px}</style>
      <form action="https://manafolio.invalid/prompt"><label for="value">${escape(message || 'Enter a value')}</label><input id="value" name="value" value="${escape(value)}" autofocus><div><button type="submit">OK</button><button type="submit" name="cancel" value="1" formnovalidate>Cancel</button></div></form></html>`;
    void modal.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(error => {
      record(`Prompt failed: ${error.message}\n`);
      modal.close();
    });
  });

  function configureWindow() {
    window = new BrowserWindow({
      width: 1200, height: 820, minWidth: 390, minHeight: 480, title: 'Manafolio — Starting server…',
      ...(isWindows ? { icon: path.resolve(app.getAppPath(), '../../../manafolio.ico') } : {}),
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: __filename },
    });
    window.on('close', event => { event.preventDefault(); app.quit(); });
    const web = window.webContents;
    web.on('preload-error', (_event, _preload, error) => { void fail(`Could not initialize the desktop prompt: ${error.message}`); });
    web.on('will-attach-webview', event => event.preventDefault());
    web.on('render-process-gone', (_event, details) => {
      if (!stopping) void fail(`The application window stopped (${details.reason}). Do not disable the sandbox.${isWindows ? '' : ' If the sandbox could not start, enable unprivileged user namespaces on this Linux system.'}`);
    });
    web.on('will-navigate', (event, value) => {
      const url = new URL(value);
      if (isLocal(value)) {
        if (url.pathname === '/api/auth/oidc/login') authFlow = true;
        return;
      }
      if (authFlow && ['http:', 'https:'].includes(url.protocol)) return;
      event.preventDefault();
      openExternal(value);
    });
    web.on('will-redirect', (event, value) => {
      if (!isLocal(value) && !(authFlow && ['http:', 'https:'].includes(new URL(value).protocol))) event.preventDefault();
    });
    web.on('did-navigate', (_event, value) => {
      if (isLocal(value) && new URL(value).pathname !== '/api/auth/oidc/login') authFlow = false;
    });
    web.on('will-frame-navigate', event => {
      if (!event.isMainFrame && !['http:', 'https:', 'about:', 'blob:'].includes(new URL(event.url).protocol)) event.preventDefault();
    });
    web.setWindowOpenHandler(({ url }) => {
      if (isLocal(url)) void web.loadURL(url).catch(error => fail(error.message));
      else openExternal(url);
      return { action: 'deny' };
    });
    web.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
      contents === web && permission === 'media' && isLocal(requestingOrigin) && isLocal(web.getURL()) && details.mediaType === 'video');
    web.session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (contents !== web || permission !== 'media' || !details.isMainFrame || !isLocal(details.requestingUrl) ||
          !isLocal(web.getURL()) || details.mediaTypes?.length !== 1 || details.mediaTypes[0] !== 'video') {
        callback(false);
        return;
      }
      const { response } = await dialog.showMessageBox(window, {
        type: 'question', title: 'Camera access', message: 'Allow Manafolio to use your camera for card scanning?',
        buttons: ['Cancel', 'Allow camera'], defaultId: 0, cancelId: 0,
      });
      callback(response === 1 && !web.isDestroyed() && isLocal(web.getURL()));
    });
    web.session.on('will-download', (_event, item, contents) => {
      if (contents !== web || !isLocal(web.getURL())) { item.cancel(); return; }
      try {
        const destination = dialog.showSaveDialogSync(window, { title: 'Save download', defaultPath: path.basename(item.getFilename()) });
        if (!destination) { item.cancel(); return; }
        item.setSavePath(destination);
        item.once('done', (_done, state) => {
          if (state !== 'completed' && state !== 'cancelled') dialog.showErrorBox('Download failed', 'The file could not be saved. Check available disk space and folder permissions, then export again.');
        });
      } catch (error) { item.cancel(); dialog.showErrorBox('Download failed', error.message); }
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Manafolio', submenu: [{ role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'View', submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => { if (web.navigationHistory.canGoBack()) web.navigationHistory.goBack(); } },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => { if (web.navigationHistory.canGoForward()) web.navigationHistory.goForward(); } },
        { role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { label: 'Print…', accelerator: 'Control+P', click: () => web.print({}, (success, reason) => {
          if (!success && reason !== 'cancelled') dialog.showErrorBox('Printing failed', reason);
        }) },
      ] },
    ]));
  }

  function waitForHealth() {
    if (failed || stopping) return;
    const request = http.get(`${origin}/api/health`, { timeout: 2000 }, response => {
      response.resume();
      if (failed || stopping) return;
      if (response.statusCode === 200 && response.headers['x-app-name'] === 'Manafolio' && server.exitCode === null) {
        clearTimeout(startupTimer);
        window.setTitle('Manafolio');
        void window.loadURL(origin).then(() => { loaded = true; }).catch(error => fail(`Could not load the local application: ${error.message}`));
      } else setTimeout(waitForHealth, 500);
    });
    request.on('timeout', () => request.destroy(new Error('Health request timed out')));
    request.on('error', () => setTimeout(waitForHealth, 500));
  }

  try {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDirectory, 0o700);
    const userData = path.join(dataDirectory, 'desktop');
    fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    fs.chmodSync(userData, 0o700);
    app.setPath('userData', userData);
    if (!app.requestSingleInstanceLock()) {
      app.exit(0);
    } else {
      log = fs.openSync(logPath, 'w', 0o600);
      fs.fchmodSync(log, 0o600);
      void app.whenReady().then(() => {
        // Electron installs native signal handlers during startup; register after ready.
        if (!isWindows) for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop);
        if (process.getuid?.() === 0 || app.commandLine.hasSwitch('no-sandbox') || process.env.ELECTRON_DISABLE_SANDBOX) {
          return fail(`Manafolio requires the Chromium sandbox. Remove sandbox-disabling options.${isWindows ? '' : ' Run as a normal user with unprivileged user namespaces enabled.'}`);
        }
        configureWindow();
        startupTimer = setTimeout(() => fail('The local server or database did not become ready within 90 seconds. Check desktop.log for configuration, port, or database errors.'), 90000);
        server = spawn(path.resolve(app.getAppPath(), `../../../manafolio-server${isWindows ? '.exe' : ''}`), [], {
          cwd: dataDirectory, windowsHide: true,
          env: { ...process.env, [isWindows ? 'MANAFOLIO_WINDOWS_APP' : 'MANAFOLIO_LINUX_APP']: '1' },
          stdio: isWindows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        });
        server.stdout.on('data', record);
        server.stderr.on('data', record);
        server.on('error', error => { void fail(`Could not start the local server: ${error.message}`); });
        server.on('exit', (code, signal) => {
          if (!stopping) void fail(`The local server stopped (${signal || code}). Check desktop.log before reopening Manafolio.`);
        });
        if (isWindows) {
          server.on('message', message => {
            if (origin || stopping || failed || message?.type !== 'listening' ||
                !Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
            origin = `http://localhost:${message.port}`;
            waitForHealth();
          });
        } else {
          createInterface({ input: server.stdout }).on('line', line => {
            if (origin || stopping || failed) return;
            const match = /^MANAFOLIO_READY:(\d+)$/.exec(line);
            if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return;
            origin = `http://localhost:${Number(match[1])}`;
            waitForHealth();
          });
        }
      });
    }
  } catch (error) { void fail(`Could not initialize private desktop storage: ${error.message}`); }
}
