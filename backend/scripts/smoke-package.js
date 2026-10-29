// Exercise the macOS package's shipped server, separately from its native window.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const image = path.resolve(process.argv[2]);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-package-'));
  const data = path.join(root, 'Library', 'Application Support', 'Manafolio');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  await fs.mkdir(data, { recursive: true });
  const config = `PORT=${port}\nHTTPS_PORT=\nCATALOG_AUTO_UPDATE=0\nBACKUP_INTERVAL_HOURS=0\n`;
  try {
    for (let run = 0; run < 2; run++) {
      await fs.writeFile(path.join(data, '.env'), config + (run === 0 ? 'DEFAULT_ADMIN_PASSWORD=Package-smoke-only-7291\n' : ''));
      const env = { ...process.env, HOME: root, MANAFOLIO_MAC_APP: '1' };
      for (const key of ['DB_PATH', 'CV_MODEL_DIR', 'PORT', 'HTTPS_PORT', 'DEFAULT_ADMIN_PASSWORD']) delete env[key];
      const child = spawn(image, [], { env, cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const exited = once(child, 'exit');
      try {
        let ready = false;
        for (let attempt = 0; attempt < 120; attempt++) {
          if (child.exitCode !== null) throw new Error(output);
          try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
            ready = response.ok;
            await response.text();
          } catch { /* Wait for database initialization. */ }
          if (ready) break;
          await delay(500);
        }
        assert.ok(ready, output);
        const base = `http://127.0.0.1:${port}`;
        const auth = await (await fetch(`${base}/api/auth/config`)).json();
        assert.equal(auth.setupRequired, false, 'Owner must survive restart without bootstrap credentials');
        const page = await fetch(base);
        assert.equal(page.status, 200);
        assert.match(await page.text(), /<html/i);
        const database = await fs.readFile(path.join(data, 'manafolio.db'));
        assert.equal(database.subarray(0, 15).toString(), 'SQLite format 3');
        assert.ok((await fs.stat(path.join(data, 'models'))).isDirectory());
      } finally {
        if (child.exitCode === null) process.kill(-child.pid, 'SIGTERM');
        const kill = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000);
        await exited;
        clearTimeout(kill);
      }
    }
    console.log('PASS: Package serves API/frontend, loads user configuration, and retains its owner/database across restart.');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
