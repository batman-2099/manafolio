/* global __OFFLINE_ASSETS__, __OFFLINE_CACHE__ */
const ASSETS = __OFFLINE_ASSETS__;
const CACHE = __OFFLINE_CACHE__;

async function prepareCache() {
  const cache = await caches.open(CACHE);
  const pending = ASSETS.values();
  // ponytail: four downloads overlap latency without flooding slower devices.
  await Promise.all(Array.from({ length: Math.min(4, ASSETS.length) }, async () => {
    for (const path of pending) {
      if (await cache.match(path)) continue;
      const response = await fetch(path, { cache: 'reload' });
      if (!response.ok || response.redirected) throw new Error('Offline asset unavailable');
      await cache.put(path, response);
    }
  }));
}

self.addEventListener('install', event => {
  event.waitUntil(prepareCache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('manafolio-offline-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data !== 'offline-ready') return;
  event.waitUntil(prepareCache().then(
    () => event.ports[0]?.postMessage({ ready: true }),
    () => event.ports[0]?.postMessage({ ready: false }),
  ));
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Explicit allowlist: never cache API responses, public shares, images or tokens.
  if (ASSETS.includes(url.pathname) && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return await cache.match(url.pathname) || fetch(event.request);
    })());
    return;
  }
  if (event.request.mode !== 'navigate' || !['/', '/index.html'].includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.status < 500) return response;
    } catch { /* Server unreachable: the cached page reads only the opted-in local snapshot. */ }
    const cache = await caches.open(CACHE);
    return await cache.match('/offline.html') || Response.error();
  })());
});
