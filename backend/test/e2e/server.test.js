const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { spawnServer, waitForServer, stopServer } = require('./server-helper');

// Boots the real Express app against a throwaway DB and exercises it over HTTP.
// Like the other HTTP suites, this catches route wiring / middleware / startup
// breakage the in-process unit tests can't.
const tmpDb = path.join(os.tmpdir(), `manafolio-server-test-${process.pid}.db`);
const projectRoot = path.join(__dirname, '../../../');


async function runTests() {
  const server = spawnServer(['-r', path.join(__dirname, 'scryfall-mock.js'), path.join(projectRoot, 'backend/src/server.js')], {
    env: { ...process.env, DB_PATH: tmpDb }
  });

  try {
    const port = await waitForServer(server);
    const base = `http://127.0.0.1:${port}`;

    // F1-TC1: health endpoint is up and reports readiness
    const res = await fetch(`${base}/api/health`);
    assert.strictEqual(res.status, 200, 'health check should return 200');
    assert.deepStrictEqual(await res.json(), { status: 'ok' }, 'health check should report readiness');
    console.log('PASS: F1-TC1');

    // F1-TC2: a protected route rejects unauthenticated requests
    const noAuth = await fetch(`${base}/api/collection`);
    assert.ok(noAuth.status === 401 || noAuth.status === 403, `collection must require auth, got ${noAuth.status}`);
    console.log('PASS: F1-TC2');
  } finally {
    await stopServer(server);
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* already gone */ }
    }
  }
}

runTests()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch(err => { console.error('FAIL: server.test.js -', err.message); setTimeout(() => process.exit(1), 500); });
