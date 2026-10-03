import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../utils/i18n';
import { CONDITIONS, getPrintings, getLanguageNamesForGame } from '../utils/cardOptions';
import CardImage from './CardImage';
import './TradeWorkbench.css';

async function api(path, body, signal) {
  const response = await fetch(`/api/${path}`, { signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}
const identity = card => `${card.printed_name || card.name} · ${card.set_name || card.set_id} #${card.number} · ${card.language}`;
// getRandomValues also works on self-hosted HTTP LAN sites.
const newTradeId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const PAGE_SIZE = 60;
const MAX_ROWS = 100;

export default function TradeWorkbench({ onUpdate, navigationGuardRef }) {
  const { t } = useT();
  const [entries, setEntries] = useState([]);
  const [giving, setGiving] = useState([]);
  const [receiving, setReceiving] = useState([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useState('English');
  const [results, setResults] = useState(null);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);
  const [uncertain, setUncertain] = useState(false);
  const tradeId = useRef(null);
  if (tradeId.current === null) tradeId.current = newTradeId();
  const heading = useRef(null);
  const requestController = useRef(null);
  const load = useCallback(async (signal) => {
    setLoading(true);
    try { setEntries(await api('trades/entries', null, signal)); setPage(1); }
    catch (err) { if (err.name !== 'AbortError') setError(err.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => { controller.abort(); requestController.current?.abort(); };
  }, [load]);
  useEffect(() => {
    const guard = () => !(giving.length || receiving.length) || (!busy && !uncertain && window.confirm(t('trade.leave')));
    navigationGuardRef.current = guard;
    const beforeUnload = event => { if (giving.length || receiving.length) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { navigationGuardRef.current = null; window.removeEventListener('beforeunload', beforeUnload); };
  }, [giving.length, receiving.length, busy, uncertain, navigationGuardRef, t]);
  const run = async fn => {
    setBusy(true); setError('');
    requestController.current = new AbortController();
    try { await fn(requestController.current.signal); }
    catch (err) { if (err.name !== 'AbortError') setError(err.message); }
    finally { setBusy(false); }
  };
  const reset = () => {
    setGiving([]); setReceiving([]); setReview(null); setError(''); setUncertain(false);
    tradeId.current = newTradeId();
  };
  const money = (value, currency) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  const total = rows => {
    const sums = {};
    for (const row of rows) if (row.estimate !== null) sums[row.currency] = (sums[row.currency] || 0) + row.estimate * row.quantity;
    return Object.entries(sums).map(([currency, value]) => `${money(value, currency)} ${currency}`).join(' + ') || t('trade.unknown');
  };
  const draft = () => ({ trade_id: tradeId.current,
    giving: giving.map(({ entry_id, quantity, snapshot }) => ({ entry_id, quantity: Number(quantity), snapshot })),
    receiving: receiving.map(({ id, quantity, printing, language: lang, condition }) => ({ card_id: id, quantity: Number(quantity), printing, language: lang, condition })) });
  const selectedIds = new Set(giving.map(card => card.entry_id));
  const available = new Map(entries.map(card => [card.entry_id, card]));
  const staleIds = new Set(giving.filter(card => available.get(card.entry_id)?.snapshot !== card.snapshot).map(card => card.entry_id));
  const remaining = entries.filter(card => !selectedIds.has(card.entry_id));
  const matching = remaining.filter(card => identity(card).toLowerCase().includes(filter.toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  // ponytail: bound result rendering only; selected trade entries stay intact across pages.
  const pageEntries = matching.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = (rows, setRows, side) => rows.map((card, index) => {
    const maxQuantity = side === 'giving' ? Math.min(250, card.available) : 250;
    const errorId = `trade-${side}-${index}-quantity-error`;
    return <li key={`${card.entry_id || card.id}-${index}`}>
      <strong>{identity(card)}</strong>
      {side === 'giving' && <p>{card.location_name || t('trade.unassigned')} · {card.compartment_label || card.compartment_idx || '—'} · #{card.entry_id} · {card.printing} · {card.condition}{card.grader !== 'Raw' ? ` · ${card.grader} ${card.grade || ''} ${card.cert_number || ''}` : ''}</p>}
      {side === 'giving' && staleIds.has(card.entry_id) && <p className="trade-error" role="alert">{t('trade.staleEntry')}</p>}
      <div className="trade-fields">
        <label>{t('card.quantity')}<input className="input-control" type="number" required step="1" min="1" max={maxQuantity} form="trade-review-form" value={card.quantity}
          aria-invalid={card.quantityInvalid || undefined} aria-describedby={card.quantityInvalid ? errorId : undefined}
          onInvalid={() => setRows(current => current.map((row, i) => i === index ? { ...row, quantityInvalid: true } : row))}
          onChange={event => { const { value, validity } = event.target; setRows(rows.map((row, i) => i === index ? { ...row, quantity: value, quantityInvalid: !validity.valid } : row)); }} />
          {card.quantityInvalid && <span className="trade-error" id={errorId} role="alert">{t('trade.quantityError', { max: maxQuantity })}</span>}
        </label>
        {side === 'receiving' && <>
          <label>{t('card.printing')}<select className="select-control" value={card.printing} onChange={event => setRows(rows.map((row, i) => i === index ? { ...row, printing: event.target.value } : row))}>{getPrintings().map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label>{t('card.condition')}<select className="select-control" value={card.condition} onChange={event => setRows(rows.map((row, i) => i === index ? { ...row, condition: event.target.value } : row))}>{CONDITIONS.map(option => <option key={option}>{option}</option>)}</select></label>
        </>}
        <button className="btn btn-secondary" onClick={() => setRows(rows.filter((_, i) => i !== index))}>{t('trade.remove')}</button>
      </div>
    </li>;
  });
  return <section className="trade-workbench glass-panel" aria-labelledby="trade-title">
    <h2 id="trade-title" ref={heading} tabIndex={-1}>{t('trade.title')}</h2>
    <p>{t('trade.intro')}</p>
    {error && <p role="alert" className="trade-error">{error} {uncertain && t('trade.retry')}</p>}
    {success && <p role="status">{t('trade.success', success)}</p>}
    {review ? <>
      <h3>{t('trade.review')}</h3>
      <p>{t('trade.estimates')}</p>
      <div className="trade-columns">{['giving', 'receiving'].map(side => <section key={side}>
        <h3>{t(`trade.${side}`)} — {total(review[side])}</h3>
        <ul className="trade-list">{review[side].map((card, index) => <li key={index} style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
          <CardImage card={card} loading="lazy" style={{ width: '72px', aspectRatio: '5 / 7', objectFit: 'contain', borderRadius: '4px', flexShrink: 0 }} />
          <div style={{ minWidth: 0 }}>
          <strong>{card.quantity} × {identity(card)}</strong><p>{card.printing} · {card.condition}{card.entry_id ? ` · #${card.entry_id} · ${card.location_name || t('trade.unassigned')}` : ` · ${t('trade.unassigned')}`}</p>
          <p>{card.estimate === null ? t('trade.unknown') : `${money(card.estimate * card.quantity, card.currency)} ${card.currency}`} {card.quoted_at && ` · ${card.quoted_at}`}</p>
          </div>
        </li>)}</ul>
        {review[side].some(card => card.estimate === null) && <p>{t('trade.incomplete')}</p>}
      </section>)}</div>
      <p>{t('trade.difference')}: {['USD', 'EUR'].filter(currency => [...review.giving, ...review.receiving].some(card => card.currency === currency && card.estimate !== null)).map(currency => `${money(review.receiving.filter(card => card.currency === currency).reduce((sum, card) => sum + (card.estimate || 0) * card.quantity, 0) - review.giving.filter(card => card.currency === currency).reduce((sum, card) => sum + (card.estimate || 0) * card.quantity, 0), currency)} ${currency}`).join(' / ') || t('trade.unknown')}</p>
      <div className="trade-actions">
        <button className="btn btn-secondary" disabled={busy || uncertain} onClick={() => { setReview(null); setError(''); }}>{t('common.back')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(async signal => {
          setUncertain(true);
          let result;
          try { result = await api('trades/confirm', review.request, signal); }
          catch (err) { if (err.status) setUncertain(false); throw err; }
          reset(); setSuccess(result); onUpdate(); await load(signal); heading.current?.focus();
        })}>{busy ? t('common.loading') : t('trade.confirm')}</button>
      </div>
    </> : <>
      <fieldset disabled={busy} className="trade-editor">
        <div className="trade-columns">
          <section><h3>{t('trade.giving')}</h3><p>{t('trade.eligible')}</p>
            <label>{t('trade.filter')}<input className="input-control" value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }} /></label>
            <button className="btn btn-secondary" disabled={loading} onClick={() => { setError(''); load(); }}>{t('trade.refresh')}</button>
            {giving.length >= MAX_ROWS && <p id="trade-giving-limit" role="status">{t('trade.rowLimit', { max: MAX_ROWS })}</p>}
            {loading ? <p role="status">{t('common.loading')}</p> : <>
              <ul className="trade-list trade-results">{pageEntries.map(card => <li key={card.entry_id}><strong>{identity(card)}</strong><p>{card.quantity} × {card.printing} · {card.condition} · {card.location_name || t('trade.unassigned')} · #{card.entry_id}</p><button className="btn btn-secondary" disabled={giving.length >= MAX_ROWS} aria-describedby={giving.length >= MAX_ROWS ? 'trade-giving-limit' : undefined} onClick={() => { if (giving.length >= MAX_ROWS) return; setSuccess(null); setGiving([...giving, { ...card, available: card.quantity, quantity: 1 }]); }}>{t('trade.add')}</button></li>)}</ul>
              {pageCount > 1 && <nav className="trade-pagination" aria-label={t('trade.pagination')}>
                <button className="btn btn-secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t('collection.previousPage')}</button>
                <span role="status">{t('collection.pageCount', { page: currentPage, count: pageCount })}<br />{t('collection.pageRange', { start: (currentPage - 1) * PAGE_SIZE + 1, end: Math.min(currentPage * PAGE_SIZE, matching.length), count: matching.length })}</span>
                <button className="btn btn-secondary" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>{t('collection.nextPage')}</button>
              </nav>}
              {!entries.length ? <p role="status">{t('trade.empty')}</p> : !remaining.length ? <p role="status">{t('trade.allSelected')}</p> : !matching.length && <div><p role="status">{t('trade.noMatches')}</p><button className="btn btn-secondary" onClick={() => { setFilter(''); setPage(1); }}>{t('trade.clearFilter')}</button></div>}
            </>}
            <ul className="trade-list">{selected(giving, setGiving, 'giving')}</ul>
          </section>
          <section><h3>{t('trade.receiving')}</h3><p>{t('trade.destination')}</p>
            <form onSubmit={event => { event.preventDefault(); run(async signal => { setResults(await api(`search?${new URLSearchParams({ name: query, lang: language, prints: '1', scope: 'database', limit: '60' })}`, null, signal)); }); }}>
              <label>{t('trade.search')}<input className="input-control" value={query} required onChange={event => setQuery(event.target.value)} /></label>
              <label>{t('card.language')}<select className="select-control" value={language} onChange={event => setLanguage(event.target.value)}>{getLanguageNamesForGame('mtg').map(lang => <option key={lang}>{lang}</option>)}</select></label>
              <button className="btn btn-secondary" type="submit">{t('trade.search')}</button>
            </form>
            {receiving.length >= MAX_ROWS && <p id="trade-receiving-limit" role="status">{t('trade.rowLimit', { max: MAX_ROWS })}</p>}
            {results && <><p>{t('trade.refine')}</p><ul className="trade-list trade-results">{results.map(card => <li key={card.id}><strong>{identity(card)}</strong><button className="btn btn-secondary" disabled={receiving.length >= MAX_ROWS} aria-describedby={receiving.length >= MAX_ROWS ? 'trade-receiving-limit' : undefined} onClick={() => { if (receiving.length >= MAX_ROWS) return; setSuccess(null); setReceiving([...receiving, { ...card, quantity: 1, printing: 'Normal', condition: 'Near Mint' }]); }}>{t('trade.add')}</button></li>)}</ul>{!results.length && <p>{t('trade.emptySearch')}</p>}</>}
            <ul className="trade-list">{selected(receiving, setReceiving, 'receiving')}</ul>
          </section>
        </div>
      </fieldset>
      <form id="trade-review-form" className="trade-actions" onSubmit={event => {
        event.preventDefault();
        if (busy || loading || staleIds.size || !giving.length || !receiving.length || giving.length > MAX_ROWS || receiving.length > MAX_ROWS) return;
        run(async signal => { setReview(await api('trades/review', draft(), signal)); heading.current?.focus(); });
      }}><button type="button" className="btn btn-secondary" disabled={busy} onClick={reset}>{t('common.cancel')}</button><button type="submit" className="btn btn-primary" disabled={busy || loading || staleIds.size > 0 || !giving.length || !receiving.length}>{busy ? t('common.loading') : t('trade.review')}</button></form>
    </>}
  </section>;
}
