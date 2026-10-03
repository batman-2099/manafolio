import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useT } from '../utils/i18n';
import { filterOfflineCards } from '../utils/offlineFilter';
import { useOfflineSnapshot } from './OfflineSettings';
import './OfflineCollection.css';

const PAGE_SIZE = 40;
const EMPTY_CARDS = [];

export default function OfflineCollection() {
  const { t, locale } = useT();
  useEffect(() => { document.title = `${t('offline.title')} · Manafolio`; }, [t]);
  const { snapshot, loading, busy, error, notice, supported, refresh, clear } = useOfflineSnapshot();
  const [filters, setFilters] = useState({ query: '', inventory: 'collection', color: '', finish: '', location: '' });
  const [page, setPage] = useState(1);
  const query = useDeferredValue(filters.query);
  const cards = snapshot?.cards || EMPTY_CARDS;
  const filtered = useMemo(() => filterOfflineCards(cards, { ...filters, query }), [cards, filters, query]);
  const finishes = useMemo(() => [...new Set(cards.map(card => card.printing).filter(Boolean))].sort(), [cards]);
  const locations = useMemo(() => [...new Map(cards.filter(card => card.list_type === 'collection' && card.location_id != null).map(card => [String(card.location_id), [card.storage_unit_name, card.location_name].filter(Boolean).join(' / ')])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [cards]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const update = (field, value) => {
    setFilters(previous => ({ ...previous, [field]: value, ...(field === 'inventory' ? { location: '' } : {}) }));
    setPage(1);
  };
  const finishLabel = finish => ({ Normal: t('offline.finish.normal'), Holofoil: t('offline.finish.foil'), Etched: t('offline.finish.etched') }[finish] || finish);
  const storageLabel = card => {
    if (card.list_type !== 'collection') return t('offline.notPhysical');
    if (card.location_id == null) return t('offline.unassigned');
    return [card.storage_unit_name, card.location_name,
      card.compartment_label || (card.compartment_idx != null ? t('offline.compartment', { number: card.compartment_idx }) : null),
      card.position > 0 ? t('offline.slot', { number: Math.floor(card.position / 1000) }) : null,
    ].filter(Boolean).join(' / ');
  };

  return (
    <main className="offline-collection">
      <header className="page-heading">
        <h1>{t('offline.title')}</h1>
        <a href="/">{t('offline.returnOnline')}</a>
      </header>
      <section className="view-section offline-summary" aria-label={t('offline.snapshot')}>
        <p className="offline-readonly"><strong>{t('offline.readOnly')}</strong> {t('offline.stale')}</p>
        {snapshot && <p>{t('offline.account', { username: snapshot.username })} · <time dateTime={snapshot.saved_at}>{t('offline.savedAt', { date: new Date(snapshot.saved_at).toLocaleString(locale) })}</time></p>}
        {!supported && <p>{t('offline.unsupported')}</p>}
        <div className="offline-actions">
          {snapshot && <button type="button" className="btn btn-primary" disabled={busy || !supported} onClick={refresh}>{t('offline.refresh')}</button>}
          <button type="button" className="btn btn-secondary offline-clear" disabled={busy || !supported} onClick={clear}>{t('offline.clear')}</button>
        </div>
        <div role="status" aria-live="polite">{loading ? t('offline.loading') : busy ? t('offline.working') : notice ? t(notice) : ''}</div>
        {error && <p role="alert">{t(error)}</p>}
      </section>
      {!loading && !snapshot && <section className="view-section offline-empty">
        <h2>{t('offline.noSnapshot')}</h2>
        <p>{t('offline.noSnapshotHint')}</p>
        <a href="/">{t('offline.returnOnline')}</a>
      </section>}
      {snapshot && <>
        <section className="offline-filters" aria-label={t('offline.filters')}>
          <label className="offline-search">{t('offline.search')}
            <input className="input-control" type="search" value={filters.query} onChange={event => update('query', event.target.value)} aria-describedby="offline-search-hint" />
            <span id="offline-search-hint">{t('offline.searchHint')}</span>
          </label>
          <label>{t('offline.inventory')}
            <select className="input-control" value={filters.inventory} onChange={event => update('inventory', event.target.value)}>
              {['collection', 'arena', 'wishlist'].map(value => <option key={value} value={value}>{t(`offline.inventory.${value}`)}</option>)}
            </select>
          </label>
          <label>{t('offline.color')}
            <select className="input-control" value={filters.color} onChange={event => update('color', event.target.value)}>
              <option value="">{t('offline.allColors')}</option>
              {['W', 'U', 'B', 'R', 'G', 'C'].map(value => <option key={value} value={value}>{t(`offline.color.${value}`)}</option>)}
            </select>
          </label>
          <label>{t('offline.finish')}
            <select className="input-control" value={filters.finish} onChange={event => update('finish', event.target.value)}>
              <option value="">{t('offline.allFinishes')}</option>
              {finishes.map(value => <option key={value} value={value}>{finishLabel(value)}</option>)}
            </select>
          </label>
          <label>{t('offline.location')}
            <select className="input-control" value={filters.location} disabled={filters.inventory !== 'collection'} onChange={event => update('location', event.target.value)}>
              <option value="">{t('offline.allLocations')}</option>
              <option value="unassigned">{t('offline.unassigned')}</option>
              {locations.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </section>
        <p role="status" aria-live="polite">{t('offline.results', { count: filtered.length, start: filtered.length ? start + 1 : 0, end: Math.min(start + PAGE_SIZE, filtered.length) })}</p>
        {!filtered.length ? <div className="view-section offline-empty"><p>{t(cards.length ? 'offline.noResults' : 'offline.emptySnapshot')}</p></div> : <ul className="offline-rows" aria-label={t('offline.resultsLabel')}>
          {filtered.slice(start, start + PAGE_SIZE).map(card => <li key={card.entry_id} className="offline-row">
            <div className="offline-card-name">
              <h2>{card.printed_name || card.name}</h2>
              {card.printed_name && card.printed_name !== card.name && <p>{card.name}</p>}
              <p>{card.set_name} ({card.set_id}) · {t('offline.collectorNumber', { number: card.number })}</p>
            </div>
            <dl className="offline-card-details">
              <div><dt>{t('offline.quantity')}</dt><dd>{card.quantity}</dd></div>
              <div><dt>{t('offline.missing')}</dt><dd>{card.missing ? card.quantity : 0}</dd></div>
              <div><dt>{t('offline.reserved')}</dt><dd>{card.reserved_quantity}</dd></div>
              <div><dt>{t('offline.finish')}</dt><dd>{finishLabel(card.printing) || t('offline.unknown')}</dd></div>
              <div><dt>{t('offline.language')}</dt><dd>{card.language || t('offline.unknown')}</dd></div>
              <div><dt>{t('offline.condition')}</dt><dd>{card.condition || t('offline.unknown')}</dd></div>
            </dl>
            <p className="offline-card-storage"><strong>{t('offline.location')}: </strong>{storageLabel(card)}</p>
          </li>)}
        </ul>}
        <nav className="offline-pagination" aria-label={t('offline.pagination')}>
          <button type="button" className="btn btn-secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t('offline.previous')}</button>
          <span>{t('offline.page', { current: currentPage, total: pages })}</span>
          <button type="button" className="btn btn-secondary" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{t('offline.next')}</button>
        </nav>
      </>}
    </main>
  );
}
