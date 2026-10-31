import offlineSource from './offlineCollection.js?raw';

// The existing isolated Electron harness supplies real IndexedDB and a second realm.
// Only the build flags and shell/API boundary are fixtures; this is not a built-worker smoke test.
export async function runOfflinePersistenceRegressions() {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const keys = ['manafolio_user', 'manafolio_token', 'manafolio_offline_enabled', 'manafolio_offline_generation', 'manafolio_offline_updated'];
  const savedStorage = keys.map(key => [key, localStorage.getItem(key)]);
  const originalFetch = window.fetch;
  const originalGetRegistration = navigator.serviceWorker.getRegistration;
  const moduleURL = URL.createObjectURL(new Blob([
    offlineSource.replaceAll('import.meta.env.PROD', 'true').replaceAll('import.meta.env.VITE_DEMO', 'false'),
  ], { type: 'text/javascript' }));
  const frame = document.createElement('iframe');
  frame.hidden = true;
  let database;
  let offline;
  let releaseFetch;
  let pending;
  const login = id => {
    localStorage.setItem('manafolio_user', JSON.stringify({ id }));
    localStorage.setItem('manafolio_token', `fixture-token-${id}`);
  };
  const snapshot = id => ({ version: 1, user_id: id, saved_at: '2026-01-01T00:00:00Z', cards: [
    { entry_id: id, name: `Account ${id} fixture card`, quantity: 1, game: 'mtg' },
  ] });
  let responseData = snapshot(1);
  let fetchStarted;
  const response = () => ({ status: 200, ok: true, json: async () => responseData });
  window.fetch = async (url, options) => {
    assert(url === '/api/collection/offline-snapshot', 'only the fixture snapshot endpoint is requested');
    assert(options.headers.Authorization === `Bearer ${localStorage.getItem('manafolio_token')}`, 'download uses the current account token');
    assert(options.cache === 'no-store', 'private snapshot bypasses HTTP caching');
    if (fetchStarted) {
      const started = fetchStarted;
      fetchStarted = null;
      return new Promise(resolve => {
        releaseFetch = () => { releaseFetch = null; resolve(response()); };
        started();
      });
    }
    return response();
  };
  navigator.serviceWorker.getRegistration = async () => ({ active: {
    scriptURL: `${location.origin}/offline-worker.js`,
    postMessage: (message, ports) => {
      assert(message === 'offline-ready', 'refresh waits for shell readiness');
      ports[0].postMessage({ ready: true });
      ports[0].close();
    },
  } });
  try {
    offline = await import(/* @vite-ignore */ moduleURL);
    await new Promise((resolve, reject) => {
      frame.onload = resolve;
      frame.onerror = () => reject(new Error('second reader failed to load'));
      frame.srcdoc = `<script type="module">import * as offline from ${JSON.stringify(moduleURL)}; window.offline = offline;</script>`;
      document.body.append(frame);
    });
    const reader = frame.contentWindow.offline;
    assert(reader && reader !== offline, 'second reader has an independent module/window realm');
    await offline.clearSnapshot();
    database = await new Promise((resolve, reject) => {
      const request = frame.contentWindow.indexedDB.open('manafolio_offline', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const storedRows = () => new Promise((resolve, reject) => {
      const tx = database.transaction('snapshots', 'readonly');
      const request = tx.objectStore('snapshots').getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('fixture read aborted'));
    });
    for (const change of ['clear', 'logout', 'switch']) {
      login(1);
      responseData = snapshot(1);
      await offline.refreshSnapshot();
      assert((await offline.readSnapshot())?.cards[0].name === 'Account 1 fixture card', `${change}: A can read its saved snapshot`);
      assert((await reader.readSnapshot())?.user_id === 1, `${change}: a second reader sees persisted A`);
      const storedA = await storedRows();
      assert(storedA.length === 1 && storedA[0].cards[0].name === 'Account 1 fixture card', `${change}: A is physically committed in real IndexedDB`);
      login(2);
      assert(await reader.readSnapshot() === null, `${change}: B cannot read A even before physical clearing`);
      login(1);
      const started = new Promise(resolve => { fetchStarted = resolve; });
      pending = offline.refreshSnapshot().then(
        () => { throw new Error(`${change}: stale download unexpectedly succeeded`); },
        error => assert(error.message === 'offline.sessionChanged', `${change}: stale download rejects the invalidated session`),
      );
      await started;
      // Use the other realm to invalidate an in-flight download, as another tab can.
      const clearing = reader.clearSnapshot();
      if (change === 'logout') {
        localStorage.removeItem('manafolio_token');
        localStorage.removeItem('manafolio_user');
      }
      if (change === 'switch') login(2);
      await clearing;
      assert(await offline.readSnapshot() === null && await reader.readSnapshot() === null, `${change}: both readers reject cleared A`);
      assert((await storedRows()).length === 0, `${change}: A is physically deleted, not merely hidden by the session guard`);
      releaseFetch();
      await pending;
      pending = null;
      assert((await storedRows()).length === 0, `${change}: late download cannot republish A`);
      login(2);
      assert(await reader.readSnapshot() === null, `${change}: B still cannot read A after the stale response`);
      responseData = snapshot(2);
      await offline.refreshSnapshot();
      const storedB = await storedRows();
      assert(storedB.length === 1 && storedB[0].user_id === 2 && (await reader.readSnapshot())?.cards[0].name === 'Account 2 fixture card', `${change}: only B is persisted after B opts in`);
      await reader.clearSnapshot();
    }
    return { realIndexedDB: true, secondReader: true, invalidations: ['clear', 'logout', 'switch'] };
  } finally {
    releaseFetch?.();
    await pending?.catch(() => {});
    database?.close();
    try { await offline?.clearSnapshot(); }
    finally {
      frame.remove();
      URL.revokeObjectURL(moduleURL);
      window.fetch = originalFetch;
      navigator.serviceWorker.getRegistration = originalGetRegistration;
      for (const [key, value] of savedStorage) {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    }
  }
}
