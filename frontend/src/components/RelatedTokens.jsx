import { useEffect, useId, useRef, useState } from 'react';
import CardImage from './CardImage';
import Modal from './Modal';
import AddToDeckSelect from './AddToDeckSelect';
import { getSlotNumber } from '../utils/getSlotNumber';
import { useT } from '../utils/i18n';

const MTG_CARD_ID = /^mtg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function RelatedTokens({ cardIds = [], title, inventoryType = 'collection', commanderCardId, compact = false, onChanged, disabled = false }) {
  const { t } = useT();
  const headingId = useId();
  const idsKey = [...new Set((Array.isArray(cardIds) ? cardIds : [])
    .filter(id => typeof id === 'string' && MTG_CARD_ID.test(id))
    .map(id => id.toLowerCase()))].sort().join(',');
  const resultKey = `${inventoryType}:${commanderCardId || ''}:${idsKey}`;
  const [result, setResult] = useState({ key: '', status: 'loading', tokens: [] });
  const [attempt, setAttempt] = useState(0);
  const [previewToken, setPreviewToken] = useState(null);

  useEffect(() => {
    if (!idsKey) return;
    const controller = new AbortController();
    setResult({ key: resultKey, status: 'loading', tokens: [] });
    async function load() {
      try {
        const response = await fetch('/api/cards/related-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            card_ids: idsKey.split(','),
            inventory_type: inventoryType,
            ...(commanderCardId ? { commander_card_id: commanderCardId } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Token lookup failed');
        const data = await response.json();
        if (!Array.isArray(data.tokens)) throw new Error('Invalid token response');
        if (!controller.signal.aborted) {
          setResult({ key: resultKey, status: 'ready', tokens: data.tokens });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult({ key: resultKey, status: 'error', tokens: [] });
        }
      }
    }
    load();
    return () => controller.abort();
  }, [idsKey, inventoryType, commanderCardId, resultKey, attempt]);

  if (!idsKey) return null;
  const status = result.key === resultKey ? result.status : 'loading';

  return (
    <section className={compact ? 'related-tokens-compact' : undefined} aria-labelledby={headingId} style={{ minWidth: 0, borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
      <h3 id={headingId} style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{title ?? t('relatedTokens.title')}</h3>
      {status === 'loading' && <p role="status">{t('relatedTokens.loading')}</p>}
      {status === 'error' && (
        <div>
          <p role="alert" style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('relatedTokens.error')}</p>
          <button type="button" className="btn btn-secondary" onClick={() => setAttempt(value => value + 1)}>{t('relatedTokens.retry')}</button>
        </div>
      )}
      {status === 'ready' && (result.tokens.length === 0 ? (
        <p role="status" style={{ color: 'var(--text-muted)' }}>{t('relatedTokens.empty')}</p>
      ) : (
        <ul className={compact ? 'related-token-list' : 'card-grid'} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {result.tokens.map(token => (
            <li key={token.id} className={compact ? 'related-token-item' : undefined} style={compact ? { minWidth: 0, overflowWrap: 'anywhere' } : { display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0, background: 'var(--surface-1)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', overflowWrap: 'anywhere' }}>
              <button type="button" className={compact ? 'related-token-art ci-image-wrap' : 'ci-image-wrap'} aria-label={`${t('deck.previewArt')}: ${token.name}`} aria-haspopup="dialog" onClick={() => setPreviewToken({ ...token, id: token.matched_card_id || token.id })}>
                <CardImage card={{ ...token, id: token.matched_card_id || token.id }} game="mtg" loading="lazy" style={{ width: '100%', aspectRatio: '5 / 7', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} />
                <span>{t('deck.previewArt')}</span>
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{token.name}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {t(inventoryType === 'arena'
                    ? token.owned ? 'relatedTokens.ownedArena' : 'relatedTokens.notOwnedArena'
                    : token.owned ? 'relatedTokens.owned' : 'relatedTokens.notOwned')}
                  {token.owned && token.owned_qty != null && ` · ${token.owned_qty}×`}
                </span>
              </div>
              {token.owned && inventoryType === 'collection' && (
                <ul style={{ listStyle: 'none', margin: '0.25rem 0 0', padding: 0, color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  {token.locations.map((location, index) => {
                    const slot = getSlotNumber(location);
                    return (
                      <li key={index}>
                        {location.quantity != null && `${location.quantity}× · `}
                        {location.location_name
                          ? `${location.location_name}${location.compartment_display ? ` • ${location.compartment_display}` : ''}${slot !== null ? ` • ${t('wizard.slot', { slot })}` : ''}`
                          : t('bulk.unassignedPile')}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {t('relatedTokens.createdBy')}
                {[...new Set(token.source_cards.map(source => source.name))].map(name => (
                  <span key={name} style={{ display: 'block' }}>{name}</span>
                ))}
              </p>
              </div>
            </li>
          ))}
        </ul>
      ))}
      {previewToken && <TokenViewer token={previewToken} inventoryType={inventoryType} disabled={disabled} onClose={() => setPreviewToken(null)} onChanged={deckId => { setAttempt(value => value + 1); onChanged?.(deckId); }} />}
    </section>
  );
}

function TokenViewer({ token, inventoryType, disabled, onClose, onChanged }) {
  const { t } = useT();
  const [locations, setLocations] = useState([]);
  const [locationsError, setLocationsError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sourceEntryId, setSourceEntryId] = useState(token.source_entry_id || '');

  useEffect(() => {
    if (inventoryType === 'arena') return;
    const controller = new AbortController();
    setLocationsError(false);
    fetch(`/api/locations?inventory_type=${inventoryType}`, { signal: controller.signal })
      .then(response => { if (!response.ok) throw new Error(); return response.json(); })
      .then(items => { if (!controller.signal.aborted) setLocations(items); })
      .catch(() => { if (!controller.signal.aborted) setLocationsError(true); });
    return () => controller.abort();
  }, [inventoryType, attempt]);

  async function add(kind, destination) {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      let quantity = 1;
      const source = token.owned_entries?.find(entry => String(entry.entry_id) === String(sourceEntryId));
      const cardId = kind === 'deck' && source ? source.card_id : token.id;
      if (kind === 'deck') {
        const response = await fetch(`/api/decks/${destination}`);
        const deck = await response.json();
        if (!response.ok) throw new Error(deck.error || t('inspector.errAddDeck'));
        quantity += deck.cards.find(card => card.id === cardId)?.quantity || 0;
      }
      const response = await fetch(kind === 'deck' ? `/api/decks/${destination}/cards` : '/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'deck'
          ? { card_id: cardId, quantity, ...(inventoryType === 'collection' && sourceEntryId ? { source_entry_id: Number(sourceEntryId) } : {}) }
          : { card_id: token.id, quantity: 1, list_type: inventoryType, location_id: Number(destination), condition: 'Near Mint', printing: 'Normal', language: token.language || 'English' }),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved.error || t('search.errAddCard'));
      setMessage(kind === 'deck' ? t('inspector.addedToDeck') : saved.placement
        ? t('search.addedToContainer', { name: token.name, location: saved.placement.label })
        : t('search.addedUnassigned', { name: token.name }));
      onChanged(kind === 'deck' ? Number(destination) : null);
    } catch (failure) {
      setError(failure.message || t('search.errAddCard'));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal onClose={() => { if (!pending.current) onClose(); }} aria-label={token.name}>
      <div className="glass-panel" style={{ width: 'min(440px, 100%)', maxHeight: '90dvh', overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{t('common.close')}</button>
        <CardImage card={token} style={{ width: '100%', maxHeight: '55dvh', objectFit: 'contain' }} />
        {inventoryType === 'collection' && token.owned_entries?.length > 0 && <label>
          {t('token.source')}
          <select className="select-control" disabled={busy || disabled} value={sourceEntryId} onChange={event => setSourceEntryId(event.target.value)}>
            {token.owned_entries.map(entry => <option key={entry.entry_id} value={entry.entry_id}>{entry.quantity}× · {entry.location_name || t('bulk.unassignedPile')}{entry.compartment_display ? ` · ${entry.compartment_display}` : ''} · #{entry.entry_id}</option>)}
          </select>
        </label>}
        <AddToDeckSelect disabled={busy || disabled} onAdd={id => add('deck', id)} style={{ width: '100%' }} />
        {inventoryType !== 'arena' && (
          <select className="select-control" aria-label={t('relatedTokens.addToContainer')} value="" disabled={disabled || busy || !locations.length} onChange={event => { if (event.target.value) add('container', event.target.value); }}>
            <option value="">{t('relatedTokens.addToContainer')}</option>
            {locations.map(location => <option key={location.id} value={location.id} disabled={!!location.locked}>{location.name}</option>)}
          </select>
        )}
        {locationsError && <div role="alert">{t('inspector.errLocations')} <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button></div>}
        {disabled && <p role="status">{t('deck.saveFirst')}</p>}
        {error && <p role="alert">{error}</p>}
        {message && <p role="status">{message}</p>}
      </div>
    </Modal>
  );
}
