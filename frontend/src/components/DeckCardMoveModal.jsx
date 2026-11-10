import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

export default function DeckCardMoveModal({ changes, pending, error, onSave, onClose }) {
  const { t } = useT();
  const [locations, setLocations] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [destination, setDestination] = useState('');
  const submitting = useRef(false);
  const hasRemovals = changes.removed.length > 0;
  useEffect(() => {
    if (!hasRemovals) return;
    const controller = new AbortController();
    setLocations(null);
    setLoadError(false);
    fetch(`/api/locations?inventory_type=${changes.inventory_type}`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(rows => {
        if (!controller.signal.aborted) setLocations(rows.filter(location =>
          location.id !== changes.container_id && !location.locked
          && (location.inventory_type || 'collection') === changes.inventory_type
          && [changes.game || 'mtg', 'any'].includes(location.game)));
      })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true); });
    return () => controller.abort();
  }, [hasRemovals, changes.inventory_type, changes.container_id, changes.game, retry]);

  const close = () => {
    if (pending || submitting.current) return false;
    onClose();
  };
  useBackGuard(true, close);
  const save = async move => {
    if (pending || submitting.current || (move && hasRemovals && !locations)) return;
    submitting.current = true;
    try {
      await onSave(move ? {
        container_id: changes.container_id,
        before_cards: changes.before_cards,
        removed_location_id: destination ? Number(destination) : null,
      } : undefined);
    } finally {
      submitting.current = false;
    }
  };

  return (
    <Modal onClose={close} aria-labelledby="deck-card-move-title" aria-describedby="deck-card-move-hint">
      <div className="glass-panel" aria-busy={pending} style={{ width: '560px', maxWidth: '100%', maxHeight: '90dvh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', overflowWrap: 'anywhere' }}>
        <h3 id="deck-card-move-title" style={{ margin: 0 }}>{t('deck.cardMoveTitle')}</h3>
        <p id="deck-card-move-hint" style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('deck.cardMoveHint')}</p>
        {['added', 'removed'].map(kind => changes[kind].length > 0 && (
          <section key={kind} aria-labelledby={`deck-card-move-${kind}`}>
            <h4 id={`deck-card-move-${kind}`} style={{ margin: 0 }}>{t(kind === 'added' ? 'deck.cardMoveAdded' : 'deck.cardMoveRemoved', { name: changes.container_name })}</h4>
            <ul style={{ marginBottom: 0, paddingInlineStart: '1.25rem' }}>
              {changes[kind].map(card => <li key={card.card_id}>{card.quantity} × {card.name}</li>)}
            </ul>
          </section>
        ))}
        {hasRemovals && <div className="form-group" style={{ margin: 0 }}>
          <label htmlFor="deck-card-move-destination">{t('deck.cardMoveDestination')}</label>
          <select id="deck-card-move-destination" className="input-control" value={destination} disabled={pending || !locations} onChange={event => setDestination(event.target.value)} style={{ minHeight: '44px', fontSize: '1rem' }}>
            <option value="">{t('deck.cardMoveUnassigned')}</option>
            {locations?.map(location => <option key={location.id} value={location.id}>{[location.storage_unit_name, location.name].filter(Boolean).join(' · ')}</option>)}
          </select>
          {!locations && !loadError && <p role="status">{t('deck.cardMoveLoading')}</p>}
          {loadError && <p role="alert">{t('deck.cardMoveLoadError')} <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button></p>}
        </div>}
        {pending && <p role="status" style={{ margin: 0 }}>{t('deck.saving')}</p>}
        {error && <p role="alert" className="deck-source-error" style={{ margin: 0 }}>{error} {t('deck.saveRetryHint')}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '0.5rem' }}>
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={close} style={{ minHeight: '44px', whiteSpace: 'normal' }}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => save(false)} style={{ minHeight: '44px', whiteSpace: 'normal' }}>{t('deck.cardMoveSkip')}</button>
          <button type="button" className="btn btn-primary" disabled={pending || (hasRemovals && !locations)} onClick={() => save(true)} style={{ minHeight: '44px', whiteSpace: 'normal' }}>{t('deck.cardMoveSave')}</button>
        </div>
      </div>
    </Modal>
  );
}
