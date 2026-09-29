const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3');

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-bulk-schedule-'));
  process.env.DB_PATH = path.join(dir, 'user.db');
  process.env.DEFAULT_ADMIN_PASSWORD = 'bulk-schedule-test';
  const db = require('../src/db');
  const bulk = require('../src/scryfallBulk');
  const schedule = require('../src/scryfallBulkSchedule');
  const originalRefresh = bulk.refresh;
  const originalMetadata = bulk.storedMetadata;
  let server;
  try {
    await db.initDb();
    const at = value => Date.parse(value);
    assert.strictEqual(schedule.nextRunAt('10:00', at('2026-09-22T09:59:59Z')), at('2026-09-22T10:00:00Z'));
    assert.strictEqual(schedule.nextRunAt('10:00', at('2026-09-22T10:00:00Z')), at('2026-09-23T10:00:00Z'));
    assert.strictEqual(schedule.nextRunAt('00:00', at('2026-12-31T23:59:59Z')), at('2027-01-01T00:00:00Z'));
    assert.strictEqual(schedule.nextRunAt('00:00', at('2027-01-01T00:00:01Z')), at('2027-01-02T00:00:00Z'));

    const realNow = Date.now;
    const realSetTimeout = global.setTimeout;
    const realClearTimeout = global.clearTimeout;
    let now = at('2026-09-22T09:00:00Z');
    const timers = new Set();
    let attempts = 0;
    try {
      Date.now = () => now;
      global.setTimeout = (callback, delay) => {
        const timer = { callback, at: now + delay, unref() {} };
        timers.add(timer);
        return timer;
      };
      global.clearTimeout = timer => timers.delete(timer);
      bulk.storedMetadata = async () => ({ updated_at: '2026-09-21T09:00:00Z', card_count: 1 });
      bulk.refresh = async () => { attempts++; throw new Error('Scheduled failure fixture'); };
      const advance = async value => {
        now = at(value);
        for (const timer of [...timers]) {
          if (timer.at <= now) {
            timers.delete(timer);
            timer.callback();
          }
        }
        await new Promise(resolve => setImmediate(resolve));
      };
      await schedule.start();
      assert.strictEqual(attempts, 0, 'existing catalog must not refresh at startup');
      await advance('2026-09-22T10:00:00Z');
      assert.strictEqual(attempts, 1);
      await advance('2026-09-22T10:01:00Z');
      assert.strictEqual(attempts, 1, 'failure waits for the next daily occurrence');
      await schedule.start();
      assert.strictEqual(attempts, 1, 'restart must not replay the missed occurrence');
      schedule.reschedule('11:00');
      await advance('2026-09-22T11:00:00Z');
      assert.strictEqual(attempts, 2, 'time changes take effect without restarting');
      schedule.reschedule('10:30');
      await advance('2026-09-23T10:00:00Z');
      assert.strictEqual(attempts, 2, 'earlier time waits until tomorrow and replaces old timers');
      await advance('2026-09-23T10:30:00Z');
      assert.strictEqual(attempts, 3);
      bulk.storedMetadata = async () => null;
      await schedule.start();
      assert.strictEqual(attempts, 4, 'missing catalog is warmed at startup');
    } finally {
      Date.now = realNow;
      global.setTimeout = realSetTimeout;
      global.clearTimeout = realClearTimeout;
      bulk.storedMetadata = originalMetadata;
    }

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { role: req.headers['x-test-role'] || 'admin' };
      next();
    });
    app.use('/api/settings', require('../src/routes/settings'));
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/settings`;
    const request = (method, body, role = 'admin', suffix = '') => fetch(base + suffix, {
      method, headers: { 'Content-Type': 'application/json', 'x-test-role': role },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.strictEqual((await (await request('GET')).json()).scryfall_bulk_download_time, '10:00');
    assert.strictEqual((await request('PUT', { scryfall_bulk_download_time: '23:45' })).status, 200);
    await db.initDb();
    assert.strictEqual((await (await request('GET')).json()).scryfall_bulk_download_time, '23:45', 'migration preserves saved time');
    const persisted = await new Promise((resolve, reject) => {
      const reopened = new sqlite3.Database(process.env.DB_PATH, sqlite3.OPEN_READONLY);
      reopened.get('SELECT scryfall_bulk_download_time FROM app_settings WHERE id = 1', (error, row) => {
        reopened.close(closeError => error || closeError ? reject(error || closeError) : resolve(row));
      });
    });
    assert.strictEqual(persisted.scryfall_bulk_download_time, '23:45');
    const before = await (await request('GET')).json();
    for (const bad of ['9:00', '24:00', '10:60', '10:00:00', '10:00\n', ' 10:00', '', null, 1000]) {
      assert.strictEqual((await request('PUT', { scryfall_bulk_download_time: bad, scan_exclude_tokens: !before.scan_exclude_tokens })).status, 400);
      assert.deepStrictEqual(await (await request('GET')).json(), before, 'invalid time rejects the whole update before mutation');
    }
    const beforeRow = await db.get('SELECT * FROM app_settings WHERE id = 1');
    const combined = {
      price_refresh_days: '7', scryfall_bulk_download_time: '12:34',
      scan_exclude_tokens: true, scan_exclude_art_cards: true,
      scan_exclude_jumpstart: true, scan_exclude_promos: true, setup_complete: true,
    };
    for (const public_base_url of ['ftp://example.test', null, 123, {}]) {
      assert.strictEqual((await request('PUT', { ...combined, public_base_url })).status, 400);
      assert.deepStrictEqual(await db.get('SELECT * FROM app_settings WHERE id = 1'), beforeRow,
        'an invalid URL must leave every other submitted setting unchanged');
    }
    await db.run(`CREATE TRIGGER reject_settings BEFORE UPDATE OF public_base_url ON app_settings
      BEGIN SELECT RAISE(ABORT, 'settings storage failure fixture'); END`);
    assert.strictEqual((await request('PUT', { ...combined, public_base_url: 'https://example.test' })).status, 500);
    assert.deepStrictEqual(await db.get('SELECT * FROM app_settings WHERE id = 1'), beforeRow,
      'storage failure must reject the entire settings update');
    await db.run('DROP TRIGGER reject_settings');
    assert.strictEqual((await request('PUT', { scryfall_bulk_download_time: '12:00' }, 'member')).status, 403);
    assert.deepStrictEqual(await (await request('GET')).json(), before);
    const saved = await request('PUT', { ...combined, public_base_url: ' https://example.test/base/// ' });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(await saved.json(), { ...combined, price_refresh_days: 7, public_base_url: 'https://example.test/base' });
    let downloadCalls = 0;
    bulk.refresh = async () => { downloadCalls++; throw new Error('private-server-path fixture'); };
    assert.strictEqual((await request('POST', {}, 'member', '/scryfall-bulk/download')).status, 403);
    assert.strictEqual(downloadCalls, 0, 'member cannot trigger a download');
    const failed = await request('POST', {}, 'admin', '/scryfall-bulk/download');
    assert.strictEqual(failed.status, 502);
    const failure = await failed.json();
    assert.strictEqual(typeof failure.error, 'string');
    assert.ok(!failure.error.includes('private-server-path'), 'server errors must not leak to clients');

    let release;
    let started;
    const downloading = new Promise(resolve => { started = resolve; });
    bulk.refresh = () => new Promise(resolve => {
      release = () => resolve({ updated: true, updated_at: '2026-09-22T09:00:00Z', count: 1 });
      started();
    });
    let settled = false;
    const pending = request('POST', {}, 'admin', '/scryfall-bulk/download').then(response => { settled = true; return response; });
    await downloading;
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(settled, false, 'HTTP success waits for the download to finish');
    release();
    assert.strictEqual((await pending).status, 200);
  } finally {
    bulk.refresh = originalRefresh;
    bulk.storedMetadata = originalMetadata;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
  console.log('Scryfall UTC scheduling, persisted settings, and admin download checks passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
