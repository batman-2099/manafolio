import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('./offlineCollection.js', import.meta.url), 'utf8'))
  .replaceAll('import.meta.env.PROD', 'true').replaceAll('import.meta.env.VITE_DEMO', 'false')
  .replaceAll('export ', '');
const ENABLED = 'manafolio_offline_enabled';
const GENERATION = 'manafolio_offline_generation';
const tick = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (id = 1) => ({ version: 1, user_id: id, saved_at: '2026-01-01T00:00:00Z', cards: [], generation: '' });

function harness() {
  const storage = new Map([[ENABLED, '1']]);
  const events = [];
  const state = { saved: snapshot(), failClear: false, holdRead: false, reads: [], fetches: [], clears: 0, puts: 0 };
  const login = (id, token = `token-${id}`) => {
    storage.set('manafolio_user', JSON.stringify({ id }));
    storage.set('manafolio_token', token);
  };
  login(1);
  const indexedDB = { open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        close() {},
        transaction() {
          const tx = {
            abort() { queueMicrotask(() => tx.onabort?.()); },
            objectStore: () => ({
              get() {
                const result = { result: state.saved };
                const complete = () => tx.oncomplete();
                if (state.holdRead) state.reads.push(complete);
                else queueMicrotask(complete);
                return result;
              },
              clear() {
                state.clears++;
                queueMicrotask(() => {
                  if (state.failClear) tx.onerror();
                  else { state.saved = undefined; tx.oncomplete(); }
                });
              },
              put(value) {
                state.puts++;
                queueMicrotask(() => { state.saved = value; tx.oncomplete(); });
              },
            }),
          };
          return tx;
        },
      };
      request.onsuccess();
    });
    return request;
  } };
  let generation = 0;
  const context = vm.createContext({
    window: { isSecureContext: true, indexedDB, caches: {}, dispatchEvent: event => events.push(event.type) },
    indexedDB,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => `generation-${++generation}` },
    Event, setTimeout, clearTimeout, AbortSignal,
    MessageChannel: class {
      constructor() {
        this.port1 = { close() {} };
        this.port2 = { reply: () => this.port1.onmessage({ data: { ready: true } }) };
      }
    },
    navigator: { serviceWorker: { getRegistration: async () => ({ active: {
      scriptURL: 'https://example.test/offline-worker.js',
      postMessage: (_, ports) => ports[0].reply(),
    } }) } },
    fetch: (url, options) => new Promise(resolve => state.fetches.push({ url, options, resolve })),
  });
  vm.runInContext(source, context);
  return { ...context, storage, state, events, login };
}

function respond(request, status = 200, data = snapshot()) {
  request.resolve({ status, ok: status === 200, json: async () => data });
}

test('failed clear disables reads immediately and retries physical deletion without an enabled flag', async () => {
  const h = harness();
  h.state.failClear = true;
  const clearing = h.clearSnapshot();
  assert.equal(h.storage.has(ENABLED), false);
  assert.notEqual(h.storage.get(GENERATION), '');
  assert.equal(await h.readSnapshot(), null);
  await assert.rejects(clearing, /offline.storageError/);
  assert.ok(h.state.saved);
  h.state.failClear = false;
  h.storage.delete('manafolio_token');
  h.storage.delete('manafolio_user');
  await h.clearSnapshot();
  assert.equal(h.state.clears, 2);
  assert.equal(h.state.saved, undefined);
});

test('snapshot reads reject another account, generation, or session changed while reading', async () => {
  const h = harness();
  assert.equal((await h.readSnapshot()).user_id, 1);
  h.login(2);
  assert.equal(await h.readSnapshot(), null);
  h.login(1);
  h.storage.set(GENERATION, 'new-generation');
  assert.equal(await h.readSnapshot(), null);
  h.storage.delete(GENERATION);
  h.state.holdRead = true;
  const reading = h.readSnapshot();
  await tick();
  h.storage.delete('manafolio_token');
  h.state.reads.shift()();
  assert.equal(await reading, null);
});

test('successful refresh sends authenticated no-store request and saves only the current account', async () => {
  const h = harness();
  const refreshing = h.refreshSnapshot();
  await tick();
  const request = h.state.fetches[0];
  assert.equal(request.url, '/api/collection/offline-snapshot');
  assert.equal(request.options.headers.Authorization, 'Bearer token-1');
  assert.equal(request.options.cache, 'no-store');
  respond(request);
  const saved = await refreshing;
  assert.equal(saved.user_id, 1);
  assert.equal(await h.readSnapshot(), saved);
  assert.equal(h.state.puts, 1);
});

for (const change of ['clear', 'logout', 'account', 'token']) {
  test(`late refresh cannot save after ${change}`, async () => {
    const h = harness();
    const refreshing = h.refreshSnapshot();
    const rejected = assert.rejects(refreshing, /offline.sessionChanged/);
    await tick();
    if (change === 'clear') await h.clearSnapshot();
    if (change === 'logout') h.storage.delete('manafolio_token');
    if (change === 'account') h.login(2);
    if (change === 'token') h.login(1, 'replacement-token');
    respond(h.state.fetches[0]);
    await rejected;
    assert.equal(h.state.puts, 0);
  });
}

for (const status of [401, 403]) {
  test(`${status} clears the current session but cannot log out a replacement account`, async () => {
    for (const replaced of [false, true]) {
      const h = harness();
      const refreshing = h.refreshSnapshot();
      const rejected = assert.rejects(refreshing, /offline.sessionChanged/);
      await tick();
      if (replaced) { h.login(2); h.state.saved = snapshot(2); }
      respond(h.state.fetches[0], status);
      await rejected;
      assert.equal(h.events.includes('manafolio_logout'), !replaced);
      assert.equal(h.state.clears, replaced ? 0 : 1);
      if (replaced) assert.equal(h.state.saved.user_id, 2);
      else assert.equal(await h.readSnapshot(), null);
    }
  });
}
