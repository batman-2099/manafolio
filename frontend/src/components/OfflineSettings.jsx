import { useEffect, useRef, useState } from 'react';
import { useT } from '../utils/i18n';
import { offlineSupported, readSnapshot, refreshSnapshot, clearSnapshot, OFFLINE_EVENT } from '../utils/offlineCollection';
import './OfflineCollection.css';

// Shared by settings and the standalone lookup so invalidation never leaves old account rows visible.
// eslint-disable-next-line react-refresh/only-export-components
export function useOfflineSnapshot(userId) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reload = useRef(null);
  const supported = offlineSupported();

  useEffect(() => {
    let generation = 0;
    let active = true;
    const load = async () => {
      const current = ++generation;
      setSnapshot(null);
      setNotice('');
      setError('');
      setLoading(true);
      try {
        const saved = supported ? await readSnapshot() : null;
        if (active && current === generation) setSnapshot(saved);
      } catch {
        if (active && current === generation) setError('offline.storageError');
      } finally {
        if (active && current === generation) setLoading(false);
      }
    };
    reload.current = load;
    const changed = () => { void load(); };
    window.addEventListener(OFFLINE_EVENT, changed);
    window.addEventListener('manafolio_logout', changed);
    window.addEventListener('storage', changed);
    window.addEventListener('pageshow', changed);
    void load();
    return () => {
      active = false;
      generation++;
      reload.current = null;
      window.removeEventListener(OFFLINE_EVENT, changed);
      window.removeEventListener('manafolio_logout', changed);
      window.removeEventListener('storage', changed);
      window.removeEventListener('pageshow', changed);
    };
  }, [supported, userId]);

  const run = async (clear = false) => {
    const currentReload = reload.current;
    setBusy(true);
    setError('');
    setNotice('');
    if (clear) setSnapshot(null);
    try {
      await (clear ? clearSnapshot() : refreshSnapshot());
      if (reload.current === currentReload) {
        await currentReload?.();
        setNotice(clear ? 'offline.cleared' : 'offline.refreshed');
      }
    } catch (err) {
      if (reload.current === currentReload) {
        const keys = ['offline.refreshError', 'offline.storageError', 'offline.sessionChanged', 'offline.unsupported'];
        setError(keys.includes(err.message) ? err.message : clear ? 'offline.storageError' : 'offline.refreshError');
      }
    } finally {
      if (reload.current) setBusy(false);
    }
  };
  return { snapshot: userId !== undefined && snapshot?.user_id !== userId ? null : snapshot, loading, busy, error, notice, supported, refresh: () => run(), clear: () => run(true) };
}

export default function OfflineSettings({ user }) {
  const { t, locale } = useT();
  const { snapshot, loading, busy, error, notice, supported, refresh, clear } = useOfflineSnapshot(user?.id ?? null);
  return (
    <section className="view-section offline-settings" aria-labelledby="settings-offline">
      <h3 id="settings-offline" tabIndex={-1} className="section-heading">{t('offline.settingsTitle')}</h3>
      <p id="offline-privacy">{t('offline.privacy')}</p>
      {!supported && <p>{t('offline.unsupported')}</p>}
      <div role="status" aria-live="polite">
        {loading ? t('offline.loading') : snapshot ? <p>{t('offline.savedAt', { date: new Date(snapshot.saved_at).toLocaleString(locale) })}</p> : <p>{t('offline.notEnabled')}</p>}
        {busy && <p>{t('offline.working')}</p>}
        {notice && <p>{t(notice)}</p>}
      </div>
      {error && <p role="alert">{t(error)}</p>}
      <div className="offline-actions">
        <button type="button" className="btn btn-primary" aria-describedby="offline-privacy" disabled={!supported || !user || loading || busy} onClick={refresh}>{t(snapshot ? 'offline.refresh' : 'offline.enable')}</button>
        {snapshot && <a className="btn btn-secondary" href="/offline.html">{t('offline.open')}</a>}
        <button type="button" className="btn btn-secondary offline-clear" disabled={busy || !supported} onClick={clear}>{t('offline.clear')}</button>
      </div>
    </section>
  );
}
