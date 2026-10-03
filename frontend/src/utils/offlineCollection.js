export const OFFLINE_EVENT = 'manafolio_offline_changed';
const DATABASE = 'manafolio_offline';
const GENERATION = 'manafolio_offline_generation';
const ENABLED = 'manafolio_offline_enabled';

export function offlineSupported() {
  return Boolean(import.meta.env.PROD && !import.meta.env.VITE_DEMO && window.isSecureContext
    && window.indexedDB && window.caches && navigator.serviceWorker);
}

function session() {
  try {
    const user = JSON.parse(localStorage.getItem('manafolio_user') || 'null');
    const token = localStorage.getItem('manafolio_token');
    return token && user?.id ? { id: user.id, token, generation: localStorage.getItem(GENERATION) || '' } : null;
  } catch { return null; }
}

function unchanged(before) {
  const now = session();
  return before && now && before.id === now.id && before.token === now.token && before.generation === now.generation;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('snapshots');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('offline.storageError'));
  });
}

async function transaction(mode, operation) {
  let database;
  try {
    database = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = database.transaction('snapshots', mode);
      let request;
      try { request = operation(tx.objectStore('snapshots')); }
      catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () => reject(new Error('offline.storageError'));
    });
  } finally { database?.close(); }
}

export async function readSnapshot() {
  const before = session();
  if (!before || !window.indexedDB || !localStorage.getItem(ENABLED)) return null;
  const snapshot = await transaction('readonly', store => store.get('current'));
  return unchanged(before) && snapshot?.version === 1 && snapshot.user_id === before.id
    && snapshot.generation === before.generation ? snapshot : null;
}

function announce() {
  window.dispatchEvent(new Event(OFFLINE_EVENT));
}

export async function clearSnapshot() {
  if (!localStorage.getItem(ENABLED)) return;
  // Invalidate before awaiting IDB: a late download cannot undo logout/clear,
  // including when another tab started it or browser storage deletion fails.
  localStorage.setItem(GENERATION, crypto.randomUUID());
  localStorage.removeItem(ENABLED);
  announce();
  if (window.indexedDB) await transaction('readwrite', store => store.clear());
}

async function prepareShell() {
  let timer;
  let port;
  try {
    await Promise.race([
      (async () => {
        let registration = await navigator.serviceWorker.getRegistration('/');
        if (!registration?.active || !registration.active.scriptURL.endsWith('/offline-worker.js')) {
          await navigator.serviceWorker.register('/offline-worker.js', { scope: '/', updateViaCache: 'none' });
          registration = await navigator.serviceWorker.ready;
        }
        await new Promise((resolve, reject) => {
          const channel = new MessageChannel();
          port = channel.port1;
          port.onmessage = event => event.data?.ready ? resolve() : reject(new Error('offline.refreshError'));
          registration.active.postMessage('offline-ready', [channel.port2]);
        });
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('offline.refreshError')), 60000); }),
    ]);
  } finally { clearTimeout(timer); port?.close(); }
}

export async function refreshSnapshot() {
  if (!offlineSupported()) throw new Error('offline.unsupported');
  const before = session();
  if (!before) throw new Error('offline.sessionChanged');
  try {
    localStorage.setItem(ENABLED, '1');
    await prepareShell();
    if (!unchanged(before)) throw new Error('offline.sessionChanged');
    const response = await fetch('/api/collection/offline-snapshot', {
      headers: { Authorization: `Bearer ${before.token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
    if (response.status === 401 || response.status === 403) {
      if (unchanged(before)) {
        await clearSnapshot();
        window.dispatchEvent(new Event('manafolio_logout'));
      }
      throw new Error('offline.sessionChanged');
    }
    if (!response.ok) throw new Error('offline.refreshError');
    const data = await response.json();
    if (data.version !== 1 || data.user_id !== before.id || !Array.isArray(data.cards)
      || !Number.isFinite(Date.parse(data.saved_at))) throw new Error('offline.refreshError');
    const snapshot = { ...data, generation: before.generation };
    await transaction('readwrite', store => {
      if (!unchanged(before)) throw new Error('offline.sessionChanged');
      // ponytail: one whole snapshot, atomically replaced; no offline edits or merge queue.
      return store.put(snapshot, 'current');
    });
    if (!unchanged(before)) throw new Error('offline.sessionChanged');
    announce();
    // Notify other tabs without putting any collection data in localStorage.
    try { localStorage.setItem('manafolio_offline_updated', crypto.randomUUID()); }
    catch { /* The snapshot is committed; a missed cross-tab notice is not a failed refresh. */ }
    return snapshot;
  } catch (error) {
    if (error.message?.startsWith('offline.')) throw error;
    throw new Error('offline.refreshError');
  }
}
