import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('demo rejects unavailable operations without pretending to save, retaining session mutations', async () => {
  const descriptors = Object.fromEntries(['window', 'document', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const store = new Map();
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: { fetch, location: { origin: 'https://demo.example' } } },
    document: { configurable: true, value: { body: null, addEventListener() {} } },
    localStorage: { configurable: true, value: { setItem: (key, value) => store.set(key, value) } },
  });
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    await server.ssrLoadModule('/src/demo/install.js');
    const request = (path, method = 'GET', body) => window.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const before = await (await request('/api/decks/4')).json();
    for (const [path, method, body] of [
      ['/api/decks/4/checkout', 'PUT'],
      ['/api/decks/4/duplicate', 'POST'],
      ['/api/decks/4', 'DELETE'],
      ['/api/decks/4/editor', 'PUT', { name: 'Changed', notes: 'Must not partially save' }],
      ['/api/not-captured', 'GET'],
    ]) {
      const response = await request(path, method, body);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'DEMO_UNAVAILABLE');
    }
    assert.deepEqual(await (await request('/api/decks/4')).json(), before);
    assert.equal((await window.fetch(new Request('https://demo.example/api/decks/4', { method: 'DELETE' }))).status, 503);
    for (const path of ['/api/ai-decks/preferences', '/api/ai-decks/models', '/api/ai-decks/account']) {
      assert.equal((await request(path, 'POST')).status, 503);
    }

    assert.equal((await request('/api/decks/4/editor', 'PUT', { notes: 'Session note' })).status, 200);
    assert.equal((await (await request('/api/decks/4')).json()).notes, 'Session note');
    assert.equal((await request('/api/decks/4/sleeved', 'PATCH', { sleeved: 2 })).status, 200);
    assert.equal((await (await request('/api/decks/4')).json()).sleeved, 2);
    assert.equal((await (await request('/api/decks')).json()).find(deck => deck.id === 4).sleeved, 2);

    const createdResponse = await request('/api/storage-units', 'POST', { name: 'Session shelf', type: 'Other' });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal((await request('/api/storage-units/' + created.id + '/cover-choices', 'DELETE')).status, 503);
    assert.equal((await request('/api/storage-units', 'PUT', { name: 'Not created' })).status, 503);
    assert.equal((await (await request('/api/storage-units')).json()).find(unit => unit.id === created.id).name, 'Session shelf');
    assert.equal((await request('/api/storage-units/' + created.id, 'DELETE')).status, 200);
    assert.equal((await (await request('/api/storage-units')).json()).some(unit => unit.id === created.id), false);
    assert.deepEqual(await (await request('/api/cards/related-tokens', 'POST', { card_ids: [] })).json(), { tokens: [] });
  } finally {
    await server.close();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});
