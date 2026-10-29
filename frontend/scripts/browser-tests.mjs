import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const requireDesktop = createRequire(new URL('../../desktop/electron/package.json', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

if (!process.versions.electron) {
  let executable;
  try { executable = requireDesktop('electron'); }
  catch { throw new Error('Browser tests require the existing desktop dependency: npm ci --prefix desktop/electron (from the repository root).'); }
  console.log('Starting browser regression server...');
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const server = await createServer({
    root, configFile: false, appType: 'custom', plugins: [react()],
    logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  server.middlewares.use(async (req, res) => {
    if (req.url !== '/__browser_tests') { res.statusCode = 404; res.end(); return; }
    const html = await server.transformIndexHtml(req.url, '<!doctype html><html lang="en" data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/index.css"><link rel="stylesheet" href="/src/arcane.css"><link rel="stylesheet" href="/src/mana.css"></head><body></body></html>');
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
  });
  const profile = await mkdtemp(join(tmpdir(), 'manafolio-browser-tests-'));
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/__browser_tests`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    console.log('Launching browser runtime...');
    const child = spawn(executable, [fileURLToPath(import.meta.url), url, profile], { stdio: 'inherit', env });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    await server.close();
    await rm(profile, { recursive: true, force: true });
  }
} else {
  const { app, BrowserWindow } = requireDesktop('electron');
  const [url, profile] = process.argv.slice(2);
  app.setPath('userData', profile);
  app.disableHardwareAcceleration();
  // Each suite owns a fresh renderer and in-memory session; no real account or API.
  app.on('window-all-closed', () => {});
  console.log('Waiting for browser runtime readiness...');
  // Electron must finish loading this ESM entry before it can emit ready.
  app.whenReady().then(async () => {
    let failed = false;
    try {
      const suites = (await readdir(join(root, 'src/utils'))).filter(name => name.endsWith('.browser.test.jsx')).sort();
      if (!suites.length) throw new Error('No browser regression suites found');
      for (const suite of suites) {
        console.log(`RUN ${suite}`);
        const window = new BrowserWindow({ show: false, width: 1440, height: 1000,
          webPreferences: { partition: suite, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
          const request = new URL(details.url);
          callback({ cancel: !['data:', 'blob:'].includes(request.protocol) && (request.origin !== new URL(url).origin || request.pathname.startsWith('/api/')) });
        });
        let timeout;
        try {
          await Promise.race([
            (async () => {
              await window.loadURL(url);
              const results = await window.webContents.executeJavaScript(`(async () => {
                const suite = await import('/src/utils/${suite}');
                const entries = Object.entries(suite).filter(([name, value]) => name.startsWith('run') && typeof value === 'function');
                if (!entries.length) throw new Error('Suite has no runnable export');
                const results = {};
                for (const [name, run] of entries) results[name] = await run();
                return results;
              })()`);
              console.log(`PASS ${suite} ${JSON.stringify(results)}`);
            })(),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Suite timed out after 120 seconds')), 120000); }),
          ]);
        } catch (error) {
          failed = true;
          console.error(`FAIL ${suite}`, error);
        } finally {
          clearTimeout(timeout);
          window.destroy();
        }
      }
    } catch (error) {
      failed = true;
      console.error(error);
    }
    app.exit(failed ? 1 : 0);
  });
}
