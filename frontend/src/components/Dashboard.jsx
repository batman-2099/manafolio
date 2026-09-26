import { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, AreaChart, Area } from 'recharts';
import { TrendingUp } from 'lucide-react';
import { getCardDisplayName } from '../utils/langHelper';
import { priceText, currencySymbol } from '../utils/formatPrice';
import { getPrintingBadgeLabel, getPrintingBadgeStyle } from '../utils/cardPrinting';
import { defaultGameFilter, gameLabel } from '../utils/games';
import { useT } from '../utils/i18n';
import CardInspectorModal from './CardInspectorModal';
import CardImage from './CardImage';
import DashboardAnalytics from './DashboardAnalytics';

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', 
  '#ec4899', '#14b8a6', '#f43f5e', '#a855f7', '#6366f1'
];

const TYPE_COLORS = {
  'Colorless': '#cbd5e1',
  'White': '#fef08a',
  'Blue': '#3b82f6',
  'Black': '#334155',
  'Red': '#ef4444',
  'Green': '#10b981',
  'Land': '#d97706',
  'Amber': '#f59e0b',
  'Amethyst': '#a855f7',
  'Emerald': '#10b981',
  'Ruby': '#ef4444',
  'Sapphire': '#3b82f6',
  'Steel': '#94a3b8'
};

