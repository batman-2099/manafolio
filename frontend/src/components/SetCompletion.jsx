import { useEffect, useState } from 'react';
import { useT } from '../utils/i18n';
import CardImageZoom from './CardImageZoom';

export default function SetCompletion() {
  const { t } = useT();
  const [sets, setSets] = useState(null);
  const [code, setCode] = useState('');
  const [inventory, setInventory] = useState('collection');
  const [goal, setGoal] = useState('cards');
  const [filter, setFilter] = useState('all');
  const [state, setState] = useState(null);
  const [retry, setRetry] = useState(0);
  const [setsError, setSetsError] = useState(false);
  const [card, setCard] = useState(null);
  const [page, setPage] = useState(1);
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
  const result = current?.data?.goals[goal];
  const rows = result?.rows.filter(row => filter === 'all' || row.owned === (filter === 'owned')) || [];
  const pages = Math.max(1, Math.ceil(rows.length / 60));
  const currentPage = Math.min(page, pages);
  const select = (setter, value) => { setter(value); setPage(1); };
  const pagination = pages > 1 && <nav aria-label={t('collection.pagination')} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBlock: '1rem' }}>
    <button className="btn btn-secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{t('collection.previousPage')}</button>
    <span>{t('collection.pageCount', { page: currentPage, count: pages })}</span>
    <button className="btn btn-secondary" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}>{t('collection.nextPage')}</button>
  </nav>;

  return <section aria-labelledby="completion-title">
    <h2 id="completion-title">{t('completion.title')}</h2>
    <p style={{ color: 'var(--text-secondary)', maxWidth: '75ch' }}>{t('completion.rules')}</p>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: '1rem', marginBlock: '1rem' }}>
      <div className="form-group">
        <label htmlFor="completion-set">{t('completion.set')}</label>
        <select id="completion-set" className="select-control" value={code} onChange={event => { setState(null); select(setCode, event.target.value); }}>
          <option value="">{t('completion.choose')}</option>
          {(sets || []).map(set => <option key={set.id} value={set.id}>{set.name} ({set.id.replace(/^mtg-/, '').toUpperCase()})</option>)}
        </select>
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
              <progress aria-label={t('completion.title')} value={result.owned} max={result.total} style={{ width: '100%', accentColor: 'var(--accent-primary)' }} />
            </div> : <p>{t('completion.empty')}</p>}
    </div>
    {result && <>
      {pagination}
      {result.total > 0 && !rows.length && <p>{t('completion.noMatches')}</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {rows.slice((currentPage - 1) * 60, currentPage * 60).map(row => <li key={row.id} style={{ borderBottom: '1px solid var(--border-color)', paddingBlock: '0.75rem', overflowWrap: 'anywhere' }}>
          <details>
            <summary style={{ cursor: 'pointer', minHeight: '44px', paddingBlock: '0.5rem' }}>
              <strong>{row.name}</strong>{goal !== 'cards' && ` · #${row.printings[0].number}`} — {t(row.owned ? 'completion.owned' : 'completion.missing')}
            </summary>
            {row.printings.map(printing => <div key={printing.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBlock: '0.5rem' }}>
              <button className="btn btn-secondary" onClick={() => setCard(printing)} style={{ minHeight: '44px', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{printing.name} · #{printing.number}</button>
              <span>{t('completion.copies', { recorded: printing.recorded, owned: printing.owned, available: printing.available })}</span>
            </div>)}
          </details>
        </li>)}
      </ul>
      {pagination}
    </>}
    {card && <CardImageZoom card={card} onClose={() => setCard(null)} />}
  </section>;
}
