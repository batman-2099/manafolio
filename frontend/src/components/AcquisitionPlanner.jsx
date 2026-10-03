import { useRef, useState } from 'react';
import Modal from './Modal';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';
import { downloadBlob } from '../utils/downloadBlob';
import { buildDeckExport } from '../utils/deckText';
import './AcquisitionPlanner.css';

export default function AcquisitionPlanner({ decks, onClose }) {
  const { t } = useT();
  const [selected, setSelected] = useState([]);
  const [preference, setPreference] = useState('exact');
  const [plan, setPlan] = useState(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [added, setAdded] = useState(null);
  const busy = useRef(false);
  const close = () => { if (busy.current) return false; onClose(); };
  useBackGuard(true, close);
  const reset = () => { setPlan(null); setConfirm(false); setAdded(null); setError(''); };
  const request = async (save = false) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch(`/api/decks/acquisition-plan${save ? '/wishlist' : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deck_ids: selected, preference, ...(save ? { confirmed: true, revision: plan.revision } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('planner.error'));
      if (save) { setAdded(data.added); setConfirm(false); setPlan(null); }
      else setPlan(data);
    } catch (err) { setError(err.message || t('planner.error')); setConfirm(false); }
    finally { busy.current = false; setPending(false); }
  };
  const money = (value, currency) => value === null ? t('planner.unknown') : `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  const eligible = decks.filter(deck => ['collection', 'arena'].includes(deck.inventory_type));
  return <Modal onClose={close} aria-labelledby="acquisition-title">
    <div className="glass-panel acquisition-planner" aria-busy={pending}>
      <h3 id="acquisition-title">{t('planner.title')}</h3>
      <p>{t('planner.rules')}</p>
      <fieldset disabled={pending}>
        <legend>{t('planner.decks')}</legend>
        {eligible.length === 0 && <p>{t('planner.empty')}</p>}
        <div className="acquisition-decks">{eligible.map(deck => <label key={deck.id}>
          <input type="checkbox" checked={selected.includes(deck.id)} onChange={event => {
            reset(); setSelected(event.target.checked ? [...selected, deck.id] : selected.filter(id => id !== deck.id));
          }} />
          <span>{deck.name} — {t(deck.inventory_type === 'arena' ? 'deck.arena' : 'deck.physical')}</span>
        </label>)}</div>
        <label htmlFor="acquisition-preference">{t('planner.preference')}</label>
        <select id="acquisition-preference" className="input-control" value={preference} onChange={event => { reset(); setPreference(event.target.value); }}>
          <option value="exact">{t('planner.exact')}</option><option value="any">{t('planner.any')}</option>
        </select>
        <button type="button" className="btn btn-secondary" disabled={!selected.length} onClick={() => request()}>{t('planner.preview')}</button>
      </fieldset>
      {error && <p role="alert" className="deck-source-error">{error}</p>}
      <div role="status">{pending ? t('common.loading') : added !== null ? t('planner.added', { count: added }) : ''}</div>
      {plan && <section aria-label={t('planner.preview')}>
        <p>{t(plan.inventory === 'arena' ? 'planner.arena' : 'planner.prices')}</p>
        {!plan.items.length && <p>{t('planner.emptyCards')}</p>}
        <ul className="acquisition-items">{plan.items.map(item => <li key={item.card_id}>
          <strong>{item.name}</strong>
          <div>{item.set_id?.toUpperCase()} {item.number} · {item.language}</div>
          <dl>{['required', 'owned', 'needed', 'wishlist', 'to_add'].map(key => <div key={key}><dt>{t(`planner.${key}`)}</dt><dd>{item[key]}</dd></div>)}</dl>
          <div>{t('planner.estimate')}: {money(item.estimated_cost, item.currency)}</div>
        </li>)}</ul>
        <p><strong>{t('planner.estimate')}: </strong>{Object.entries(plan.totals).map(([currency, value]) => money(value, currency)).join(' + ') || '—'}{plan.unknown > 0 && ` · ${t('planner.unpriced', { count: plan.unknown })}`}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        {plan.inventory === 'collection' && plan.items.some(item => item.to_add > 0) && (confirm ? <div className="acquisition-confirm">
          <p>{t('planner.confirm')}</p>
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => request(true)}>{t('planner.add')}</button>
        </div> : <button type="button" className="btn btn-primary" disabled={pending} onClick={() => setConfirm(true)}>{t('planner.add')}</button>)}
          <button type="button" className="btn btn-secondary" disabled={pending || !plan.items.some(item => item.needed > 0)} onClick={() => {
            const cards = plan.items.filter(item => item.needed > 0).map(item => ({ ...item, quantity: item.needed }));
            downloadBlob(new Blob([buildDeckExport(cards, preference === 'exact' ? 'mtga' : 'plain')], { type: 'text/plain;charset=utf-8' }), 'shopping-list.txt');
          }}>{t('planner.exportText')}</button>
        </div>
      </section>}
      <button type="button" className="btn btn-secondary" disabled={pending} onClick={close}>{t('common.close')}</button>
    </div>
  </Modal>;
}
