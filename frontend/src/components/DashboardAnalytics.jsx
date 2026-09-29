import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useT } from '../utils/i18n';
import { useScrollReveal } from '../utils/useScrollReveal';

const cellStyle = { padding: '0.65rem', borderBottom: '1px solid var(--border-glass)', textAlign: 'left' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' };
const noteStyle = { color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5, margin: '0.75rem 0' };

export function ChartDataTable({ titleId, title, category, rows, series, format, categoryKey = 'name', formatCategory = value => value }) {
  const { t, locale } = useT();
  return (
    <details className="dashboard-data" style={{ marginTop: '0.75rem' }}>
      <summary aria-describedby={titleId}>{t('dash.viewData')}</summary>
      <div role="region" aria-labelledby={titleId} tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <caption style={noteStyle}>{title}</caption>
          <thead><tr><th scope="col" style={{ ...cellStyle, overflowWrap: 'normal' }}>{category}</th>{series.map(item => <th key={item.key} scope="col" style={{ ...cellStyle, overflowWrap: 'normal' }}>{item.label}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.month || row[categoryKey]}><th scope="row" style={cellStyle}>{formatCategory(row[categoryKey])}</th>{series.map(item => <td key={item.key} style={{ ...cellStyle, whiteSpace: 'nowrap' }}>{format ? format(row[item.key]) : row[item.key].toLocaleString(locale)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}

export default function DashboardAnalytics({ analytics, inventory = 'all' }) {
  const { t, locale } = useT();
  const revealRef = useScrollReveal();
  const isArchive = inventory === 'graveyard';
  const number = (value) => value.toLocaleString(locale);
  const distributionSeries = isArchive ? [
    { key: 'owned', label: t('dash.archivedCopies'), color: '#a78bfa' },
  ] : [
    { key: 'owned', label: t('dash.ownedCopies'), color: '#60a5fa' },
    { key: 'decks', label: t('dash.savedDeckSlots'), color: '#fbbf24' },
  ];
  const charts = [
    {
      key: 'growth', title: t(isArchive ? 'dash.archiveGrowthTitle' : 'dash.growthTitle'), note: t(isArchive ? 'dash.archiveGrowthNote' : 'dash.growthNote'),
      rows: analytics?.growth?.map(row => ({ ...row, name: new Date(`${row.month}-01T00:00:00Z`).toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }) })),
      category: t('dash.month'), empty: t(isArchive ? 'dash.noArchiveGrowth' : 'dash.noGrowth'), stacked: true,
      series: isArchive ? [
        { key: 'graveyard', label: t('dash.archivedCopies'), color: '#a78bfa' },
      ] : [
        { key: 'physical', label: t('dash.physical'), color: '#60a5fa' },
        { key: 'arena', label: t('dash.arena'), color: '#fbbf24' },
      ],
    },
    {
      key: 'colors', title: t(isArchive ? 'dash.archiveColorDistribution' : 'dash.colorComparison'), note: t('dash.colorNote'),
      rows: analytics?.colors?.map(row => ({ ...row, name: t(`dash.color.${row.name}`) })),
      category: t('dash.colorLabel'), empty: t(isArchive ? 'dash.noArchiveDistribution' : 'dash.noDistribution'), series: distributionSeries,
    },
    {
      key: 'mana', title: t(isArchive ? 'dash.archiveManaDistribution' : 'dash.manaComparison'), note: t('dash.manaNote'),
      rows: analytics?.mana?.map(row => ({ ...row, name: row.name === 'Unknown' ? t('dash.color.Unknown') : row.name })),
      category: t('dash.manaValue'), empty: t(isArchive ? 'dash.noArchiveDistribution' : 'dash.noDistribution'), series: distributionSeries,
    },
  ];
  const decks = analytics?.deckPerformance?.filter(deck => deck.wins > 0 || deck.losses > 0);
  const allUnavailable = charts.every(chart => !chart.rows) && (isArchive || !decks);

  if (allUnavailable) {
    return (
      <div>
        <p style={noteStyle}>{t('dash.analyticsUnavailable')}</p>
        <details className="dashboard-methodology">
          <summary>{t('dash.methodology')}</summary>
          <div className="dashboard-analytics-grid">
            {charts.map(chart => (
              <section key={chart.key} aria-labelledby={`analytics-${chart.key}`}>
                <h3 id={`analytics-${chart.key}`} className="section-heading">{chart.title}</h3>
                <p style={noteStyle}>{chart.note}</p>
              </section>
            ))}
            {!isArchive && <section aria-labelledby="analytics-decks">
              <h3 id="analytics-decks" className="section-heading">{t('dash.deckPerformance')}</h3>
              <p style={noteStyle}>{t('dash.deckPerformanceNote')}</p>
            </section>}
          </div>
          {!isArchive && <p style={noteStyle}>{t('dash.deckSlotsNote')}</p>}
        </details>
      </div>
    );
  }

  return (
    <div ref={revealRef} className="dashboard-analytics-grid">
      {charts.map(chart => (
        <section key={chart.key} className="dashboard-subsection view-section" aria-labelledby={`analytics-${chart.key}`}>
          <h3 id={`analytics-${chart.key}`} className="section-heading">{chart.title}</h3>
          <p style={noteStyle}>{chart.note}</p>
          {chart.key !== 'growth' && !isArchive && <p style={noteStyle}>{t('dash.deckSlotsNote')}</p>}
          {!chart.rows ? <p style={noteStyle}>{t('dash.analyticsUnavailable')}</p> : (
            <>
              {!chart.rows.some(row => chart.series.some(series => row[series.key] > 0)) ? <p style={noteStyle}>{chart.empty}</p> : (
                <div aria-hidden="true" style={{ height: chart.key === 'growth' ? 260 : 300, minWidth: 0 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart.rows} layout={chart.key === 'growth' ? 'horizontal' : 'vertical'} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
                      {chart.key === 'growth' ? (
                        <>
                          <XAxis dataKey="name" stroke="var(--text-secondary)" minTickGap={25} style={{ fontSize: '0.75rem' }} />
                          <YAxis allowDecimals={false} stroke="var(--text-secondary)" width={45} />
                        </>
                      ) : (
                        <>
                          <XAxis type="number" allowDecimals={false} stroke="var(--text-secondary)" />
                          <YAxis type="category" dataKey="name" stroke="var(--text-secondary)" width={85} tickLine={false} style={{ fontSize: '0.75rem' }} />
                        </>
                      )}
                      <Tooltip contentStyle={{ backgroundColor: 'var(--bg-secondary)', borderColor: 'var(--border-glass)', color: 'var(--text-primary)' }} labelStyle={{ color: 'var(--text-primary)' }} itemStyle={{ color: 'var(--text-primary)' }} formatter={(value, name) => [number(value), name]} />
                      <Legend formatter={value => <span style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{value}</span>} />
                      {chart.series.map(series => <Bar key={series.key} dataKey={series.key} name={series.label} fill={series.color} stackId={chart.stacked ? 'inventory' : undefined} />)}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <ChartDataTable titleId={`analytics-${chart.key}`} title={chart.title} category={chart.category} rows={chart.rows} series={chart.series} />
            </>
          )}
        </section>
      ))}
      {!isArchive && <section className="dashboard-subsection view-section" aria-labelledby="analytics-decks">
        <h3 id="analytics-decks" className="section-heading">{t('dash.deckPerformance')}</h3>
        <p style={noteStyle}>{t('dash.deckPerformanceNote')}</p>
        {decks?.length > 0 && <p style={noteStyle}>{t('dash.lowSampleNote')}</p>}
        {!decks ? <p style={noteStyle}>{t('dash.analyticsUnavailable')}</p> : decks.length === 0 ? <p style={noteStyle}>{t('dash.noGames')}</p> : (
          <div role="region" aria-label={t('dash.deckPerformance')} tabIndex={0} style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead><tr>{['deck.deckName', 'deck.inventoryType', 'deck.wins', 'deck.losses', 'dash.games', 'dash.winRate'].map(key => <th key={key} scope="col" style={cellStyle}>{t(key)}</th>)}</tr></thead>
              <tbody>{decks.map(deck => (
                <tr key={deck.id}>
                  <th scope="row" style={{ ...cellStyle, minWidth: '9rem', overflowWrap: 'anywhere' }}>{deck.name}</th>
                  <td style={cellStyle}>{t(deck.inventory_type === 'arena' ? 'dash.arena' : 'dash.physical')}</td>
                  <td style={cellStyle}>{number(deck.wins)}</td>
                  <td style={cellStyle}>{number(deck.losses)}</td>
                  <td style={cellStyle}>{number(deck.games)}</td>
                  <td style={{ ...cellStyle, minWidth: '8rem' }}>
                    {deck.winRate === null ? t('dash.noGames') : (deck.winRate / 100).toLocaleString(locale, { style: 'percent', maximumFractionDigits: 1 })}
                    {deck.games < 10 && <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{t('dash.lowSample')}</div>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>}
    </div>
  );
}
