import { useEffect, useRef, useState } from 'react';
import Modal from './Modal';
import CardImage from './CardImage';
import { useT } from '../utils/i18n';
import { useBackGuard } from '../utils/useBackGuard';

export default function DeckHistory({ deck, saved, unsaved, onClose, onRestored }) {
  const { t } = useT();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [busy, setBusy] = useState(false);
  const comparisonRef = useRef(null);
  useBackGuard(true, () => busy ? false : onClose());
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setData(null);
    fetch(`/api/decks/${deck.id}/revisions`, { signal: controller.signal })
      .then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || t('history.error'));
        setData(body);
        setFromId(String(body.revisions[1]?.id ?? body.revisions[0]?.id ?? ''));
        setToId('current');
      }).catch(err => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, [deck.id, retry, t]);

  const revisions = data?.revisions || [];
  const from = revisions.find(row => String(row.id) === fromId)?.snapshot;
  const current = unsaved ? {
    ...saved, commander_card_id: deck.commander_card_id || null,
    format: deck.format, target_size: Number(deck.target_size), inventory_type: deck.inventory_type || 'collection',
    cards: deck.cards.map(card => ({ card_id: card.id, quantity: card.quantity, source_entry_id: card.source_entry_id ?? null })),
  } : saved;
  const to = toId === 'current' ? current : revisions.find(row => String(row.id) === toId)?.snapshot;
  const names = new Map([...(data?.cards || []), ...deck.cards].map(card => [card.id, card]));
  const cardName = id => {
    const card = names.get(id);
    return card ? `${card.printed_name || card.name} · ${card.set_name || ''} #${card.number || ''}` : id || t('history.none');
  };
  const before = new Map((from?.cards || []).map(card => [card.card_id, card]));
  const after = new Map((to?.cards || []).map(card => [card.card_id, card]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].filter(id =>
    before.get(id)?.quantity !== after.get(id)?.quantity
    || (before.get(id)?.source_entry_id ?? null) !== (after.get(id)?.source_entry_id ?? null)
    || (from?.commander_card_id === id) !== (to?.commander_card_id === id));
  const fields = ['commander_card_id', 'format', 'target_size', 'inventory_type'];
  const metadata = fields.filter(key => from && to && from[key] !== to[key]);
  const label = row => `#${revisions.length - revisions.indexOf(row)} · ${new Date(row.created_at).toLocaleString()} · ${t(`history.${row.kind === 'restore' ? 'restoreKind' : row.kind}`)}`;
  const restore = async () => {
    if (!from || busy || unsaved || deck.checked_out || !window.confirm(t('history.confirm'))) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/decks/${deck.id}/revisions/${fromId}/restore`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || t('history.error'));
      await onRestored();
      onClose();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  return <Modal onClose={() => { if (!busy) onClose(); }} aria-labelledby="deck-history-title">
    <section className="glass-panel deck-history-panel">
      <h2 id="deck-history-title">{t('history.title')}</h2>
      <p>{t('history.hint')}</p>
      {!data && !error && <p role="status">{t('common.loading')}</p>}
      {error && <p role="alert">{error} <button className="btn btn-secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button></p>}
      {data && !revisions.length && <p>{t('history.empty')}</p>}
      {!!revisions.length && <>
        <div className="deck-history-selectors">
          <label>{t('history.from')}<select className="select-control" value={fromId} disabled={busy} onChange={event => setFromId(event.target.value)}>
            {revisions.map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}
          </select></label>
          <label>{t('history.to')}<select className="select-control" value={toId} disabled={busy} onChange={event => setToId(event.target.value)}>
            <option value="current">{t(unsaved ? 'history.currentDraft' : 'history.current')}</option>
            {revisions.map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}
          </select></label>
        </div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => {
          setToId('current');
          comparisonRef.current?.focus();
        }}>{t('history.compareCurrent')}</button>
        <p>{t('history.direction')}</p>
        <ul className="deck-history-changes" ref={comparisonRef} tabIndex={-1} aria-label={t('history.comparison')}>
          {metadata.map(key => <li key={key}><strong>{t(`history.${key}`)}</strong><span>{key === 'commander_card_id' ? cardName(from[key]) : from[key]} → {key === 'commander_card_id' ? cardName(to[key]) : to[key]}</span></li>)}
          {changes.map(id => {
            const oldQuantity = before.get(id)?.quantity || 0;
            const newQuantity = after.get(id)?.quantity || 0;
            const kind = !oldQuantity ? 'added' : !newQuantity ? 'removed' : 'changed';
            const delta = newQuantity - oldQuantity;
            return <li key={id} className={`deck-history-card-change deck-history-card-change--${kind}`}>
              <CardImage card={names.get(id) || { id }} loading="lazy" />
              <div>
                <strong>{cardName(id)}</strong>
                <span className="deck-history-change-label">{t(`history.${kind}`)}</span>
                <span>{oldQuantity} → {newQuantity} ({delta > 0 ? '+' : ''}{delta})</span>
                {(from?.commander_card_id === id) !== (to?.commander_card_id === id) && <span>{t('history.commander_card_id')}: {t(from?.commander_card_id === id ? 'history.removed' : 'history.added')}</span>}
                {(before.get(id)?.source_entry_id ?? null) !== (after.get(id)?.source_entry_id ?? null) && <span>{t('history.source')}: {before.get(id)?.source_entry_id ?? t('history.none')} → {after.get(id)?.source_entry_id ?? t('history.none')}</span>}
              </div>
            </li>;
          })}
        </ul>
        {!changes.length && !metadata.length && <p>{t('history.identical')}</p>}
        {unsaved && <p role="status">{t('history.unsaved')}</p>}
        {!!deck.checked_out && <p>{t('history.checkedOut')}</p>}
        <button className="btn btn-primary" disabled={busy || unsaved || !!deck.checked_out} onClick={restore}>{t(busy ? 'deck.saving' : 'history.restore')}</button>
      </>}
      <button className="btn btn-secondary" disabled={busy} onClick={onClose}>{t('common.close')}</button>
    </section>
  </Modal>;
}
