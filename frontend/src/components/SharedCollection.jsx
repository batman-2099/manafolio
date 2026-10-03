import { useState, useEffect, useMemo } from 'react';
import { ResponsiveContainer, Cell, Tooltip, BarChart, Bar, XAxis, YAxis } from 'recharts';
import { Search, Trophy, Compass, Library, ShieldAlert, Sparkles, X, MapPin, SlidersHorizontal } from 'lucide-react';
import Logo from './Logo';
import { priceText, currencySymbol, getCurrency, SYMBOLS } from '../utils/formatPrice';
import { getPrintings } from '../utils/cardOptions';
import { getFoilOverlayClass, getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { useBackGuard } from '../utils/useBackGuard';
import { COLLECTION_SORT_CRITERIA, sortCardsByOrder } from '../utils/cardSort';
import { displayName } from '../utils/languages';
import CardImage from './CardImage';
import Modal from './Modal';
import { ChartDataTable } from './DashboardAnalytics';
import { useT } from '../utils/i18n';
import themes from '../../../shared/themes.json';

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#14b8a6', '#f43f5e', '#a855f7', '#6366f1'
];

const TYPE_COLORS = {
  'Colorless': '#cbd5e1',
  'White': '#fef08a', 'Blue': '#3b82f6', 'Black': '#334155', 'Red': '#ef4444',
  'Green': '#10b981', 'Land': '#d97706'
};

function typeColor(name, i) {
  const key = Object.keys(TYPE_COLORS).find(k => k.toLowerCase() === String(name).toLowerCase());
  return key ? TYPE_COLORS[key] : COLORS[i % COLORS.length];
}

