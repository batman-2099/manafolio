const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const vm = require('node:vm');
const sqlite3 = require('sqlite3');

async function backendDrain(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-drain-'));
  const database = path.join(root, 'test.db');
  const child = spawn(process.execPath, ['-e', `
    require('./src/scryfallApi').fetchAndCacheSets = async () => {};
    require('./src/scryfallBulkSchedule').start = async () => {};
    let releaseRequest, releaseWrite;
    require('./src/routes/auth').get('/drain-test', (_req, res) => {
      releaseRequest = () => res.end('drained');
      process.send({ type: 'request-held' });
    });
    const db = require('./src/db');
    process.on('message', async message => {
      if (message.type === 'hold-write') {
        await db.withTransaction(async () => {
          await db.run('CREATE TABLE drain_test (value TEXT)');
          await db.run("INSERT INTO drain_test VALUES ('committed')");
          process.send({ type: 'write-held' });
          await new Promise(resolve => { releaseWrite = resolve; });
        });
      }
      if (message.type === 'release-request') releaseRequest();
      if (message.type === 'release-write') releaseWrite();
    });
    require('./src/server');
  `], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: database, CV_MODEL_DIR: path.join(root, 'models'), PORT: '0', HTTPS_PORT: '',
      MANAFOLIO_WINDOWS_APP: '1', DEFAULT_ADMIN_PASSWORD: '', CATALOG_AUTO_UPDATE: '0', BACKUP_INTERVAL_HOURS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  const message = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`Missing ${type}: ${output}`)); }, 10000);
    function receive(value) {
      if (value.type !== type) return;
      clearTimeout(timer);
      child.off('message', receive);
      resolve(value);
    }
    child.on('message', receive);
  });
  try {
    const { port } = await message('listening');
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
      ready = response.ok;
      await response.text();
      if (ready) break;
      await delay(20);
    }
    assert.ok(ready, output);
    const writeHeld = message('write-held');
    child.send({ type: 'hold-write' });
    await writeHeld;
    const requestHeld = message('request-held');
    const response = new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port}/api/auth/drain-test`, { agent: false }, res => {
        let text = '';
        res.on('data', data => { text += data; });
        res.on('end', () => resolve(text));
        res.on('error', reject);
      }).on('error', reject);
    });
    // Attach immediately so an early regression exit cannot cause an unhandled rejection.
    response.catch(() => {});
    await requestHeld;
    if (mode === 'ipc') {
      child.send({ type: 'shutdown' });
      child.send({ type: 'shutdown' });
    } else child.kill(mode);
    await delay(75);
    assert.equal(child.exitCode, null, output);
    assert.equal(child.signalCode, null, 'signals must drain rather than terminate immediately');
    child.send({ type: 'release-request' });
    assert.equal(await response, 'drained');
    await delay(75);
    assert.equal(child.exitCode, null, 'HTTP drain must still wait for the queued transaction');
    child.send({ type: 'release-write' });
    const result = await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => { throw new Error(`Shutdown timed out: ${output}`); })]);
    assert.deepEqual(result, [0, null], output);
    const connection = new sqlite3.Database(database);
    try {
      const row = await new Promise((resolve, reject) => connection.get('SELECT value FROM drain_test', (error, row) => error ? reject(error) : resolve(row)));
      assert.equal(row.value, 'committed', 'shutdown preserves the committed write on disk');
    } finally { await new Promise(resolve => connection.close(resolve)); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function desktopDeadline(isWindows) {
  const source = fs.readFileSync(path.join(__dirname, '../../desktop/electron/main.cjs'), 'utf8');
  const start = source.indexOf('  function stop() {');
  const end = source.indexOf("  app.on('before-quit'", start);
  assert.ok(start >= 0 && end > start);
  const server = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, connected: true });
  const signals = [], messages = [], timers = [], exits = [], dialogs = [], records = [], errors = [];
  let response = 0;
  server.kill = signal => { signals.push(signal); return true; };
  server.send = (message, callback) => { messages.push(message); callback(null); };
  const context = {
    server, isWindows, stopping: false, failed: false, startupTimer: undefined, promptWindow: undefined,
    logPath: '/private/desktop.log', record: text => records.push(text),
    app: { exit: code => exits.push(code) },
    dialog: { showMessageBox: async options => { dialogs.push(options); return { response }; }, showErrorBox: (...args) => errors.push(args) },
    setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  };
  vm.runInNewContext(source.slice(start, end) + '\nstop(); stop();', context);
  assert.equal(timers.length, 1, 'repeated quit requests share the same deadline');
  assert.equal(timers[0].milliseconds, 30000);
  assert.equal(messages.length, isWindows ? 1 : 0);
  assert.deepEqual(signals, isWindows ? [] : ['SIGTERM']);
  await timers[0].callback();
  assert.equal(dialogs.length, 1, 'both desktop platforms surface stalled shutdown');
  assert.match(dialogs[0].detail, /Force quit may lose data/);
  assert.equal(timers.length, 2, 'Keep waiting schedules another visible deadline');
  assert.ok(!signals.includes('SIGKILL'), 'waiting never silently kills writes');
  response = 1;
  await timers[1].callback();
  assert.equal(signals.at(-1), 'SIGKILL', 'only explicit force quit kills the child');
  assert.ok(records.some(text => text.includes('User chose to force quit')));
  server.exitCode = null;
  server.signalCode = 'SIGKILL';
  server.emit('exit', null, 'SIGKILL');
  assert.deepEqual(exits, [1]);
  assert.equal(errors.length, 0, 'explicit force quit does not show a redundant failure');
  assert.equal(timers[1].cleared, true);
}

(async () => {
  await desktopDeadline(false);
  await desktopDeadline(true);
  for (const mode of process.platform === 'win32' ? ['ipc'] : ['ipc', 'SIGTERM', 'SIGINT', 'SIGUSR2']) await backendDrain(mode);
  console.log('Desktop shutdown drains HTTP and SQLite for IPC/signals, and requires consent before forced termination.');
})().catch(error => { console.error(error); process.exitCode = 1; });
