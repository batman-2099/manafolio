import { useState, useEffect, useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';
import Logo from './Logo';
import { isBinderType, binderSpread } from '../utils/cardOptions';
import CompartmentView from './CompartmentView';
import { useT } from '../utils/i18n';

// A single shared container, drawn with the same CompartmentView the owner sees:
// a binder gets its pocket spread, a box its coverflow. Read-only — no callbacks
// are passed, so CompartmentView renders no rename, capacity or lock controls.
function SharedContainer({ shareToken, containerId }) {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const fetchContainer = async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/shared/${shareToken}/containers/${containerId}`, { signal: controller.signal });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || t('shared.errLoadContainer'));
        }
        const result = await res.json();
        if (!controller.signal.aborted) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchContainer();
    return () => controller.abort();
  }, [shareToken, containerId, t, retry]);

  const cardsByCompartment = useMemo(() => {
    const byComp = new Map();
    for (const card of (data?.cards || [])) {
      if (!card.compartment_id) continue;
      if (!byComp.has(card.compartment_id)) byComp.set(card.compartment_id, []);
      byComp.get(card.compartment_id).push(card);
    }
    return byComp;
  }, [data]);

  if (loading || error) {
    return (
      <main style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '80vh', padding: '1rem' }}>
        <div className="glass-panel" style={{ textAlign: 'center', maxWidth: '400px', width: '100%', padding: '2.5rem 1.5rem' }}>
          <p role="status">{loading ? t('common.loading') : ''}</p>
          {loading && <div className="spinner" aria-hidden="true" />}
          {error && <>
            <ShieldAlert size={48} aria-hidden="true" style={{ color: 'var(--accent-red)', marginBottom: '1rem' }} />
            <h1 style={{ color: 'var(--text-strong)', fontSize: '1.25rem', marginBottom: '0.5rem' }}>{t('shared.unavailable')}</h1>
            <p role="alert" style={{ color: 'var(--text-secondary)' }}>{error}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.75rem', marginTop: '1.5rem' }}>
              <button type="button" className="btn btn-primary" aria-disabled={loading} onClick={() => { if (!loading) setRetry(value => value + 1); }}>{t('common.retry')}</button>
              <a href="/" className="btn btn-secondary">{t('shared.goToManafolio')}</a>
            </div>
          </>}
        </div>
      </main>
    );
  }

  const { location, compartments = [], owner } = data;
  const binder = isBinderType(location.type);
  const pageProps = (compartment) => ({
    compartment,
    cards: cardsByCompartment.get(compartment.id) || [],
    allowStacking: !!location.allow_stacking,
    sortOrder: location.sort_order,
    locationType: location.type,
  });

  // Binders page through a spread at a time; a box shows one row at a time, the
  // same unit the owner's view scrolls through.
  const { leftIdx, rightIdx, spread } = binderSpread(Math.min(pageIndex, compartments.length - 1));
  const left = binder && leftIdx >= 0 ? compartments[leftIdx] : null;
  const right = binder ? compartments[rightIdx] : null;
  const activeRow = compartments[Math.min(pageIndex, compartments.length - 1)];
  const nextIndex = binder ? spread * 2 + 1 : pageIndex + 1;
  const prevIndex = binder ? (spread <= 1 ? 0 : (spread - 1) * 2 - 1) : pageIndex - 1;

  return (
    <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <Logo style={{ width: '34px', height: '34px', flexShrink: 0 }} />
        <div>
          <h1 style={{ margin: 0, fontSize: '1.2rem', color: 'var(--text-strong)' }}>{location.name}</h1>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('shared.sharedBy')} {owner}</span>
        </div>
      </div>

      {compartments.length === 0 ? (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('loc.noCompartments')}</p>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '1rem', background: 'rgba(0,0,0,0.1)', padding: '0.4rem', borderRadius: 'var(--radius-sm)' }}>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pageIndex <= 0}
              onClick={() => setPageIndex(Math.max(0, prevIndex))}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              {t('loc.prev')}
            </button>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {(binder ? (right || left) : activeRow)?.display_label}
            </span>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={nextIndex >= compartments.length}
              onClick={() => setPageIndex(nextIndex)}
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              {t('loc.next')}
            </button>
          </div>

          {binder ? (
            <div className="binder-page-container">
              <div className="binder-page-left">
                {left && <CompartmentView {...pageProps(left)} />}
              </div>
              <div className="binder-spine" />
              <div className="binder-page-right">
                {right && <CompartmentView {...pageProps(right)} />}
              </div>
            </div>
          ) : (
            activeRow && <CompartmentView {...pageProps(activeRow)} />
          )}
        </>
      )}
    </main>
  );
}

export default SharedContainer;
