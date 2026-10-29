import { useEffect, useMemo, useRef, useState } from 'react';
import './CatalogueWorkbench.css';
import { useT } from '../utils/i18n';
import CardImageZoom from './CardImageZoom';
import CardImage from './CardImage';
import { priceText } from '../utils/formatPrice';
import { getPrintingPrice } from '../utils/resolveCardPrice';
import MultiSelectDropdown from './MultiSelectDropdown';
import { getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';

export default function SetCompletion() {
  const { t, locale } = useT();
  const [sets, setSets] = useState(null);
  const [code, setCode] = useState('');
  const [inventory, setInventory] = useState('collection');
  const [goal, setGoal] = useState('printings');
  const [filter, setFilter] = useState('missing');
  const [state, setState] = useState(null);
  const [retry, setRetry] = useState(0);
  const [setsError, setSetsError] = useState(false);
  const [card, setCard] = useState(null);
  const [page, setPage] = useState(1);
  const [wishlistAction, setWishlistAction] = useState(null);
  const wishlistPending = useRef(false);
  const scope = `${code}:${inventory}:${retry}`;

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/sets', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('sets');
      const data = await response.json();
      if (!Array.isArray(data) || !data.length) throw new Error('sets');
      if (!controller.signal.aborted) { setSets(data); setSetsError(false); }
    }).catch(() => { if (!controller.signal.aborted) setSetsError(true); });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    if (!code) return;
    const controller = new AbortController();
    fetch(`/api/sets/${encodeURIComponent(code)}/completion?inventory_type=${inventory}`, { signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.code === 'DEMO_UNAVAILABLE' ? 'demo' : 'catalog');
        if (!controller.signal.aborted) setState({ scope, data });
      }).catch(error => { if (!controller.signal.aborted) setState({ scope, error: error.message }); });
    return () => controller.abort();
  }, [code, inventory, scope]);

  const current = state?.scope === scope ? state : null;
  const setOptions = useMemo(() => [...(sets || [])]
    .sort((a, b) => (b.release_date || '').localeCompare(a.release_date || '') || a.name.localeCompare(b.name, locale))
    .map(set => ({
      value: set.id,
      searchText: `${set.name} ${set.id}`,
      label: <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 }}>
        {set.symbol_url && <img src={set.symbol_url} alt="" width={20} height={20} loading="lazy" style={{ objectFit: 'contain', background: 'var(--symbol-background)', borderRadius: '3px', padding: '2px', flexShrink: 0 }} onError={event => { event.currentTarget.style.display = 'none'; }} />}
        <span>{set.name} ({set.id.replace(/^mtg-/, '').toUpperCase()})</span>
      </span>,
    })), [sets, locale]);
  const result = current?.data?.goals[goal];
  const rows = result?.rows
    .filter(row => filter === 'all' || row.owned === (filter === 'owned'))
    .flatMap(row => row.printings.map(printing => ({ printing, owned: row.owned }))) || [];
  const pages = Math.max(1, Math.ceil(rows.length / 60));
  const currentPage = Math.min(page, pages);
  const select = (setter, value) => { setter(value); setPage(1); };
  const pagination = pages > 1 && <nav aria-label={t('collection.pagination')} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBlock: '1rem' }}>
    <button className="btn btn-secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t('collection.previousPage')}</button>
    <span>{t('collection.pageCount', { page: currentPage, count: pages })}</span>
    <button className="btn btn-secondary" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{t('collection.nextPage')}</button>
  </nav>;

  const addToWishlist = async (printing, finish) => {
    if (wishlistPending.current) return;
    wishlistPending.current = true;
    const key = `${printing.id}:${goal}`;
    setWishlistAction({ key, pending: true });
    try {
      const response = await fetch('/api/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          card_id: printing.id, quantity: 1, list_type: 'wishlist',
          printing: finish,
          language: printing.language || 'English',
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setWishlistAction({ key, error: body?.error || t('search.errAddCard') });
        return;
      }
      setWishlistAction({ key });
    } catch {
      setWishlistAction({ key, error: t('completion.wishlistError') });
    } finally {
      wishlistPending.current = false;
    }
  };

  return <section className="set-completion-workbench" aria-labelledby="completion-title">
    <h2 id="completion-title">{t('completion.title')}</h2>
    <p style={{ color: 'var(--text-secondary)', maxWidth: '75ch' }}>{t('completion.rules')}</p>
    <div className="completion-toolbar">
      <div className="form-group">
        <label>{t('completion.set')}</label>
        <MultiSelectDropdown label={t('completion.set')} allLabel={t('completion.choose')} options={setOptions} value={code ? [code] : []}
          searchable singleSelect onChange={values => { setState(null); select(setCode, values[0] || ''); }} />
      </div>
      <div className="form-group">
        <label htmlFor="completion-inventory">{t('collection.inventory')}</label>
        <select id="completion-inventory" className="select-control" value={inventory} onChange={event => { setState(null); select(setInventory, event.target.value); }}>
          <option value="collection">{t('nav.collection')}</option><option value="arena">{t('collection.arena')}</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="completion-goal">{t('completion.goal')}</label>
        <select id="completion-goal" className="select-control" value={goal} onChange={event => select(setGoal, event.target.value)}>
          {['cards', 'printings', 'foil'].map(value => <option key={value} value={value}>{t(`completion.${value}`)}</option>)}
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="completion-filter">{t('completion.show')}</label>
        <select id="completion-filter" className="select-control" value={filter} onChange={event => select(setFilter, event.target.value)}>
          {['all', 'owned', 'missing'].map(value => <option key={value} value={value}>{t(`completion.${value}`)}</option>)}
        </select>
      </div>
    </div>
    <p style={{ maxWidth: '75ch' }}>{t(`completion.${goal}Hint`)}</p>
    <div aria-live="polite">
      {setsError || current?.error ? <div role="alert"><p>{t(current?.error === 'demo' ? 'completion.demo' : 'completion.error')}</p>{current?.error !== 'demo' && <button className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>{t('common.retry')}</button>}</div>
        : !sets || (code && !current) ? <p role="status">{t('completion.loading')}</p>
          : !code ? <p>{t('completion.choose')}</p>
            : result?.total ? <div>
              <p><strong>{t('completion.progress', { owned: result.owned, total: result.total })} · {Math.floor(result.owned / result.total * 100)}%</strong></p>
              <progress aria-label={t('completion.title')} value={result.owned} max={result.total} style={{ width: '100%', accentColor: 'var(--accent-blue)' }} />
            </div> : <p>{t('completion.empty')}</p>}
    </div>
    {result && <>
      {pagination}
      {result.total > 0 && !rows.length && <p>{t('completion.noMatches')}</p>}
      <ul className="card-grid" style={{ listStyle: 'none', padding: 0 }}>
        {rows.slice((currentPage - 1) * 60, currentPage * 60).map(({ printing, owned }) => {
          const finish = goal === 'foil' || (printing.finishes?.includes('foil') && !printing.finishes.includes('nonfoil')) ? 'Holofoil' : 'Normal';
          const price = getPrintingPrice(printing, finish);
          const actionKey = `${printing.id}:${goal}`;
          return <li key={printing.id} style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowWrap: 'anywhere' }}>
            <button type="button" aria-label={`${t('inspector.zoomHint')}: ${printing.name} · #${printing.number}`} aria-haspopup="dialog" onClick={() => setCard(printing)} style={{ width: '100%', padding: 0, border: 0, background: 'transparent', cursor: 'zoom-in', borderRadius: 'var(--radius-sm)' }}>
              <CardImage card={printing} loading="lazy" style={{ display: 'block', width: '100%', aspectRatio: '5 / 7', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} />
            </button>
            <strong>{printing.name} · #{printing.number}</strong>
            {finish === 'Holofoil' && <span className="collection-card-tag collection-card-tag--foil" style={{ ...getPrintingBadgeStyle(finish), alignSelf: 'flex-start' }}>{getPrintingBadgeLabel(finish)}</span>}
            <span style={{ color: owned ? 'var(--text-positive)' : 'var(--text-secondary)' }}>{t(owned ? 'completion.owned' : 'completion.missing')}</span>
            <span style={{ color: 'var(--accent-yellow)', fontWeight: 600 }}>{price === null ? t('priceCheck.unavailable') : `${t('priceCheck.estimate')}: ${priceText(price, printing.price_currency)}`}</span>
            <button type="button" className="btn btn-secondary" disabled={!!wishlistAction?.pending} aria-busy={wishlistAction?.key === actionKey && !!wishlistAction.pending} onClick={() => addToWishlist(printing, finish)} style={{ minHeight: '44px', width: '100%', whiteSpace: 'normal' }}>
              {t(wishlistAction?.key === actionKey && wishlistAction.pending ? 'search.adding' : 'search.addToWishlist')}
            </button>
            {wishlistAction?.key === actionKey && !wishlistAction.pending && <p role={wishlistAction.error ? 'alert' : 'status'} style={{ margin: 0, fontSize: 'var(--text-sm)', color: wishlistAction.error ? 'var(--text-negative)' : 'var(--text-positive)' }}>
              {wishlistAction.error || t('search.addedToWishlist', { name: printing.name })}
            </p>}
          </li>;
        })}
      </ul>
      {pagination}
    </>}
    {card && <CardImageZoom card={card} onClose={() => setCard(null)} />}
  </section>;
}
