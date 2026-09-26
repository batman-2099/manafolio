import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { useT } from '../utils/i18n';

const cellStyle = { padding: '0.65rem', borderBottom: '1px solid var(--border-glass)', textAlign: 'left' };
const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' };
const noteStyle = { color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.5, margin: '0.75rem 0' };

export default function DashboardAnalytics({ analytics, inventory = 'all' }) {
  const { t, locale } = useT();
  const isArchive = inventory === 'graveyard';
  const number = (value) => value.toLocaleString(locale);
  const distributionSeries = isArchive ? [
    { key: 'owned', label: t('dash.archivedCopies'), color: '#8b5cf6' },
  ] : [
    { key: 'owned', label: t('dash.ownedCopies'), color: 'var(--accent-blue)' },
    { key: 'decks', label: t('dash.savedDeckSlots'), color: 'var(--accent-yellow)' },
  ];
  const charts = [
    {
      key: 'growth', title: t(isArchive ? 'dash.archiveGrowthTitle' : 'dash.growthTitle'), note: t(isArchive ? 'dash.archiveGrowthNote' : 'dash.growthNote'),
      rows: analytics?.growth?.map(row => ({ ...row, name: new Date(`${row.month}-01T00:00:00Z`).toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }) })),
      category: t('dash.month'), empty: t(isArchive ? 'dash.noArchiveGrowth' : 'dash.noGrowth'), stacked: true,
      series: isArchive ? [
        { key: 'graveyard', label: t('dash.archivedCopies'), color: '#8b5cf6' },
      ] : [
        { key: 'physical', label: t('dash.physical'), color: 'var(--accent-blue)' },
        { key: 'arena', label: t('dash.arena'), color: 'var(--accent-yellow)' },
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
  const decks = analytics?.deckPerformance;

  return (
    <div style={{ display: 'grid', gap: '1.5rem', margin: '1.5rem 0', minWidth: 0 }}>
      {charts.map(chart => (
        <section key={chart.key} className="glass-panel" aria-labelledby={`analytics-${chart.key}`} style={{ minWidth: 0 }}>
          <h3 id={`analytics-${chart.key}`} className="chart-title">{chart.title}</h3>
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
              <details style={{ marginTop: '0.75rem' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-primary)' }}>{t('dash.viewData')}</summary>
                <div role="region" aria-label={chart.title} tabIndex={0} style={{ overflowX: 'auto' }}>
                  <table style={tableStyle}>
                    <caption style={noteStyle}>{chart.title}</caption>
                    <thead><tr><th scope="col" style={cellStyle}>{chart.category}</th>{chart.series.map(series => <th key={series.key} scope="col" style={cellStyle}>{series.label}</th>)}</tr></thead>
                    <tbody>{chart.rows.map(row => <tr key={row.month || row.name}><th scope="row" style={cellStyle}>{row.name}</th>{chart.series.map(series => <td key={series.key} style={cellStyle}>{number(row[series.key])}</td>)}</tr>)}</tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </section>
      ))}
      {!isArchive && <section className="glass-panel" aria-labelledby="analytics-decks" style={{ minWidth: 0 }}>
        <h3 id="analytics-decks" className="chart-title">{t('dash.deckPerformance')}</h3>
        <p style={noteStyle}>{t('dash.deckPerformanceNote')}</p>
        {decks?.length > 0 && <p style={noteStyle}>{t('dash.lowSampleNote')}</p>}
        {!decks ? <p style={noteStyle}>{t('dash.analyticsUnavailable')}</p> : decks.length === 0 ? <p style={noteStyle}>{t('dash.noDeckPerformance')}</p> : (
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
