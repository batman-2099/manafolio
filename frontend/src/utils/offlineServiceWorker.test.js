import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../offlineServiceWorker.js', import.meta.url), 'utf8');

test('offline readiness waits for every asset, preserves cached assets, and rejects failed downloads', async () => {
  const assets = Array.from({ length: 9 }, (_, index) => `/assets/${index}.js`);
  const stored = new Map([[assets[0], { cached: true }]]);
  const pending = [];
  const fetched = [];
  const handlers = {};
  let fail = false;
  vm.runInNewContext(source, {
    __OFFLINE_ASSETS__: assets, __OFFLINE_CACHE__: 'offline-test',
    caches: { open: async () => ({ match: async path => stored.get(path), put: async (path, response) => stored.set(path, response) }) },
    fetch: path => {
      fetched.push(path);
      return new Promise(resolve => pending.push(() => resolve({ ok: !fail, redirected: false })));
    },
    self: { addEventListener: (name, handler) => { handlers[name] = handler; } },
  });
  const messages = [];
  let completion;
  const prepare = () => handlers.message({ data: 'offline-ready', ports: [{ postMessage: value => messages.push(value.ready) }], waitUntil: promise => { completion = promise; } });
  prepare();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pending.length > 1 && pending.length <= 4, 'downloads overlap within the concurrency ceiling');
  assert.deepEqual(messages, [], 'not ready while downloads are pending');
  while (pending.length) {
    pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
  }
  await completion;
  assert.deepEqual(messages, [true]);
  assert.equal(stored.size, assets.length);
  assert.ok(!fetched.includes(assets[0]), 'existing cached assets are not downloaded again');
  stored.delete(assets[1]);
  fail = true;
  prepare();
  await new Promise(resolve => setImmediate(resolve));
  pending.splice(0).forEach(resolve => resolve());
  await completion;
  assert.deepEqual(messages, [true, false], 'a missing asset must prevent offline readiness');
  assert.equal(stored.size, assets.length - 1, 'a failed refresh retains previously cached assets');
});

function workerHarness() {
  const handlers = {};
  const stored = new Map([['/assets/app.js', new Response('script')], ['/offline.html', new Response('offline')]]);
  const fetched = [];
  const deleted = [];
  const cacheName = 'manafolio-offline-shell-current';
  const state = { status: 200, fail: false, claimed: false, writes: 0 };
  vm.runInNewContext(source, {
    __OFFLINE_ASSETS__: ['/assets/app.js', '/offline.html'], __OFFLINE_CACHE__: cacheName,
    URL, Response, AbortSignal,
    caches: {
      open: async () => ({ match: async path => stored.get(path), put: async () => { state.writes++; } }),
      keys: async () => [cacheName, 'manafolio-offline-shell-old', 'other-app-cache'],
      delete: async name => { deleted.push(name); return true; },
    },
    fetch: async (request, options) => {
      fetched.push({ request, options });
      if (state.fail) throw new Error('Network unavailable');
      return new Response('network', { status: state.status });
    },
    self: {
      location: { origin: 'https://example.test' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { claim: async () => { state.claimed = true; } },
    },
  });
  const request = (path, overrides = {}) => {
    let response;
    handlers.fetch({
      request: { url: new URL(path, 'https://example.test').href, method: 'GET', mode: 'cors', ...overrides },
      respondWith: promise => { response = promise; },
    });
    return response;
  };
  return { handlers, stored, fetched, deleted, state, request };
}

test('worker intercepts only exact same-origin GET shell assets, without caching network misses', async () => {
  const h = workerHarness();
  assert.equal(await (await h.request('/assets/app.js')).text(), 'script');
  assert.equal(h.fetched.length, 0);
  for (const [path, overrides] of [
    ['/api/collection/offline-snapshot', {}],
    ['/shared/decks/token', { mode: 'navigate' }],
    ['/images/card.jpg', {}],
    ['/assets/unknown.js', {}],
    ['/assets/app.js?token=secret', {}],
    ['https://other.test/assets/app.js', {}],
    ['/assets/app.js', { method: 'POST' }],
    ['/', {}],
    ['/settings', { mode: 'navigate' }],
  ]) assert.equal(h.request(path, overrides), undefined, path);
  assert.equal(h.fetched.length, 0, 'non-allowlisted requests are left to the browser');
  h.stored.delete('/assets/app.js');
  assert.equal(await (await h.request('/assets/app.js')).text(), 'network');
  assert.equal(h.state.writes, 0, 'fetch handling never stores arbitrary network responses');
});

test('root navigation uses network first and falls back only for outages or server failures', async () => {
  const h = workerHarness();
  for (const path of ['/', '/index.html', '/?token=secret']) {
    assert.equal(await (await h.request(path, { mode: 'navigate' })).text(), 'network');
    assert.equal(h.fetched.at(-1).options.cache, 'no-store');
  }
  h.state.status = 404;
  assert.equal((await h.request('/', { mode: 'navigate' })).status, 404);
  h.state.status = 503;
  assert.equal(await (await h.request('/', { mode: 'navigate' })).text(), 'offline');
  h.state.fail = true;
  // Each cached Response is used once, as the real Cache API returns fresh bodies.
  h.stored.set('/offline.html', new Response('offline'));
  assert.equal(await (await h.request('/index.html', { mode: 'navigate' })).text(), 'offline');
  h.stored.delete('/offline.html');
  assert.equal((await h.request('/', { mode: 'navigate' })).type, 'error');
  assert.equal(h.state.writes, 0);
});

test('activation deletes only obsolete offline shell caches and claims clients', async () => {
  const h = workerHarness();
  let completion;
  h.handlers.activate({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.deepEqual(h.deleted, ['manafolio-offline-shell-old']);
  assert.equal(h.state.claimed, true);
});