function Dashboard({ statsTrigger, onNavigate, setSelectedLocationId, setFocusEntryId, onUpdate, showToast }) {
  const { t, locale } = useT();
  // Money and dates follow the interface language, not the browser's: a user who
  // picked German sees 1.234,56 and 3.8.2026 even on an en-US browser.
  const money = (n) => (n || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [statsRefresh, setStatsRefresh] = useState(0);
  const [timePeriod, setTimePeriod] = useState('30d');
  const gameFilter = defaultGameFilter();
  const [inventoryFilter, setInventoryFilter] = useState('all');
  const isArchive = inventoryFilter === 'graveyard';
  const valueColor = isArchive ? '#8b5cf6' : 'var(--accent-green)';
  
  // Timeline Chart State
  const [historyData, setHistoryData] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // Clickable Card Inspector State
  const [inspectorCard, setInspectorCard] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ inventory: inventoryFilter });
    if (gameFilter) params.set('game', gameFilter);
    const load = async () => {
      try {
        const response = await fetch(`/api/stats?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(t('dash.errStats'));
        const data = await response.json();
        if (!controller.signal.aborted) setStats(data);
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [statsTrigger, statsRefresh, gameFilter, inventoryFilter, t]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryData([]);
    if (loading || !stats || stats.summary.totalCards === 0) {
      setLoadingHistory(false);
      return () => controller.abort();
    }
    setLoadingHistory(true);
    const params = new URLSearchParams({ period: timePeriod, inventory: inventoryFilter });
    if (gameFilter) params.set('game', gameFilter);
    const load = async () => {
      try {
        const response = await fetch(`/api/stats/history?${params}`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted) setHistoryData(data);
        }
      } catch (err) {
        if (!controller.signal.aborted) console.error('Error loading history timeline:', err);
      } finally {
        if (!controller.signal.aborted) setLoadingHistory(false);
      }
    };
    load();
    return () => controller.abort();
  }, [timePeriod, stats, loading, gameFilter, inventoryFilter]);

  const renderFilters = () => (
    <>
      <header className="page-heading">
        <h1 className="page-title">{t('nav.dashboard')}</h1>
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

  if (loading) {
    return <div className="dashboard-page">{renderFilters()}<div role="status" aria-label={t('dash.loading')} className="spinner"></div></div>;
  }

  if (error) {
    return (
      <div className="dashboard-page">
        {renderFilters()}
        <div className="dashboard-empty" style={{ color: 'var(--text-secondary)' }}>
          <p role="alert">{t('dash.errLoad', { error })}</p>
          <button className="btn btn-primary" onClick={() => setStatsRefresh(value => value + 1)} style={{ marginTop: '1rem' }}>{t('dash.retry')}</button>
        </div>
      </div>
    );
  }

  if (!stats || stats.summary.totalCards === 0) {
    const isFiltered = Boolean(gameFilter);
    const gameName = isFiltered ? gameLabel(gameFilter, true) : '';
    return (
      <div className="dashboard-page">
        {renderFilters()}
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
  const roi = summary.roi || { abs: 0, pct: null };
  const isPositive = (roi.abs || 0) >= 0;
  // Only Cardmarket's 7/30-day averages provide real price comparisons.
  const change = timePeriod === '7d' ? summary.change7d
    : timePeriod === '30d' ? summary.change30d
    : timePeriod === '1y' ? summary.change1y : summary.change5y;

  return (
    <div className="dashboard-page">
      {renderFilters()}
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
            <dd className="dashboard-summary-value">{currencySymbol()}{money(summary.totalValue)}</dd>
          </div>
        </dl>
        <dl className="dashboard-summary-secondary">
          <div>
            <dt>{t(isArchive ? 'dash.archivedCost' : 'dash.totalInvested')}</dt>
            <dd className="dashboard-summary-value">{currencySymbol()}{money(summary.totalSpent)}</dd>
            <dd className="dashboard-summary-note">{t('dash.avgPerCard', { price: priceText(summary.avgCardValue) })}</dd>
          </div>
          <div>
            <dt>{t(isArchive ? 'dash.archivedValueDifference' : 'dash.unrealizedGain')}</dt>
            <dd className={`dashboard-summary-value ${isPositive ? 'positive' : 'negative'}`}>
              {isPositive ? '+' : '−'}{currencySymbol()}{money(Math.abs(roi.abs || 0))}
            </dd>
            <dd className="dashboard-summary-note">
              {roi.pct === null ? t(isArchive ? 'dash.archivedCostUnset' : 'dash.roiUnset') : t('dash.roiVsCost', { pct: `${isPositive ? '+' : ''}${roi.pct}` })}
            </dd>
          </div>
        </dl>
      </div>

      <section className="dashboard-timeline view-section" aria-labelledby="dashboard-timeline-title">
        <div className="dashboard-timeline-header">
          <h2 id="dashboard-timeline-title" className="section-heading">{t(isArchive ? 'dash.archiveTimelineTitle' : 'dash.timelineTitle')}</h2>
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
          {!change?.available ? <span>{t('dash.noPriceHistory')}</span> : (
            <span className={change.abs >= 0 ? 'positive' : 'negative'}>
              <TrendingUp aria-hidden="true" size={14} style={{ transform: change.abs >= 0 ? 'none' : 'rotate(180deg)' }} />
              {change.abs >= 0 ? '+' : ''}{currencySymbol()}{money(change.abs)} ({change.abs >= 0 ? '+' : ''}{change.pct}%)
            </span>
          )}
        </div>
        {isArchive && <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '1rem' }}>{t('dash.archiveTimelineNote')}</p>}
        <div className="chart-container" style={{ height: '240px', position: 'relative' }}>
          {loadingHistory ? (
            <div role="status" aria-label={t('dash.loading')} className="spinner" style={{ position: 'absolute', top: '45%', left: '45%' }}></div>
          ) : historyData.length < 2 ? (
            <div className="chart-empty">{t('dash.notEnoughHistory')}</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={historyData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorVal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={valueColor} stopOpacity={0.4}/>
                    <stop offset="95%" stopColor={valueColor} stopOpacity={0.0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} />
                <YAxis stroke="var(--text-secondary)" style={{ fontSize: '0.7rem' }} tickFormatter={(v) => `${currencySymbol()}${v}`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                  labelStyle={{ color: 'var(--text-primary)' }}
                  formatter={(v) => [`${currencySymbol()}${v}`, t(isArchive ? 'dash.archivedValue' : 'dash.portfolioValue')]}
                />
                <Area type="monotone" dataKey="value" stroke={valueColor} strokeWidth={2} fillOpacity={1} fill="url(#colorVal)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="dashboard-analytics view-section" aria-labelledby="dashboard-analytics-title">
        <h2 id="dashboard-analytics-title" className="section-heading">{t('dash.analytics')}</h2>
        <DashboardAnalytics analytics={stats.analytics} inventory={inventoryFilter} />
        <div className="dashboard-details">
        {/* Left Column: Charts */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Card Value by Set Chart */}
          <div className="dashboard-subsection view-section">
            <h3 className="section-heading">{t(isArchive ? 'dash.archiveValueBySet' : 'dash.valueBySet')}</h3>
            <div className="chart-container dashboard-set-chart" role="region" aria-label={t(isArchive ? 'dash.archiveValueBySet' : 'dash.valueBySet')} tabIndex={0}>
              {sets.length === 0 ? (
                <div className="chart-empty">{t('dash.noSetData')}</div>
              ) : (
              <div className="dashboard-set-chart-inner" style={{ width: '100%', height: '100%' }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sets} layout="vertical" margin={{ left: 10, right: 30, top: 10, bottom: 10 }}>
                  <XAxis type="number" stroke="var(--text-secondary)" tickFormatter={(v) => `${currencySymbol()}${v}`} />
                  <YAxis dataKey="name" type="category" width={120} stroke="var(--text-secondary)" tickLine={false} axisLine={false} style={{ fontSize: '0.8rem' }} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                    formatter={(v) => [`${currencySymbol()}${v}`, t('dash.value')]}
                  />
                  <Bar dataKey="value" fill="var(--accent-red)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
              </div>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }}>
            {/* Type Distribution Donut Chart */}
            <div className="dashboard-subsection view-section">
              <h3 className="section-heading">{t(gameFilter === 'mtg' ? 'dash.colorDistribution' : 'dash.typeDistribution')}</h3>
              <div className="chart-container dashboard-donut" style={{ height: '220px' }}>
                {typeChartData.length === 0 ? (
                  <div className="chart-empty">{t('dash.noTypeData')}</div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={typeChartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {typeChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                      itemStyle={{ color: 'var(--text-strong)' }}
                      labelStyle={{ color: 'var(--text-strong)' }}
                      formatter={(v) => [v, t('dash.cards')]}
                    />
                    <Legend 
                      verticalAlign="bottom" 
                      height={36} 
                      iconSize={10} 
                      style={{ fontSize: '0.75rem' }} 
                      formatter={(value) => <span style={{ color: 'var(--text-secondary)' }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Rarity Distribution Chart */}
            <div className="dashboard-subsection view-section">
              <h3 className="section-heading">{t('dash.rarityDistribution')}</h3>
              <div className="chart-container dashboard-donut" style={{ height: '220px' }}>
                {rarityChartData.length === 0 ? (
                  <div className="chart-empty">{t('dash.noRarityData')}</div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={rarityChartData}
                      cx="50%"
                      cy="50%"
                      innerRadius={45}
                      outerRadius={78}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {rarityChartData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)' }}
                      itemStyle={{ color: 'var(--text-strong)' }}
                      labelStyle={{ color: 'var(--text-strong)' }}
                      formatter={(v) => [v, t('dash.cards')]}
                    />
                    <Legend 
                      verticalAlign="bottom" 
                      height={36} 
                      iconSize={10} 
                      style={{ fontSize: '0.75rem' }} 
                      formatter={(value) => <span style={{ color: 'var(--text-secondary)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Mini Tables & Lists */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          
          {/* Top Valuable Cards */}
          <div className="dashboard-subsection view-section" style={{ flex: 1 }}>
            <h3 className="section-heading">
              {t(isArchive ? 'dash.archiveTopValuable' : 'dash.topValuable')}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.25rem' }}>
              {topValuable.map((card, idx) => (
                <button
                  type="button" key={idx}
                  onClick={() => setInspectorCard(card)}
                  style={{ 
                    display: 'flex', 
                    gap: '0.75rem', 
                    alignItems: 'center', 
                    padding: '0.5rem 0',
                    cursor: 'pointer'
                  }}
                  className="dashboard-card-clickable dashboard-card-row"
                >
                  <CardImage card={card} style={{ width: '56px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }} />
                  <div className="dashboard-card-description" style={{ flex: 1, overflow: 'hidden' }}>
                    <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {getCardDisplayName(card.name, card.language, card.printed_name)}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span>{card.set_name} • {card.rarity}</span>
                      {card.printing && card.printing !== 'Normal' && (
                        <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', flexShrink: 0, ...getPrintingBadgeStyle(card.printing) }}>
                          {getPrintingBadgeLabel(card.printing)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="dashboard-card-price" style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 800, color: 'var(--accent-yellow)', fontSize: '0.95rem' }}>{priceText(card.price_trend)}<span style={{ fontSize: '0.6rem', fontWeight: 500, color: 'var(--text-muted)' }}> {t('dash.each')}</span></div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {card.quantity > 1 ? t('dash.qtyTotal', { qty: card.quantity, price: priceText(card.price_trend * card.quantity) }) : t('dash.qty', { qty: 1 })}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Recent Additions */}
          {recentAdditions.length > 0 && (
            <div className="dashboard-subsection view-section" style={{ flex: 1 }}>
              <h3 className="section-heading">
                {t(isArchive ? 'dash.archiveRecentAdditions' : 'dash.recentAdditions')}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '1.25rem' }}>
                {recentAdditions.map((card, idx) => (
                  <button
                    type="button" key={idx}
                    onClick={() => setInspectorCard(card)}
                    style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', padding: '0.5rem 0', cursor: 'pointer' }}
                    className="dashboard-card-clickable dashboard-card-row"
                  >
                    <CardImage card={card} style={{ width: '48px', aspectRatio: 0.718, objectFit: 'cover', borderRadius: '5px', boxShadow: '0 2px 6px rgba(0,0,0,0.4)' }} />
                    <div className="dashboard-card-description" style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--text-strong)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {getCardDisplayName(card.name, card.language, card.printed_name)}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                        <span>{card.set_name} • #{card.number}</span>
                        {card.printing && card.printing !== 'Normal' && (
                          <span style={{ fontSize: '0.55rem', fontWeight: 800, padding: '1px 4px', borderRadius: '3px', flexShrink: 0, ...getPrintingBadgeStyle(card.printing) }}>
                            {getPrintingBadgeLabel(card.printing)}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="dashboard-card-price" style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, color: 'var(--accent-yellow)', fontSize: '0.8rem' }}>{priceText(card.price_trend)}<span style={{ fontSize: '0.55rem', fontWeight: 500, color: 'var(--text-muted)' }}> {t('dash.each')}</span></div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{card.quantity > 1 ? t('dash.qty', { qty: card.quantity }) : (card.added_at ? new Date(card.added_at).toLocaleDateString(locale) : '')}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

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
      </div>
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
