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
  const environment = { CV_MODEL_DIR: process.env.CV_MODEL_DIR, TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const foreignModels = path.join(root, 'foreign-models');
  fs.mkdirSync(foreignModels);
  fs.writeFileSync(path.join(foreignModels, 'sentinel'), 'leave untouched');
  const dotenvFile = path.join(root, '.env');
  fs.writeFileSync(dotenvFile, `CV_MODEL_DIR=${foreignModels}\n`);
  Object.assign(process.env, { CV_MODEL_DIR: foreignModels, TMPDIR: root, TMP: root, TEMP: root });
  const ownedModels = () => fs.readdirSync(root).filter(name => name.startsWith('manafolio-e2e-models-'));
  const children = [];
  const start = (source, options = {}) => {
    const child = spawnServer(['-e', source], {
      ...options,
      env: { ...process.env, ...options.env, PORT: String(foreignPort), HTTPS_PORT: String(foreignPort) },
    });
    children.push(child);
    return child;
  };
  try {
    const fixture = `
      const assert = require('assert');
      assert.strictEqual(process.env.PORT, '0');
      assert.strictEqual(process.env.HTTPS_PORT, '');
      require(${JSON.stringify(require.resolve('dotenv'))}).config({ path: ${JSON.stringify(dotenvFile)}, quiet: true });
      const fs = require('fs');
      const models = process.env.CV_MODEL_DIR;
      assert.notStrictEqual(models, ${JSON.stringify(foreignModels)});
      assert.deepStrictEqual(fs.readdirSync(models), []);
      if (process.env.FIXTURE_MODEL_DIR) assert.strictEqual(models, process.env.FIXTURE_MODEL_DIR);
      fs.writeFileSync(require('path').join(models, 'child-cache'), 'synthetic model cache');
      const server = require('http').createServer((req, res) => res.end(String(process.pid)));
      server.listen(Number(process.env.PORT), '127.0.0.1', () => {
        process.send({ type: 'listening', port: server.address().port });
      });
    `;
    const first = start(fixture);
    const second = start(fixture);
    const [firstPort, secondPort] = await Promise.all([waitForServer(first), waitForServer(second)]);
    assert.notStrictEqual(firstPort, secondPort, 'concurrent children own distinct sockets');
    assert.strictEqual(ownedModels().length, 2, 'concurrent children own distinct empty model directories');
    for (const [child, port] of [[first, firstPort], [second, secondPort]]) {
      assert.notStrictEqual(port, foreignPort);
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(await response.text(), String(child.pid), 'requests reach the owning child');
    }

    const failed = start('process.exit(7)');
    await assert.rejects(waitForServer(failed), /exited before readiness \(7\)/);
    await failed.closed;
    assert.strictEqual(ownedModels().length, 2, 'startup failure removes its owned model directory');
    const spawnFailed = start('', { cwd: path.join(root, 'missing') });
    await assert.rejects(waitForServer(spawnFailed), /ENOENT/);
    await spawnFailed.closed;
    assert.strictEqual(ownedModels().length, 2, 'spawn failure removes its owned model directory');
    assert.throws(() => start('', { cwd: 123 }), /cwd/);
    assert.strictEqual(ownedModels().length, 2, 'synchronous spawn failure removes its owned model directory');
    const diesDuringHealth = start(`
      const server = require('http').createServer(() => process.exit(8));
      server.listen(0, '127.0.0.1', () => process.send({ type: 'listening', port: server.address().port }));
    `);
    await assert.rejects(waitForServer(diesDuringHealth), /exited before readiness \(8\)/);
    await diesDuringHealth.closed;
    assert.strictEqual(ownedModels().length, 2, 'health-check failure removes its owned model directory');
    assert.strictEqual(foreignRequests, 0, 'an unrelated healthy endpoint never satisfies readiness');

    await stopServer(first);
    assert.notStrictEqual(first.signalCode, null, 'shutdown waits until the child has exited');
    assert.strictEqual(ownedModels().length, 1, 'successful shutdown removes its owned model directory');
    const rebound = http.createServer();
    await new Promise((resolve, reject) => {
      rebound.once('error', reject);
      rebound.listen(firstPort, '127.0.0.1', resolve);
    });
    await new Promise(resolve => rebound.close(resolve));
    await stopServer(first); // Repeated cleanup is harmless after close.
    const explicitModels = path.join(root, 'explicit-models');
    fs.mkdirSync(explicitModels);
    const explicit = start(fixture, { modelDir: explicitModels, env: { FIXTURE_MODEL_DIR: explicitModels } });
    await waitForServer(explicit);
    await stopServer(explicit);
    assert.strictEqual(fs.readFileSync(path.join(explicitModels, 'child-cache'), 'utf8'), 'synthetic model cache', 'explicit fixtures remain caller-owned');
    assert.deepStrictEqual(fs.readdirSync(foreignModels), ['sentinel']);
    assert.strictEqual(fs.readFileSync(path.join(foreignModels, 'sentinel'), 'utf8'), 'leave untouched');
    await stopServer(second);
    assert.deepStrictEqual(ownedModels(), [], 'all default model directories are cleaned');
    console.log('E2E servers isolate ports and model directories, preserve explicit fixtures, and clean up after success/failure');
  } finally {
    await Promise.all(children.map(stopServer));
    foreign.closeAllConnections();
    await new Promise(resolve => foreign.close(resolve));
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
