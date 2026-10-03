import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';
import { displayName } from '../utils/languages';
import { getSlotNumber } from '../utils/getSlotNumber';
import { useBackGuard } from '../utils/useBackGuard';

export default function StocktakeDialog({ location, onClose, onApplied }) {
  const { t } = useT();
  const [snapshot, setSnapshot] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [missingQuantities, setMissingQuantities] = useState({});
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const heading = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    fetch(`/api/locations/${location.id}/stocktake`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.code || 'stocktake.loadError');
        setSnapshot(data);
      }).catch(err => { if (err.name !== 'AbortError') setError(err.message.startsWith('stocktake.') ? err.message : 'stocktake.loadError'); });
    return () => controller.abort();
  }, [location.id, attempt]);
  useEffect(() => { heading.current?.focus(); }, [review]);
  const selected = Object.entries(decisions).filter(([, status]) => status).map(([id, status]) => ({
    entry_id: Number(id), status,
    ...(status === 'missing' ? { missing_quantity: Number(missingQuantities[id]) } : {}),
  }));
  const close = () => {
    if (busy) return false;
    if (selected.length && !window.confirm(t('stocktake.confirmDiscard'))) return false;
    onClose();
  };
  useBackGuard(true, close);
  const validate = () => {
    const invalid = snapshot.entries.some(entry => decisions[entry.entry_id] === 'missing' && (
      !Number.isInteger(Number(missingQuantities[entry.entry_id]))
      || Number(missingQuantities[entry.entry_id]) < 1
      || Number(missingQuantities[entry.entry_id]) > entry.quantity
    ));
    if (invalid) setError('stocktake.invalidQuantity');
    return !invalid;
  };
  const apply = async () => {
    if (!validate()) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/locations/${location.id}/stocktake`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: snapshot.revision, decisions: selected }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.code || 'stocktake.saveError');
      onApplied();
    } catch (err) {
      setError(err.message.startsWith('stocktake.') ? err.message : 'stocktake.saveError');
      setBusy(false);
    }
  };
  return <Modal onClose={close} aria-labelledby="stocktake-title">
    <form onSubmit={event => { event.preventDefault(); if (review) apply(); else if (validate()) setReview(true); }} className="glass-panel dialog-panel-spacing" style={{ width: '700px', maxWidth: '100%', maxHeight: '90dvh', overflowY: 'auto', overscrollBehavior: 'contain', background: 'var(--bg-secondary)', overflowWrap: 'anywhere' }}>
      <h2 id="stocktake-title" ref={heading} tabIndex={-1}>{t(review ? 'stocktake.review' : 'stocktake.title')} — {location.name}</h2>
      <p>{t('stocktake.hint')}</p>
      {error && <p role="alert">{t(error)}</p>}
      {!snapshot && !error && <p role="status">{t('common.loading')}</p>}
      {!snapshot && error && <button type="button" className="btn btn-secondary" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button>}
      {snapshot && <>
        {!snapshot.entries.length && <p>{t('stocktake.empty')}</p>}
        {review && <p role="status">{t('stocktake.summary', { reviewed: selected.length, unchanged: snapshot.entries.length - selected.length })}</p>}
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {snapshot.entries.map(entry => <li key={entry.entry_id} style={{ paddingBlock: '1rem', borderBottom: '1px solid var(--border-glass)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <CardImage card={entry} loading="lazy" style={{ width: '72px', aspectRatio: '5 / 7', objectFit: 'contain', borderRadius: '4px', flexShrink: 0 }} />
              <strong style={{ minWidth: 0 }}>{displayName(entry) || entry.card_id}</strong>
            </div>
            <div>{entry.set_name || entry.set_id} · #{entry.number} · {entry.printing} · {entry.language} · {entry.condition}</div>
            <div>{entry.compartment_label} · {t('stocktake.slot', { slot: getSlotNumber(entry) ?? '—' })} · {t('stocktake.quantity', { quantity: entry.quantity })}</div>
            {!!entry.missing && <div>{t('stocktake.currentMissing')}</div>}
            {entry.reserved_quantity > 0 ? <p>{t('stocktake.reserved', { quantity: entry.reserved_quantity })}</p>
              : review ? <p><strong>{t(`stocktake.${decisions[entry.entry_id] || 'unreviewed'}`)}</strong> · {decisions[entry.entry_id] === 'missing'
                ? t('stocktake.copySummary', { missing: Number(missingQuantities[entry.entry_id]), found: entry.quantity - Number(missingQuantities[entry.entry_id]) })
                : t('stocktake.quantity', { quantity: entry.quantity })}</p>
                : <>
                <label style={{ display: 'grid', gap: '0.4rem', marginTop: '0.5rem' }}>
                  <span>{t('stocktake.decision', { quantity: entry.quantity })}</span>
                  <select className="select-control" style={{ width: '100%', minHeight: '44px' }} value={decisions[entry.entry_id] || ''} onChange={event => {
                    setDecisions(current => ({ ...current, [entry.entry_id]: event.target.value }));
                    if (event.target.value === 'missing') setMissingQuantities(current => ({ ...current, [entry.entry_id]: String(entry.quantity) }));
                  }}>
                    <option value="">{t('stocktake.unreviewed')}</option>
                    <option value="verified">{t('stocktake.verified')}</option>
                    <option value="missing">{t('stocktake.missing')}</option>
                  </select>
                </label>
                {decisions[entry.entry_id] === 'missing' && <label style={{ display: 'grid', gap: '0.4rem', marginTop: '0.5rem' }}>
                  <span>{t('stocktake.missingQuantity')}</span>
                  <input type="number" className="input-control" min={1} max={entry.quantity} step={1} required
                    style={{ width: '100%', minHeight: '44px' }} value={missingQuantities[entry.entry_id] ?? ''}
                    onChange={event => setMissingQuantities(current => ({ ...current, [entry.entry_id]: event.target.value }))} />
                </label>}
                </>}
          </li>)}
        </ul>
      </>}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>{t('common.cancel')}</button>
        {review && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setReview(false)}>{t('common.back')}</button>}
        {snapshot && <button type="submit" className="btn btn-primary" disabled={busy || !selected.length}>{t(busy ? 'stocktake.applying' : review ? 'stocktake.apply' : 'stocktake.review')}</button>}
      </div>
    </form>
  </Modal>;
}