function SharedCollection({ shareToken }) {
  const { t, locale } = useT();
  const getInitialList = () => new URLSearchParams(window.location.search).get('list') || 'collection';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [listType, setListType] = useState(getInitialList);
  const [retry, setRetry] = useState(0);

  const [searchFilter, setSearchFilter] = useState('');
  const [rarityFilter, setRarityFilter] = useState('');
  const [printingFilter, setPrintingFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [sortBy, setSortBy] = useState('added-newest');
  const [showFilters, setShowFilters] = useState(false);

  // Stacking state (default to stacked)
  const [stackCards, setStackCards] = useState(true);
  const [stackByCondition, setStackByCondition] = useState(false);
  const [stackByPrinting, setStackByPrinting] = useState(false);

  const [activeCard, setActiveCard] = useState(null);
  useBackGuard(!!activeCard, () => setActiveCard(null));

  useEffect(() => {
    const onPopState = () => setListType(new URLSearchParams(window.location.search).get('list') || 'collection');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const fetchSharedData = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/shared/${shareToken}?list=${listType}`, { signal: controller.signal });
        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || t('shared.errLoad'));
        }
        const data = await response.json();
        if (!controller.signal.aborted) {
          setData({ value: data, listType, shareToken });
          setError(null);
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchSharedData();
    return () => controller.abort();
  }, [shareToken, listType, t, retry]);

  const loadedData = data?.shareToken === shareToken ? data.value : null;
  const collection = useMemo(() => loadedData?.collection || [], [loadedData]);
  const shareLocations = loadedData?.shareLocations;
  const currencies = new Set(collection.map(card => Object.hasOwn(SYMBOLS, card.price_currency) ? card.price_currency : getCurrency()));
  const mixedCurrencies = currencies.size > 1;
  const sourceCurrency = currencies.values().next().value;

  const uniqueRarities = useMemo(() => Array.from(new Set(collection.map(c => c.rarity).filter(Boolean))), [collection]);
  const uniqueTypes = useMemo(
    () => Array.from(new Set(collection.flatMap(c => c.types || []))).sort(),
    [collection]
  );

  const topValuable = useMemo(
    () => [...collection].sort((a, b) => (b.price_trend || 0) - (a.price_trend || 0)).slice(0, 5),
    [collection]
  );

  const filteredCollection = useMemo(() => {
    const q = searchFilter.toLowerCase();
    const result = collection.filter(item => {
      const matchesSearch = item.name.toLowerCase().includes(q) ||
        (item.set_name || '').toLowerCase().includes(q) ||
        (item.number || '').includes(searchFilter);
      const matchesRarity = !rarityFilter || item.rarity === rarityFilter;
      const matchesPrinting = !printingFilter || item.printing === printingFilter;
      const matchesType = !typeFilter || (item.types || []).includes(typeFilter);
      return matchesSearch && matchesRarity && matchesPrinting && matchesType;
    });
    if (sortBy === 'qty-desc') return result.sort((a, b) => (b.quantity || 0) - (a.quantity || 0));
    return sortCardsByOrder(result, COLLECTION_SORT_CRITERIA[sortBy] || COLLECTION_SORT_CRITERIA['added-newest']);
  }, [collection, searchFilter, rarityFilter, printingFilter, typeFilter, sortBy]);

  // Group duplicate cards if stack option is active (default true)
  const processedCollection = useMemo(() => {
    if (!stackCards) return filteredCollection;

    const groups = {};
    filteredCollection.forEach(item => {
      let key = item.card_id;
      if (stackByCondition) key += `-${item.condition}`;
      if (stackByPrinting) key += `-${item.printing}`;

      if (!groups[key]) {
        groups[key] = { ...item };
      } else {
        groups[key].quantity = (groups[key].quantity || 1) + (item.quantity || 1);
      }
    });
    return Object.values(groups);
  }, [filteredCollection, stackCards, stackByCondition, stackByPrinting]);

  const { owner, stats } = loadedData || {};
  const { summary, types = [], rarities = [], sets = [] } = stats || {};

  const typeChartData = types.map((entry, i) => ({ name: entry.name, value: entry.value, color: typeColor(entry.name, i) }));
  const rarityChartData = rarities.map((r, i) => ({ ...r, color: COLORS[i % COLORS.length] }));

  const handleTabChange = (type) => {
    if (type === listType) return;
    setError(null);
    setListType(type);
    const themeParam = new URLSearchParams(window.location.search).get('theme');
    const qTheme = themes.includes(themeParam) && themeParam !== 'dark' ? `&theme=${encodeURIComponent(themeParam)}` : '';
    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?list=${type}${qTheme}`;
    window.history.pushState({ path: newUrl }, '', newUrl);
  };

  // Keep the loaded list's heading with its cards while another list is fetched.
  const displayedList = loadedData ? data.listType : listType;
  const kind = ['collection', 'wishlist', 'trade'].includes(displayedList) ? displayedList : 'collection';
  const valueLabel = t(`shared.${kind}.valueLabel`);
  const qtyLabel = t(`shared.${kind}.qtyLabel`);
  const listTitle = t(`shared.${kind}.title`);
  const listBlurb = t(`shared.${kind}.blurb`);

  const distribution = (chartData, title, titleId, category) => (
    <section className="glass-panel" aria-labelledby={titleId}>
      <h3 id={titleId} className="chart-title">{title}</h3>
      <div className="chart-container" style={{ height: '220px', overflowX: 'auto' }} role="group" aria-labelledby={titleId} tabIndex={0}>
        {chartData.length === 0 ? (
          <div className="chart-empty">{t('shared.noData')}</div>
        ) : (
          <div style={{ height: '100%', minWidth: Math.max(300, chartData.length * 85) }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} role="img" aria-labelledby={titleId} accessibilityLayer={false} margin={{ top: 10, right: 15, left: 0, bottom: 5 }}>
                <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} interval={0} style={{ fontSize: '0.8rem' }} />
                <YAxis allowDecimals={false} domain={[0, 'auto']} stroke="var(--text-secondary)" width={45} />
                <Bar dataKey="value" maxBarSize={48} radius={[4, 4, 0, 0]}>
                  {chartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Bar>
                <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }} itemStyle={{ color: 'var(--text-strong)' }} labelStyle={{ color: 'var(--text-strong)' }} formatter={(v) => [v, t('dash.cards')]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      {chartData.length > 0 && <ChartDataTable titleId={titleId} title={title} category={category} rows={chartData} series={[{ key: 'value', label: t('dash.cards') }]} />}
    </section>
  );

  return (
    <main className="app-container shared-collection" style={{ paddingBottom: '3rem' }}>
      {/* Header */}
      <header className="app-header" style={{ marginBottom: '1.5rem', paddingBottom: '1rem', borderBottom: '1px solid var(--border-glass)' }}>
        <div className="logo-section">
          <h1 className="logo-text">Manafolio</h1>
          <div className="logo-icon"><Logo /></div>
        </div>
        {owner && <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
          <Sparkles size={14} aria-hidden="true" style={{ color: 'var(--accent-yellow)' }} />
          <span>{t('shared.sharedBy')} <strong>{owner}</strong></span>
        </div>}
      </header>

      {/* Public Sub Navigation Tabs */}
      <div className="sub-nav-tabs" style={{ marginBottom: '1.5rem' }}>
        {['collection', 'wishlist', 'trade'].map((val) => (
          <button type="button" key={val} className={`sub-nav-tab ${listType === val ? 'active' : ''}`} aria-pressed={listType === val} onClick={() => handleTabChange(val)}>
            {t(`shared.${val}.tab`)}
          </button>
        ))}
      </div>

      <p role="status" className="shared-load-status">{loading ? t('shared.loadingList', { list: t(`shared.${['collection', 'wishlist', 'trade'].includes(listType) ? listType : 'collection'}.tab`) }) : ''}</p>
      {error && <section className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><ShieldAlert size={24} aria-hidden="true" />{t('shared.unavailable')}</h2>
        <p role="alert">{error}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1rem' }}>
          <button type="button" className="btn btn-primary" aria-disabled={loading} onClick={() => { if (!loading) setRetry(value => value + 1); }}>{t('common.retry')}</button>
          <a href="/" className="btn btn-secondary">{t('shared.goToManafolio')}</a>
        </div>
      </section>}

      {loadedData && <>

      {/* Title block */}
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>{t('shared.ownerTitle', { owner, list: listTitle })}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{listBlurb}</p>
      </div>
      {/* Filters + Sort */}
      <div className="glass-panel" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ marginBottom: 0, flex: '1 1 220px' }}>
            <label htmlFor="shared-search">{t('shared.search')}</label>
            <div style={{ position: 'relative' }}>
              <input id="shared-search" type="search" className="input-control" placeholder={t('shared.searchPlaceholder')}
                value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} style={{ width: '100%', paddingLeft: '2.5rem' }} />
              <Search size={16} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>
          <div className="form-group" style={{ marginBottom: 0, flex: '1 1 160px' }}>
            <label htmlFor="shared-sort">{t('collection.sortBy')}</label>
            <select id="shared-sort" className="select-control" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="added-newest">{t('shared.sortRecent')}</option>
              {['name-asc', 'name-desc', 'price-desc', 'price-asc', 'qty-desc', 'set-asc', 'number-asc', 'type-asc', 'rarity-desc', 'rarity-asc', 'language-asc']
                .map(key => <option key={key} value={key}>{t(`collection.sort.${key}`)}</option>)}
            </select>
          </div>
          <button type="button" className={`btn ${showFilters ? 'btn-primary' : 'btn-secondary'}`} aria-expanded={showFilters} aria-controls="shared-filters" onClick={() => setShowFilters(s => !s)}
            style={{ padding: '0.5rem 0.9rem', height: '40px', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}>
            <SlidersHorizontal size={15} /> {t('collection.filters')}
          </button>
        </div>

          <div id="shared-filters" hidden={!showFilters} style={{ marginTop: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="shared-type">{t('shared.type')}</label>
                <select id="shared-type" className="select-control" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                  <option value="">{t('collection.allTypes')}</option>
                  {uniqueTypes.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="shared-rarity">{t('collection.fRarity')}</label>
                <select id="shared-rarity" className="select-control" value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)}>
                  <option value="">{t('collection.allRarities')}</option>
                  {uniqueRarities.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="shared-printing">{t('card.printing')}</label>
                <select id="shared-printing" className="select-control" value={printingFilter} onChange={(e) => setPrintingFilter(e.target.value)}>
                  <option value="">{t('collection.allPrintings')}</option>
                  {getPrintings().map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-glass)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <input type="checkbox" id="stackCardsSharedOpt" checked={stackCards} onChange={(e) => setStackCards(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
                <label htmlFor="stackCardsSharedOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-strong)' }}>
                  {t('shared.stackDuplicates')}
                </label>
              </div>
              {stackCards && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input type="checkbox" id="stackByConditionSharedOpt" checked={stackByCondition} onChange={(e) => setStackByCondition(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByConditionSharedOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('shared.separateByCondition')}
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <input type="checkbox" id="stackByPrintingSharedOpt" checked={stackByPrinting} onChange={(e) => setStackByPrinting(e.target.checked)} style={{ width: '14px', height: '14px', cursor: 'pointer' }} />
                    <label htmlFor="stackByPrintingSharedOpt" style={{ cursor: 'pointer', margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                      {t('shared.separateByPrinting')}
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
      </div>

      {/* Overview stats */}
      <section className="shared-summary" aria-label={t('shared.summary')}>
        <div>
          <div className="metric-header"><span>{valueLabel}</span><Trophy size={18} aria-hidden="true" style={{ color: 'var(--accent-yellow)' }} /></div>
          <div className="shared-summary-value">{mixedCurrencies ? t('common.mixedCurrencies') : `${currencySymbol(sourceCurrency)}${summary.totalValue.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</div>
          <div className="metric-footer">{t('shared.valueFooter')}</div>
        </div>
        <div>
          <div className="metric-header"><span>{qtyLabel}</span><Library size={18} aria-hidden="true" /></div>
          <div className="shared-summary-value">{summary.totalCards}</div>
          <div className="metric-footer">{t('shared.qtyFooter')}</div>
        </div>
        <div>
          <div className="metric-header"><span>{t('shared.uniqueCards')}</span><Compass size={18} aria-hidden="true" /></div>
          <div className="shared-summary-value">{summary.uniqueCards}</div>
          <div className="metric-footer">{t('shared.uniqueFooter')}</div>
        </div>
      </section>



      {/* Card grid */}
      {processedCollection.length === 0 ? (
        <div className="glass-panel" style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
          {t('collection.noMatches')}
        </div>
      ) : (
        <div className="card-grid">
          {processedCollection.map(card => {
            return (
              <button type="button" key={card.entry_id} className="tcg-card" onClick={() => setActiveCard(card)} aria-haspopup="dialog" aria-label={`${t('shared.cardDetails')} ${displayName(card)}`} style={{ textAlign: 'left', font: 'inherit', color: 'inherit' }}>
                <span className="tcg-card-inner">
                  <CardImage card={card} className="tcg-card-image" loading="lazy" />
                  {getFoilOverlayClass(card.printing) && (
                    <span className={getFoilOverlayClass(card.printing)} style={{ borderRadius: 'var(--radius-sm)' }} />
                  )}
                  {getPrintingBadgeLabel(card.printing) && (
                    <span style={{ position: 'absolute', top: '6px', left: '6px', fontSize: '0.6rem', fontWeight: 800, padding: '2px 5px', borderRadius: '3px', zIndex: 6, ...getPrintingBadgeStyle(card.printing) }}>
                      {getPrintingBadgeLabel(card.printing)}
                    </span>
                  )}
                  {card.quantity > 1 && (
                    <span className="tcg-card-quantity-tag">x{card.quantity}</span>
                  )}
                </span>
                <span className="tcg-card-info">
                  <span className="tcg-card-name">{displayName(card)}</span>
                  <span className="tcg-card-meta">
                    <span style={{ fontSize: '0.7rem' }}>{card.set_name} • #{card.number}</span>
                    <span className="tcg-card-price">{priceText(card.price_trend, card.price_currency)}</span>
                  </span>
                  {shareLocations && card.location && (
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                      <MapPin size={11} /> {card.location}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <section className="shared-analytics" aria-labelledby="shared-analytics-title" style={{ marginTop: '2rem' }}>
      <h2 id="shared-analytics-title" className="section-heading">{t('dash.analytics')}</h2>
      <div className="dashboard-details" style={{ marginTop: '1rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="glass-panel">
            <h3 id="shared-set-title" className="chart-title">{t('shared.valueBySet')}</h3>
            <div className="chart-container" style={{ overflowX: 'auto' }} role="region" aria-labelledby="shared-set-title" tabIndex={0}>
              {mixedCurrencies ? (
                <div className="chart-empty">{t('common.mixedCurrencies')}</div>
              ) : sets.length === 0 ? (
                <div className="chart-empty">{t('shared.noSetData')}</div>
              ) : (
                <div style={{ height: '100%', minWidth: Math.max(300, sets.length * 110) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sets} role="img" aria-labelledby="shared-set-title" accessibilityLayer={false} margin={{ left: 0, right: 15, top: 10, bottom: 5 }}>
                    <XAxis dataKey="name" stroke="var(--text-secondary)" interval={0} tickLine={false} style={{ fontSize: '0.8rem' }} />
                    <YAxis type="number" domain={[0, 'auto']} stroke="var(--text-secondary)" tickFormatter={(v) => priceText(v, sourceCurrency)} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }} itemStyle={{ color: 'var(--text-strong)' }} labelStyle={{ color: 'var(--text-strong)' }} formatter={(v) => [priceText(v, sourceCurrency), t('dash.value')]} />
                    <Bar dataKey="value" fill="var(--accent-red)" maxBarSize={48} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
                </div>
              )}
            </div>
            {!mixedCurrencies && sets.length > 0 && <ChartDataTable titleId="shared-set-title" title={t('shared.valueBySet')} category={t('sort.by.set')} rows={sets} series={[{ key: 'value', label: t('dash.value') }]} format={value => priceText(value, sourceCurrency)} />}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
            {distribution(typeChartData, t('shared.typeBreakdown'), 'shared-type-title', t('sort.by.type'))}
            {distribution(rarityChartData, t('dash.rarityDistribution'), 'shared-rarity-title', t('sort.by.rarity'))}
          </div>
        </div>

        {/* Top Valuable */}
        <div className="glass-panel" style={{ flex: 1 }}>
          <h3 className="chart-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Trophy size={18} style={{ color: 'var(--accent-yellow)' }} /> {t('dash.topValuable')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1.25rem' }}>
            {topValuable.map((card) => (
              <button type="button" key={card.entry_id} onClick={() => setActiveCard(card)} className="dashboard-card-clickable shared-valuable-row" aria-haspopup="dialog" aria-label={`${t('shared.cardDetails')} ${displayName(card)}`}>
                <CardImage card={card} style={{ width: '48px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }} />
                <span style={{ flex: 1, overflow: 'hidden' }}>
                  <span style={{ display: 'block', fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName(card)}</span>
                  <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{card.set_name} • {card.rarity}</span>
                </span>
                <span style={{ fontWeight: 800, color: 'var(--accent-yellow)', fontSize: '0.9rem' }}>{priceText(card.price_trend, card.price_currency)}</span>
              </button>
            ))}
            {topValuable.length === 0 && <div className="chart-empty">{t('shared.noCards')}</div>}
          </div>
        </div>
      </div>
      </section>
      </>}

      {/* Read-only Card Detail Modal */}
      {activeCard && (
        <Modal onClose={() => setActiveCard(null)} aria-labelledby="shared-card-title" style={{ padding: '1rem' }}>
          <div className="glass-panel" style={{ maxWidth: '680px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexWrap: 'wrap', gap: '2rem', position: 'relative' }}>
            <button type="button" className="btn btn-secondary btn-icon-only" aria-label={t('common.close')} onClick={() => setActiveCard(null)} style={{ position: 'absolute', top: '1rem', right: '1rem', borderRadius: '50%' }}>
              <X size={16} />
            </button>
            <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
              <CardImage card={activeCard} style={{ width: '100%', maxWidth: '260px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.5), 0 0 15px rgba(255,255,255,0.05)' }} />
            </div>
            <div style={{ flex: '1 1 300px', minWidth: 0, overflowWrap: 'anywhere', display: 'flex', flexDirection: 'column', gap: '1rem', justifyContent: 'center' }}>
              <div>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', padding: '0.2rem 0.5rem', borderRadius: '4px', backgroundColor: 'rgba(234,179,8,0.1)', color: 'var(--accent-yellow)', border: '1px solid rgba(234,179,8,0.2)', display: 'inline-block', marginBottom: '0.5rem' }}>
                  {activeCard.rarity || t('shared.rarityCommon')}
                </span>
                <h3 id="shared-card-title" style={{ fontSize: '1.5rem', color: 'var(--text-strong)', lineHeight: 1.2 }}>{displayName(activeCard)}</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{activeCard.set_name} • {t('shared.cardNumber', { number: activeCard.number })}</p>
              </div>
              <div style={{ borderTop: '1px solid var(--border-glass)', paddingTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '2rem' }}>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('shared.estMarketPrice')}</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent-yellow)' }}>{priceText(activeCard.price_trend, activeCard.price_currency)}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{t('shared.quantity')}</div>
                  <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--text-strong)' }}>x{activeCard.quantity}</div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}><strong>{t('shared.cardDetails')}</strong></div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{t(activeCard.game === 'mtg' || activeCard.supertype === 'MTG' ? 'inspector.specGame' : 'inspector.specSupertype')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.game === 'mtg' || activeCard.supertype === 'MTG' ? 'Magic: The Gathering' : activeCard.supertype}</span>
                  {activeCard.types.length > 0 && (<><span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('shared.specTypes')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.types.join(', ')}</span></>)}
                  {activeCard.subtypes.length > 0 && (<><span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('shared.specSubtypes')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.subtypes.join(', ')}</span></>)}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{t('inspector.specCondition')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.condition}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('inspector.specPrinting')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.printing}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{t('inspector.specLanguage')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.language}</span>
                </div>
                {shareLocations && activeCard.location && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', marginTop: '0.25rem' }}>
                    <MapPin size={13} style={{ color: 'var(--accent-red)' }} />
                    <span style={{ color: 'var(--text-muted)' }}>{t('inspector.locationLabel')}</span> <span style={{ color: 'var(--text-strong)' }}>{activeCard.location}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

export default SharedCollection;
