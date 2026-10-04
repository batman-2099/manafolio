import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, AreaChart, Area } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { priceText, currencySymbol } from '../utils/formatPrice';
import { getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { defaultGameFilter, gameLabel } from '../utils/games';
import { useT } from '../utils/i18n';
import CardInspectorModal from './CardInspectorModal';
import CardImage from './CardImage';
import DashboardAnalytics, { ChartDataTable } from './DashboardAnalytics';

const CameraScanner = lazy(() => import('./CameraScanner'));

const COLORS = [
  '#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#a78bfa',
  '#f472b6', '#2dd4bf', '#fb923c', '#e879f9', '#818cf8'
];

const TYPE_COLORS = {
  'Colorless': '#cbd5e1',
  'White': '#fef08a',
  'Blue': '#60a5fa',
  'Black': '#a78bfa',
  'Red': '#f87171',
  'Green': '#4ade80',
  'Land': '#fbbf24'
};

function Dashboard({ statsTrigger, onNavigate, setSelectedLocationId, setFocusEntryId, onUpdate, showToast }) {
  const { t, locale } = useT();
  // Money and dates follow the interface language, not the browser's: a user who
  // picked German sees 1.234,56 and 3.8.2026 even on an en-US browser.
  const money = (n) => (n || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [statsState, setStatsState] = useState(null);
  const [statsRefresh, setStatsRefresh] = useState(0);
  const [timePeriod, setTimePeriod] = useState('30d');
  const [priceCheckOpen, setPriceCheckOpen] = useState(false);
  const priceCheckButtonRef = useRef(null);
  const backButtonRef = useRef(null);
  const wasPriceCheckOpen = useRef(false);
  const gameFilter = defaultGameFilter();
  const [inventoryFilter, setInventoryFilter] = useState('all');
  const isArchive = inventoryFilter === 'graveyard';
  const valueColor = isArchive ? '#8b5cf6' : 'var(--accent-green)';
  
  // Timeline Chart State
  const [historyState, setHistoryState] = useState(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const statsScope = `${gameFilter}:${inventoryFilter}`;
  const stats = statsState?.scope === statsScope ? statsState.data : null;
  const loading = statsState?.scope !== statsScope || statsState.loading;
  const error = statsState?.scope === statsScope && statsState.error;
  const historyScope = `${statsScope}:${timePeriod}`;
  const historyData = historyState?.scope === historyScope ? historyState.data : null;
  const loadingHistory = historyState?.scope !== historyScope || historyState.loading;
  const historyError = historyState?.scope === historyScope && historyState.error;

  // Clickable Card Inspector State
  const [inspectorCard, setInspectorCard] = useState(null);

  useEffect(() => {
    if (priceCheckOpen) backButtonRef.current?.focus();
    else if (wasPriceCheckOpen.current) priceCheckButtonRef.current?.focus();
    wasPriceCheckOpen.current = priceCheckOpen;
  }, [priceCheckOpen]);

  useEffect(() => {
    const controller = new AbortController();
    setStatsState(previous => ({ scope: statsScope, data: previous?.scope === statsScope ? previous.data : null, loading: true, error: false }));
    const params = new URLSearchParams({ inventory: inventoryFilter });
    if (gameFilter) params.set('game', gameFilter);
    const load = async () => {
      try {
        const response = await fetch(`/api/stats?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!controller.signal.aborted) setStatsState({ scope: statsScope, data, loading: false, error: false });
      } catch {
        if (!controller.signal.aborted) setStatsState(previous => ({ ...previous, loading: false, error: true }));
      }
    };
    load();
    return () => controller.abort();
  }, [statsTrigger, statsRefresh, gameFilter, inventoryFilter, statsScope]);

  useEffect(() => {
    const controller = new AbortController();
    if (!stats || stats.summary.totalCards === 0) return () => controller.abort();
    setHistoryState(previous => ({ scope: historyScope, data: previous?.scope === historyScope ? previous.data : null, loading: true, error: false }));
    const params = new URLSearchParams({ period: timePeriod, inventory: inventoryFilter });
    if (gameFilter) params.set('game', gameFilter);
    const load = async () => {
      try {
        const response = await fetch(`/api/stats/history?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!controller.signal.aborted) setHistoryState({ scope: historyScope, data, loading: false, error: false });
      } catch {
        if (!controller.signal.aborted) setHistoryState(previous => ({ ...previous, loading: false, error: true }));
      }
    };
    load();
    return () => controller.abort();
  }, [timePeriod, stats, historyRefresh, gameFilter, inventoryFilter, historyScope]);

  const renderFilters = () => (
    <>
      <header className="page-heading">
        <h1 className="page-title">{t('nav.dashboard')}</h1>
        <div className="dashboard-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onNavigate('collection')}>{t('nav.collection')}</button>
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('add-cards')}>{t('nav.addCards')}</button>
          <button ref={priceCheckButtonRef} type="button" className="btn btn-secondary" onClick={() => setPriceCheckOpen(true)}>{t('priceCheck.title')}</button>
        </div>
      </header>
      <div className="view-toolbar">
      <div className="sub-nav-tabs dashboard-filters" style={{ margin: 0 }}>
        {[['all', t('dash.allCards')], ['collection', t('dash.physical')], ['arena', t('dash.arena')], ['graveyard', t('collection.graveyard')]].map(([value, label]) => (
          <button key={value} type="button" className={`sub-nav-tab ${inventoryFilter === value ? 'active' : ''}`}
            aria-pressed={inventoryFilter === value}
            onClick={() => setInventoryFilter(value)}>
            {label}
          </button>
        ))}
      </div>
    </div>
    </>
  );

  const statsStatus = error ? (
    <div className="read-state read-state-error">
      <p role="alert">{t('dash.errLoad', { error: t('dash.errStats') })}{stats && <> {t('common.staleData')}</>}</p>
      <button type="button" className="btn btn-secondary" onClick={() => setStatsRefresh(value => value + 1)}>{t('dash.retry')}</button>
    </div>
  ) : loading ? (
    <div className={`read-state${stats ? '' : ' read-state-initial'}`} role="status">
      <div className="spinner" aria-hidden="true"></div>
      <p>{t(stats ? 'common.refreshing' : 'dash.loading')}</p>
    </div>
  ) : null;

  if (priceCheckOpen) {
    return (
      <div className="dashboard-page">
        <header className="page-heading">
          <h1 className="page-title">{t('priceCheck.title')}</h1>
          <button ref={backButtonRef} type="button" className="btn btn-secondary" onClick={() => setPriceCheckOpen(false)}>{t('priceCheck.backToDashboard')}</button>
        </header>
        <p style={{ color: 'var(--text-secondary)', marginBottom: 'var(--space-4)' }}>{t('priceCheck.hint')}</p>
        <Suspense fallback={<div className="read-state read-state-initial" role="status"><div className="spinner" aria-hidden="true" /><p>{t('common.loading')}</p></div>}>
          <CameraScanner mode="price-check" showToast={showToast} />
        </Suspense>
      </div>
    );
  }

  if (loading && !stats) {
    return <div className="dashboard-page">{renderFilters()}{statsStatus}</div>;
  }

  if (error && !stats) {
    return (
      <div className="dashboard-page">
        {renderFilters()}
        {statsStatus}
      </div>
    );
  }

  if (!stats || stats.summary.totalCards === 0) {
    const isFiltered = Boolean(gameFilter);
    const gameName = isFiltered ? gameLabel(gameFilter, true) : '';
    return (
      <div className="dashboard-page">
        {renderFilters()}
        {statsStatus}
        <div className="dashboard-empty" style={{ padding: '1.5rem 0', color: 'var(--text-secondary)' }}>
          <h2 style={{ color: 'var(--text-strong)', marginBottom: '0.5rem' }}>
            {isArchive ? t('dash.emptyArchiveTitle') : isFiltered ? t('dash.emptyFilteredTitle', { game: gameName }) : t('dash.emptyTitle')}
          </h2>
          <p style={{ maxWidth: '400px', margin: '0 0 1.5rem' }}>
            {isArchive ? (isFiltered ? t('dash.emptyArchiveFilteredBody', { game: gameName }) : t('dash.emptyArchiveBody')) : isFiltered ? t('dash.emptyFilteredBody', { game: gameName }) : t('dash.emptyBody')}
          </p>
          {!isArchive && <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ display: 'inline-block' }}>
              <button className="btn btn-primary" onClick={() => onNavigate && onNavigate('add-cards')}>{t('dash.goToAddCards')}</button>
            </div>
          </div>}
        </div>
        <section className="dashboard-analytics view-section" aria-labelledby="dashboard-analytics-title">
          <h2 id="dashboard-analytics-title" className="section-heading">{t('dash.analytics')}</h2>
          <DashboardAnalytics analytics={stats?.analytics} inventory={inventoryFilter} />
        </section>
      </div>
    );
  }

  const { summary, types, rarities, sets, topValuable, recentAdditions = [], setProgress } = stats;

  // Match type name to its color case-insensitively; fall back to a distinct
  // palette color by index so slices are never all the same gray.
  const typeColorLookup = Object.fromEntries(
    Object.entries(TYPE_COLORS).map(([k, v]) => [k.toLowerCase(), v])
  );
  const typeChartData = types.map((t, i) => {
    const fill = typeColorLookup[String(t.name).toLowerCase()] || COLORS[i % COLORS.length];
    return { name: t.name, value: t.value, color: fill, fill };
  });
  const rarityChartData = rarities.map((r, i) => ({ ...r, fill: COLORS[i % COLORS.length] }));
  const cardCount = inventoryFilter === 'collection' ? summary.physicalCards
    : inventoryFilter === 'arena' ? summary.digitalCards
    : isArchive ? summary.archivedCards : summary.totalCards;
  const cardLabel = inventoryFilter === 'collection' ? 'dash.physicalCards'
    : inventoryFilter === 'arena' ? 'dash.digitalCards'
    : isArchive ? 'dash.archivedCards' : 'dash.totalCards';
  const cardNote = inventoryFilter === 'collection'
    ? (summary.unsortedCount > 0 ? t('dash.unsortedCount', { count: summary.unsortedCount }) : t('dash.physicalCards'))
    : inventoryFilter === 'arena' ? t('collection.arena') : t('dash.uniqueCount', { count: summary.uniqueCards });
  // Only Cardmarket's 7/30-day averages provide real price comparisons.
  const change = timePeriod === '7d' ? summary.change7d
    : timePeriod === '30d' ? summary.change30d
    : timePeriod === '1y' ? summary.change1y : summary.change5y;
  const timelineTitle = t(isArchive ? 'dash.archiveTimelineTitle' : 'dash.timelineTitle');
  const setTitle = t(isArchive ? 'dash.archiveValueBySet' : 'dash.valueBySet');
  const typeTitle = t(gameFilter === 'mtg' ? 'dash.colorDistribution' : 'dash.typeDistribution');
  const rarityTitle = t('dash.rarityDistribution');
  const currencies = summary.currencies || [];
  const mixedCurrencies = currencies.length > 1;
  const quoteCurrency = currencies.length === 1 ? currencies[0] : undefined;
  const quoteSymbol = mixedCurrencies ? '' : currencySymbol(quoteCurrency);
  const formatMoney = value => `${quoteSymbol}${money(value)}`;
  const formatDate = value => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });

  return (
    <div className="dashboard-page">
      {renderFilters()}
      {statsStatus}
      {isArchive && <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>{t('dash.archiveValueNote')}</p>}

      <div className="dashboard-summary">
        <dl className="dashboard-summary-primary">
          <div>
            <dt>{t(cardLabel)}</dt>
            <dd className="dashboard-summary-value">{cardCount.toLocaleString(locale)}</dd>
            <dd className="dashboard-summary-note">{cardNote}</dd>
          </div>
          <div>
            <dt>{t(isArchive ? 'dash.archivedValue' : 'dash.netWorth')}</dt>
            <dd className="dashboard-summary-value">{formatMoney(summary.totalValue)}</dd>
            <dd className="dashboard-summary-note">{mixedCurrencies ? t('common.mixedCurrencies') : t('dash.avgPerCard', { price: priceText(summary.avgCardValue, quoteCurrency) })}</dd>
          </div>
        </dl>
      </div>

      <section className="dashboard-timeline view-section" aria-labelledby="dashboard-timeline-title">
        <div className="dashboard-timeline-header">
          <h2 id="dashboard-timeline-title" className="section-heading">{timelineTitle}</h2>
          <div className="sub-nav-tabs dashboard-periods" style={{ margin: 0 }}>
            {['7d', '30d', '1y', '5y'].map(period => (
              <button key={period} type="button" className={`sub-nav-tab ${timePeriod === period ? 'active' : ''}`}
                aria-pressed={timePeriod === period} onClick={() => setTimePeriod(period)}>
                {period.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="dashboard-history-context">
          <span>{t(isArchive ? 'dash.archiveTimelineRange' : 'dash.timelineRange', { range: timePeriod.toUpperCase() })}</span>
          {!change?.available ? (!historyError && !loadingHistory && <span>{t('dash.noPriceHistory')}</span>) : (
            <span className={change.abs >= 0 ? 'positive' : 'negative'}>
              <TrendingUp aria-hidden="true" size={14} style={{ transform: change.abs >= 0 ? 'none' : 'rotate(180deg)' }} />
              {change.abs >= 0 ? '+' : ''}{priceText(change.abs, 'EUR')} ({change.abs >= 0 ? '+' : ''}{change.pct}%)
            </span>
          )}
        </div>
        {isArchive && <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>{t('dash.archiveTimelineNote')}</p>}
        {historyError ? (
          <div className="read-state read-state-error">
            <p role="alert">{t('dash.errHistory')}{historyData && <> {t('common.staleData')}</>}</p>
            <button type="button" className="btn btn-secondary" onClick={() => setHistoryRefresh(value => value + 1)}>{t('dash.retry')}</button>
          </div>
        ) : loadingHistory && (
          <div className="read-state" role="status">
            <div className="spinner" aria-hidden="true"></div>
            <p>{t(historyData ? 'common.refreshing' : 'common.loading')}</p>
          </div>
        )}
        <div className="chart-container" style={{ height: '240px', position: 'relative' }} aria-busy={loadingHistory}>
          {!historyData ? null : historyData.length < 2 ? (
            !historyError && <div className="chart-empty">{t('dash.notEnoughHistory')}</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={historyData} role="img" aria-labelledby="dashboard-timeline-title" margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={valueColor} stopOpacity={0.4}/>
                    <stop offset="95%" stopColor={valueColor} stopOpacity={0.0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tickFormatter={formatDate} stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} />
                <YAxis stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} tickFormatter={(v) => `${quoteSymbol}${v}`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  labelFormatter={formatDate}
                  formatter={v => [formatMoney(v), t(isArchive ? 'dash.archivedValue' : 'dash.portfolioValue')]}
                />
                <Area type="monotone" dataKey="value" stroke={valueColor} strokeWidth={2} fillOpacity={1} fill="url(#colorVal)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
        {historyData?.length > 0 && <ChartDataTable titleId="dashboard-timeline-title" title={timelineTitle} category={t('dash.date')} categoryKey="date" formatCategory={formatDate} rows={historyData} series={[{ key: 'value', label: t(isArchive ? 'dash.archivedValue' : 'dash.portfolioValue') }]} format={formatMoney} />}
      </section>

      <section className="dashboard-analytics view-section" aria-labelledby="dashboard-analytics-title">
        <h2 id="dashboard-analytics-title" className="section-heading">{t('dash.analytics')}</h2>
        <div className="dashboard-details">
        {/* Card activity and set completion */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Recent Additions */}
          {recentAdditions.length > 0 && (
            <div className="dashboard-subsection view-section">
              <h3 className="section-heading">
                {t(isArchive ? 'dash.archiveRecentAdditions' : 'dash.recentAdditions')}
              </h3>
              <div className="dashboard-card-list">
                {recentAdditions.map((card, idx) => (
                  <button
                    type="button" key={idx}
                    onClick={() => setInspectorCard(card)}
                    className="dashboard-card-clickable dashboard-card-row"
                  >
                    <CardImage card={card} thumbnail loading="lazy" width={48} height={67} style={{ width: '48px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px' }} />
                    <div className="dashboard-card-description">
                      <div className="dashboard-card-name">
                        {getCardDisplayName(card.name, card.printed_name)}
                      </div>
                      <div className="dashboard-card-meta">
                        <span>{card.set_name} • #{card.number}</span>
                        {card.printing && card.printing !== 'Normal' && (
                          <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', flexShrink: 0, ...getPrintingBadgeStyle(card.printing) }}>
                            {getPrintingBadgeLabel(card.printing)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="dashboard-card-price">
                      <div className="dashboard-card-amount">{priceText(card.price_trend, card.price_currency)}<span> {t('dash.each')}</span></div>
                      <div className="dashboard-card-meta">{card.quantity > 1 ? t('dash.qty', { qty: card.quantity }) : (card.added_at ? new Date(card.added_at).toLocaleDateString(locale) : '')}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Top Valuable Cards */}
          <div className="dashboard-subsection view-section">
            <h3 className="section-heading">
              {t(isArchive ? 'dash.archiveTopValuable' : 'dash.topValuable')}
            </h3>
            <div className="dashboard-card-list">
              {topValuable.map((card, idx) => (
                <button
                  type="button" key={idx}
                  onClick={() => setInspectorCard(card)}
                  className="dashboard-card-clickable dashboard-card-row"
                >
                  <CardImage card={card} thumbnail loading="lazy" width={48} height={67} style={{ width: '48px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px' }} />
                  <div className="dashboard-card-description">
                    <div className="dashboard-card-name">
                      {getCardDisplayName(card.name, card.printed_name)}
                    </div>
                    <div className="dashboard-card-meta">
                      <span>{card.set_name} • {card.rarity}</span>
                      {card.printing && card.printing !== 'Normal' && (
                        <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', flexShrink: 0, ...getPrintingBadgeStyle(card.printing) }}>
                          {getPrintingBadgeLabel(card.printing)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="dashboard-card-price">
                    <div className="dashboard-card-amount">{priceText(card.price_trend, card.price_currency)}<span> {t('dash.each')}</span></div>
                    <div className="dashboard-card-meta">
                      {card.quantity > 1 ? t('dash.qtyTotal', { qty: card.quantity, price: priceText(card.price_trend * card.quantity, card.price_currency) }) : t('dash.qty', { qty: 1 })}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>


          {/* Set Completion progress tracker */}
          {setProgress.length > 0 && (
            <div className="dashboard-subsection view-section">
              <h3 className="section-heading">{t(isArchive ? 'dash.archiveSetProgress' : 'dash.setProgress')}</h3>
              <div className="set-progress-grid" style={{ marginTop: '1rem' }}>
                {setProgress.map((set, idx) => (
                  <div key={idx} className="set-progress-item">
                    <div className="set-progress-header">
                      <span style={{ color: 'var(--text-strong)' }}>{set.setName}</span>
                      <span style={{ color: 'var(--text-secondary)' }}>{set.ownedUnique} / {set.totalCards} ({set.percent}%)</span>
                    </div>
                    <div className="set-progress-bar-bg">
                      <div className="set-progress-bar-fill" style={{ width: `${set.percent}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
        {/* Collection breakdowns */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Card Value by Set Chart */}
          <div className="dashboard-subsection view-section">
            <h3 id="dashboard-set-title" className="section-heading">{setTitle}</h3>
            <div className="chart-container dashboard-set-chart" role="region" aria-labelledby="dashboard-set-title" tabIndex={0}>
              {sets.length === 0 ? (
                <div className="chart-empty">{t('dash.noSetData')}</div>
              ) : (
              <div className="dashboard-set-chart-inner" style={{ width: '100%', height: '100%' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sets} role="img" aria-labelledby="dashboard-set-title" layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
                  <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `${quoteSymbol}${v}`} />
                  <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                    formatter={v => [formatMoney(v), t('dash.value')]}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {sets.map((_, index) => <Cell key={index} fill={COLORS[index % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              </div>
              )}
            </div>
            {sets.length > 0 && <ChartDataTable titleId="dashboard-set-title" title={setTitle} category={t('sort.by.set')} rows={sets} series={[{ key: 'value', label: t('dash.value') }]} format={formatMoney} />}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
            {/* Color distribution columns */}
            <div className="dashboard-subsection view-section">
              <h3 id="dashboard-type-title" className="section-heading">{typeTitle}</h3>
              <div className="chart-container dashboard-distribution-chart" role="region" aria-labelledby="dashboard-type-title" tabIndex={0}>
                {typeChartData.length === 0 ? (
                  <div className="chart-empty">{t('dash.noTypeData')}</div>
                ) : (
                <div style={{ height: '100%', minWidth: Math.max(360, typeChartData.length * 85) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={typeChartData} role="img" aria-labelledby="dashboard-type-title" margin={{ top: 10, right: 15, left: 0, bottom: 5 }}>
                    <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} interval={0} style={{ fontSize: '0.8rem' }} />
                    <YAxis allowDecimals={false} domain={[0, 'auto']} stroke="var(--text-secondary)" width={45} />
                    <Bar dataKey="value" maxBarSize={48} radius={[4, 4, 0, 0]}>
                      {typeChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Bar>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                      itemStyle={{ color: 'var(--text-strong)' }}
                      labelStyle={{ color: 'var(--text-strong)' }}
                      formatter={(v) => [v, t('dash.cards')]}
                    />
                  </BarChart>
                </ResponsiveContainer>
                </div>
                )}
              </div>
              {typeChartData.length > 0 && <ChartDataTable titleId="dashboard-type-title" title={typeTitle} category={t(gameFilter === 'mtg' ? 'collection.fColor' : 'sort.by.type')} rows={typeChartData} series={[{ key: 'value', label: t('dash.cards') }]} />}
            </div>

            {/* Rarity Distribution Chart */}
            <div className="dashboard-subsection view-section">
              <h3 id="dashboard-rarity-title" className="section-heading">{rarityTitle}</h3>
              <div className="chart-container dashboard-distribution-chart" role="region" aria-labelledby="dashboard-rarity-title" tabIndex={0}>
                {rarityChartData.length === 0 ? (
                  <div className="chart-empty">{t('dash.noRarityData')}</div>
                ) : (
                <div style={{ height: '100%', minWidth: Math.max(360, rarityChartData.length * 100) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={rarityChartData} role="img" aria-labelledby="dashboard-rarity-title" margin={{ top: 10, right: 15, left: 0, bottom: 5 }}>
                    <XAxis dataKey="name" stroke="var(--text-secondary)" tickLine={false} interval={0} style={{ fontSize: '0.8rem' }} />
                    <YAxis allowDecimals={false} domain={[0, 'auto']} stroke="var(--text-secondary)" width={45} />
                    <Bar dataKey="value" maxBarSize={48} radius={[4, 4, 0, 0]}>
                      {rarityChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Bar>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                      itemStyle={{ color: 'var(--text-strong)' }}
                      labelStyle={{ color: 'var(--text-strong)' }}
                      formatter={(v) => [v, t('dash.cards')]}
                    />
                  </BarChart>
                </ResponsiveContainer>
                </div>
                )}
              </div>
              {rarityChartData.length > 0 && <ChartDataTable titleId="dashboard-rarity-title" title={rarityTitle} category={t('sort.by.rarity')} rows={rarityChartData} series={[{ key: 'value', label: t('dash.cards') }]} />}
            </div>
          </div>
        </div>

      </div>
        <DashboardAnalytics analytics={stats.analytics} inventory={inventoryFilter} />
      </section>

      {/* Card Inspector Modal Overlay */}
      <CardInspectorModal
        card={inspectorCard}
        onClose={() => setInspectorCard(null)}
        onUpdate={onUpdate}
        showToast={showToast}
        onViewStorage={(card) => {
          if (setSelectedLocationId) setSelectedLocationId(card.location_id || 'unsorted');
          if (setFocusEntryId) setFocusEntryId(card.entry_id || card.id);
          onNavigate('storage', card.list_type === 'graveyard' ? 'graveyard' : 'collection');
          setInspectorCard(null);
        }}
      />
    </div>
  );
}

export default Dashboard;
