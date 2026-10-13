import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import Modal from './Modal';
import CardImage from './CardImage';
import CardImageZoom from './CardImageZoom';
import { useT } from '../utils/i18n';
import { displayName } from '../utils/languages';
import { useBackGuard } from '../utils/useBackGuard';

export default function StocktakeDialog({ location, onClose, onApplied }) {
  const { t, locale } = useT();
  const [snapshot, setSnapshot] = useState(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [zoomCard, setZoomCard] = useState(null);
  const [saved, setSaved] = useState(null);
  const saving = useRef(false);
  const changed = useRef(false);
  const panel = useRef(null);
  const focusAfterSave = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/locations/${location.id}/stocktake`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.code || 'stocktake.loadError');
        if (controller.signal.aborted) return;
        setSnapshot(data);
        setError(null);
      }).catch(err => {
        if (!controller.signal.aborted) setError({ message: err.message.startsWith('stocktake.') ? err.message : 'stocktake.loadError' });
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [location.id, attempt]);

  useEffect(() => {
    if (pending || !focusAfterSave.current) return;
    const { entryId, status } = focusAfterSave.current;
    panel.current?.querySelector(`[data-copy="${entryId}:0"] [data-status="${status}"]`)?.focus({ preventScroll: true });
    focusAfterSave.current = null;
  }, [snapshot, pending]);

  const close = () => {
    if (saving.current) return false;
    if (changed.current) onApplied();
    else onClose();
  };
  useBackGuard(true, close);
  useBackGuard(!!zoomCard, () => setZoomCard(null));

  const markCopy = async (entry, copyIndex, status) => {
    if (saving.current || loading || error) return;
    saving.current = true;
    const key = `${entry.entry_id}:${copyIndex}`;
    setPending({ key, status });
    setSaved(null);
    try {
      const response = await fetch(`/api/locations/${location.id}/stocktake`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, entry_id: entry.entry_id, copy_index: copyIndex, status }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code || 'stocktake.saveError');
      changed.current = true;
      focusAfterSave.current = { entryId: data.updated_entry_id, status };
      setSnapshot(data);
      setSaved({ name: displayName(entry) || entry.card_id, status });
    } catch (err) {
      setError({ key, message: err.message.startsWith('stocktake.') ? err.message : 'stocktake.saveError' });
    } finally {
      saving.current = false;
      setPending(null);
    }
  };

  return <Modal onClose={close} aria-labelledby="stocktake-title">
    <section ref={panel} className="glass-panel dialog-panel-spacing stocktake-panel">
      <div className="stocktake-heading">
        <h2 id="stocktake-title">{t('stocktake.title')} — {location.name}</h2>
        <button type="button" className="btn btn-secondary" disabled={!!pending} onClick={close}>{t('common.close')}</button>
      </div>
      <p>{t('stocktake.hint')}</p>
      {loading && <p role="status">{t('common.loading')}</p>}
      {error && <div role="alert" className="read-state">
        <p>{t(error.message)}</p>
        <button type="button" className="btn btn-secondary" disabled={loading || !!pending} onClick={() => { setSaved(null); setAttempt(value => value + 1); }}>{t('stocktake.reload')}</button>
      </div>}
      <p className="stocktake-status" role="status">{pending ? t('stocktake.applying') : saved ? `${t(`stocktake.${saved.status}`)}: ${saved.name}` : ''}</p>
      {snapshot && !snapshot.entries.length && <p>{t('stocktake.empty')}</p>}
      <ul className="stocktake-grid">
        {snapshot?.entries.flatMap(entry => Array.from({ length: entry.quantity }, (_, copyIndex) => {
          const key = `${entry.entry_id}:${copyIndex}`;
          const name = displayName(entry) || entry.card_id;
          const disabled = !!pending || loading || !!error;
          return <li key={key} data-copy={key} className="stocktake-card" aria-busy={pending?.key === key}>
            <button type="button" className="stocktake-image" aria-label={`${t('inspector.zoomHint')}: ${name}`} aria-haspopup="dialog" onClick={() => setZoomCard(entry)}>
              <CardImage card={entry} loading="lazy" />
            </button>
            <strong>{name}</strong>
            <span className="stocktake-meta">{t('stocktake.lastVerified', { date: entry.last_verified_at ? new Date(entry.last_verified_at).toLocaleDateString(locale) : t('stocktake.never') })}</span>
            {copyIndex < entry.reserved_quantity && <span className="stocktake-meta">{t('loc.inPlay')}</span>}
            {entry.quantity > 1 && <span className="stocktake-meta">{t('stocktake.copy', { number: copyIndex + 1, total: entry.quantity })}</span>}
            {error?.key === key && <p className="stocktake-error">{t(error.message)}</p>}
            <div className="stocktake-actions" role="group" aria-label={name}>
              <button type="button" data-status="verified" className="btn stocktake-verified" disabled={disabled} aria-pressed={!entry.missing && !!entry.last_verified_at} onClick={() => markCopy(entry, copyIndex, 'verified')}>
                <Check size={16} aria-hidden="true" /> {t('stocktake.verified')}
              </button>
              <button type="button" data-status="missing" className="btn stocktake-missing" disabled={disabled} aria-pressed={!!entry.missing} onClick={() => markCopy(entry, copyIndex, 'missing')}>
                <X size={16} aria-hidden="true" /> {t('stocktake.missing')}
              </button>
            </div>
          </li>;
        }))}
      </ul>
    </section>
    {zoomCard && <CardImageZoom card={zoomCard} onClose={() => setZoomCard(null)} />}
  </Modal>;
}
