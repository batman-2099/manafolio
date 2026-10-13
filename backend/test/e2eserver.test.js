const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnServer, waitForServer, stopServer } = require('./e2e/server-helper');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-e2e-server-check-'));
  let foreignRequests = 0;
  const foreign = http.createServer((req, res) => {
    foreignRequests++;
    res.end('{"status":"ok"}');
  });
  await new Promise((resolve, reject) => {
    foreign.once('error', reject);
    foreign.listen(0, '127.0.0.1', resolve);
  });
  const foreignPort = foreign.address().port;
  const children = [];
  const start = (source, options = {}) => {
    const child = spawnServer(['-e', source], {
      ...options,
      env: { ...process.env, PORT: String(foreignPort), HTTPS_PORT: String(foreignPort) },
    });
    children.push(child);
    return child;
  };
  try {
    const fixture = `
      const assert = require('assert');
      assert.strictEqual(process.env.PORT, '0');
      assert.strictEqual(process.env.HTTPS_PORT, '');
      const server = require('http').createServer((req, res) => res.end(String(process.pid)));
      server.listen(Number(process.env.PORT), '127.0.0.1', () => {
        process.send({ type: 'listening', port: server.address().port });
      });
    `;
    const first = start(fixture);
    const second = start(fixture);
    const [firstPort, secondPort] = await Promise.all([waitForServer(first), waitForServer(second)]);
    assert.notStrictEqual(firstPort, secondPort, 'concurrent children own distinct sockets');
    for (const [child, port] of [[first, firstPort], [second, secondPort]]) {
      assert.notStrictEqual(port, foreignPort);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(await response.text(), String(child.pid), 'requests reach the owning child');
    }

    const failed = start('process.exit(7)');
    await assert.rejects(waitForServer(failed), /exited before readiness \(7\)/);
    const spawnFailed = start('', { cwd: path.join(root, 'missing') });
    await assert.rejects(waitForServer(spawnFailed), /ENOENT/);
    const diesDuringHealth = start(`
      const server = require('http').createServer(() => process.exit(8));
      server.listen(0, '127.0.0.1', () => process.send({ type: 'listening', port: server.address().port }));
    `);
    await assert.rejects(waitForServer(diesDuringHealth), /exited before readiness \(8\)/);
    assert.strictEqual(foreignRequests, 0, 'an unrelated healthy endpoint never satisfies readiness');

    await stopServer(first);
    assert.notStrictEqual(first.signalCode, null, 'shutdown waits until the child has exited');
    const rebound = http.createServer();
    await new Promise((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(firstPort, '127.0.0.1', resolve);
    });
    await new Promise(resolve => rebound.close(resolve));
    await stopServer(first); // Repeated cleanup is harmless after close.
    console.log('E2E servers own ephemeral ports, reject startup failures, and await shutdown');
  } finally {
    await Promise.all(children.map(stopServer));
    foreign.closeAllConnections();
    await new Promise(resolve => foreign.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
