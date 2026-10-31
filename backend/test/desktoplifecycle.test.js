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
  const server = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null, connected: true });
  const signals = [], messages = [], timers = [], exits = [], dialogs = [], records = [], errors = [];
  let response = 0;
  server.kill = signal => { signals.push(signal); return true; };
  server.send = (message, callback) => { messages.push(message); callback(null); };
  const app = Object.assign(new EventEmitter(), {
    setName() {}, setAppUserModelId() {}, enableSandbox() {}, setPath() {},
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(),
    getAppPath: () => '/fixture/desktop/resources/app',
    commandLine: { hasSwitch: () => false }, exit: code => exits.push(code),
  });
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler() {},
        session: Object.assign(new EventEmitter(), { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }),
      });
    }
    setTitle() {}
    async loadURL() {}
  }
  const lines = new EventEmitter();
  server.stdout = new EventEmitter();
  server.stderr = new EventEmitter();
  const mocks = {
    electron: {
      app, BrowserWindow, Menu: { setApplicationMenu() {}, buildFromTemplate: value => value },
      ipcMain: new EventEmitter(), shell: {},
      dialog: { showMessageBox: async (...args) => { dialogs.push(args.at(-1)); return { response }; }, showErrorBox: (...args) => errors.push(args) },
    },
    'node:fs': {
      mkdirSync() {}, chmodSync() {}, openSync: () => 1, fchmodSync() {},
      writeSync: (_fd, bytes, offset, length) => { records.push(bytes.toString()); return length; },
    },
    'node:child_process': { spawn: () => server },
    'node:readline': { createInterface: () => lines },
    'node:http': { get: (_url, _options, callback) => {
      callback({ statusCode: 200, headers: { 'x-app-name': 'Manafolio' }, resume() {} });
      return new EventEmitter();
    } },
  };
  vm.runInNewContext(source, {
    require: name => mocks[name] || require(name),
    __filename: '/fixture/desktop/resources/app/main.cjs', Buffer, URL,
    process: Object.assign(new EventEmitter(), {
      platform: isWindows ? 'win32' : 'linux', env: { LOCALAPPDATA: '/fixture', XDG_DATA_HOME: '/fixture' },
      umask() {}, getuid: () => 1000,
    }),
    setTimeout: (callback, milliseconds) => { const timer = { callback, milliseconds }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  });
  await Promise.resolve();
  if (isWindows) server.emit('message', { type: 'listening', port: 3001 });
  else lines.emit('line', 'MANAFOLIO_READY:3001');
  await Promise.resolve();
  assert.equal(timers.shift().cleared, true, 'healthy startup clears its deadline');
  const [quit] = app.listeners('before-quit');
  assert.equal(typeof quit, 'function', 'entrypoint registers the quit handler');
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  await quit(event);
  assert.equal(timers.length, 0, 'Cancel must leave the server running');
  assert.equal(signals.length + messages.length, 0);
  response = 1;
  const confirmedQuit = quit(event);
  await quit(event);
  await confirmedQuit;
  await quit(event);
  assert.equal(prevented, 4, 'all quit attempts are intercepted');
  assert.equal(dialogs.length, 2, 'concurrent and repeated quits do not duplicate confirmation');
  dialogs.length = 0;
  response = 0;
  assert.equal(timers.length, 1, 'repeated quit requests share the same deadline');
  assert.equal(timers[0].milliseconds, 30000);
  assert.equal(messages.length, isWindows ? 1 : 0);
  assert.deepEqual(signals, isWindows ? [] : ['SIGTERM']);
  await timers[0].callback();
  assert.equal(dialogs.length, 1, 'both desktop platforms surface stalled shutdown');
  assert.equal(dialogs[0].defaultId, 0, 'waiting is the safe default');
  assert.equal(dialogs[0].cancelId, 0, 'closing the dialog must keep waiting');
  assert.equal(timers.length, 2, 'Keep waiting schedules another visible deadline');
  assert.ok(!signals.includes('SIGKILL'), 'waiting never silently kills writes');
  response = 1;
  await timers[1].callback();
  assert.equal(signals.at(-1), 'SIGKILL', 'only explicit force quit kills the child');
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
