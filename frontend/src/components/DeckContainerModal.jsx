import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import Modal from './Modal';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

export default function DeckContainerModal({ deck, onClose, onCreated }) {
  const { t } = useT();
  const [name, setName] = useState(deck.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const submitting = useRef(false);

  const close = () => {
    if (submitting.current) return false;
    onClose();
  };
  useBackGuard(true, close);

  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current || result || !name.trim()) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/decks/${deck.id}/container`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('deck.containerError'));
      setResult(data);
      if (!await onCreated()) setError(t('deck.containerRefreshError'));
    } catch (error) {
      setError(error.message || t('deck.containerError'));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Modal onClose={close} aria-labelledby="deck-container-title" aria-describedby="deck-container-explanation">
      <div className="glass-panel" style={{ width: '560px', maxWidth: '100%', maxHeight: '90dvh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', overflowWrap: 'anywhere' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <h3 id="deck-container-title" style={{ margin: 0 }}>{t('deck.createContainer')}</h3>
          <button type="button" className="btn btn-secondary btn-icon-only" disabled={pending} aria-label={t('common.close')} onClick={close} style={{ minWidth: '44px', minHeight: '44px', padding: 0 }}><X size={16} aria-hidden="true" /></button>
        </div>
        <p id="deck-container-explanation" style={{ margin: 0, color: 'var(--text-secondary)' }}>{t('deck.containerExplanation')}</p>
        <div role="status" aria-live="polite" aria-atomic="true">
          {pending && <p style={{ margin: 0 }}>{t(result ? 'deck.containerRefreshing' : 'deck.containerPending')}</p>}
          {result && <p style={{ margin: 0 }}>{t('deck.containerResult', { name: result.name, moved: result.count, requested: result.requested, missing: result.missing })}</p>}
        </div>
        {error && <p role="alert" className="deck-source-error" style={{ margin: 0 }}>{error}</p>}
        {result ? (
          <>
            {result.missing > 0 && (
              <section aria-labelledby="deck-container-shortages">
                <h4 id="deck-container-shortages">{t('deck.containerShortages')}</h4>
                <p>{t('deck.containerShortagesHint')}</p>
                <ul style={{ paddingInlineStart: '1.25rem' }}>
                  {result.items.filter(item => item.missing > 0).map(item => (
                    <li key={item.card_id}>{t('deck.containerShortage', { name: item.name, moved: item.moved, requested: item.requested, missing: item.missing })}</li>
                  ))}
                </ul>
              </section>
            )}
            <button type="button" className="btn btn-primary" disabled={pending} onClick={close} style={{ minHeight: '44px', alignSelf: 'flex-end' }}>{t('common.close')}</button>
          </>
        ) : (
          <form onSubmit={submit} aria-busy={pending}>
            <div className="form-group">
              <label htmlFor="deck-container-name">{t('container.name')}</label>
              <input id="deck-container-name" className="input-control" value={name} onChange={event => setName(event.target.value)} required disabled={pending} style={{ minHeight: '44px', fontSize: '1rem' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" disabled={pending} onClick={close} style={{ minHeight: '44px' }}>{t('common.cancel')}</button>
              <button type="submit" className="btn btn-primary" disabled={pending || !name.trim()} style={{ minHeight: '44px' }}>{t('deck.containerSubmit')}</button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
