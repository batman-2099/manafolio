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
