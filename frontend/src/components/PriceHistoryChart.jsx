import { useState, useEffect, useMemo } from 'react';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { priceText } from '../utils/formatPrice';
import { useT } from '../utils/i18n';

// The chart shows the last 30 days or all prices recorded by this installation.
// Scryfall returns current prices, not historical backfills.
const RANGE_KEYS = ['30d', 'all'];

// Shared, properly-proportioned price-history chart. Fetches its own data for a
// given card id and lets the user switch the time window. Give it real vertical
// room and let the YAxis reserve enough width for "$1,234" style ticks.
export default function PriceHistoryChart({
  cardId,
  // The card's own currency. Stored prices are never converted, so the axis and the
  // tooltip have to read in whatever marketplace quoted them (see utils/formatPrice).
  currency,
}) {
  const { t, locale } = useT();
  const [range, setRange] = useState('30d');
  const [historyState, setHistoryState] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const scope = JSON.stringify([cardId, range, currency]);
  const result = historyState?.scope === scope ? historyState.data : null;
  const data = result?.data;
  const insufficientHistory = !!result?.insufficientHistory;
  const coverage = result || {};
  const loading = historyState?.scope !== scope || historyState.loading;
  const error = historyState?.scope === scope && historyState.error;

  useEffect(() => {
    if (!cardId) return;
    const controller = new AbortController();
    setHistoryState(previous => ({ scope, data: previous?.scope === scope ? previous.data : null, loading: true, error: false }));
    (async () => {
      try {
        const response = await fetch(`/api/cards/${encodeURIComponent(cardId)}/price-history?range=${range}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!controller.signal.aborted) setHistoryState({ scope, data, loading: false, error: false });
      } catch {
        if (!controller.signal.aborted) setHistoryState(previous => ({ ...previous, loading: false, error: true }));
      }
    })();
    return () => controller.abort();
  }, [cardId, range, scope, refresh]);

  const chartData = useMemo(
    () => (data || []).map(d => ({ ...d, ts: new Date(d.recorded_at).getTime() })),
    [data]
  );

  const { pctChange, absChange } = useMemo(() => {
    if (!data || data.length < 2) return { pctChange: null, absChange: null };
    const first = data[0]?.price ?? 0;
    const last = data[data.length - 1]?.price ?? 0;
    const abs = last - first;
    const pct = first > 0 ? (abs / first) * 100 : 0;
    return { pctChange: pct, absChange: abs };
  }, [data]);

  if (!cardId) return null;

  const up = (pctChange ?? 0) >= 0;
  const trendColor = up ? 'var(--text-positive)' : 'var(--text-negative)';
  const rangeName = RANGE_KEYS.includes(range) ? t(`priceHistory.range.${range}.name`) : '';

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-2)', gap: 'var(--space-2)' }}>
        <span style={{ fontSize: '0.9375rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
          {t('priceHistory.title')} ({rangeName})
        </span>
        {pctChange !== null && (
          <span style={{ fontSize: '0.875rem', fontWeight: 600, color: trendColor }}>
            {up ? '▲' : '▼'} {up ? '+' : ''}{priceText(Math.abs(absChange), currency)} ({up ? '+' : '−'}{Math.abs(pctChange).toFixed(1)}%)
          </span>
        )}
      </div>

      {/* Range selector */}
      <div className="sub-nav-tabs" style={{ marginBottom: 'var(--space-2)' }}>
        {RANGE_KEYS.map(key => (
          <button
            type="button"
            key={key}
            onClick={() => setRange(key)}
            aria-pressed={range === key}
            className={`sub-nav-tab ${range === key ? 'active' : ''}`}
          >
            {t(`priceHistory.range.${key}.label`)}
          </button>
        ))}
      </div>

      {error ? (
        <div className="read-state">
          <p role="alert">{t('dash.errHistory')}{result && <> {t('common.staleData')}</>}</p>
          <button type="button" className="btn btn-secondary" onClick={() => setRefresh(value => value + 1)}>{t('dash.retry')}</button>
        </div>
      ) : loading && (
        <div className="read-state" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>{t(result ? 'common.refreshing' : 'common.loading')}</p>
        </div>
      )}

      {/* Say where the line came from. Cardmarket's rolling averages are real
          market data pulled per request; everything else is what Manafolio has
          watched happen since it was installed. */}
      {!loading && !insufficientHistory && (coverage.marketCount > 0 || coverage.recordedCount > 0) && (
        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: 'var(--space-2)', lineHeight: 1.5 }}>
          {coverage.marketCount > 0
            ? t('priceHistory.sourceCardmarket')
            : t('priceHistory.sourceRecorded', { count: coverage.spanDays || 0 })}
          {coverage.marketCount > 0 && coverage.recordedCount > 0
            ? ` + ${t('priceHistory.plusRecorded', { count: coverage.recordedCount })}`
            : ''}
        </div>
      )}

      <div style={{ width: '100%', height: '160px' }} aria-busy={loading}>
        {!result ? null : insufficientHistory ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '1rem', color: 'var(--text-secondary)', textAlign: 'center' }}>
            {t('priceHistory.insufficient')}
          </div>
        ) : (!chartData || chartData.length === 0) ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', fontSize: '1rem', color: 'var(--text-secondary)' }}>
            {t('priceHistory.noData')}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-glass)" vertical={false} />
              <XAxis dataKey="ts" type="number" scale="time" domain={['dataMin', 'dataMax']} hide />
              <YAxis
                domain={['auto', 'auto']}
                stroke="var(--text-secondary)"
                style={{ fontSize: '0.875rem' }}
                width={64}
                tickFormatter={(v) => priceText(v, currency)}
              />
              <Tooltip
                contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', fontSize: '0.875rem' }}
                labelStyle={{ color: 'var(--text-secondary)' }}
                formatter={(val) => [priceText(val, currency), t('priceHistory.market')]}
                labelFormatter={(label) => (label ? new Date(label).toLocaleDateString(locale) : '')}
              />
              <Area type="monotone" dataKey="price" stroke="var(--accent-yellow)" strokeWidth={1.75} fillOpacity={0.08} fill="var(--accent-yellow)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
