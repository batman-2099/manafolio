import { useState } from 'react';
import { useT } from '../utils/i18n';

// Distribute a total price paid (a pack/deck) across a set of collection
// entries, setting each card's per-card purchase_price. The split math lives
// server-side in POST /api/collection/bulk (action 'purchase_split'); this is
// just the total input + method picker shared by the collection bulk bar and
// the scanner's recent-scans panel.
export default function PackPriceSplitter({ entryIds, onApplied, showToast, style }) {
  const { t } = useT();
  const [total, setTotal] = useState('');
  const [method, setMethod] = useState('weighted');
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    const amount = parseFloat(total);
    if (!(amount >= 0)) { showToast(t('split.errNoTotal')); return; }
    if (!entryIds.length) { showToast(t('split.errNoCards')); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/collection/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_ids: entryIds, action: 'purchase_split', value: { total: amount, method } }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { showToast(d.message || t('split.applied')); setTotal(''); onApplied?.(); }
      else showToast(d.error || t('split.failed'));
    } catch {
      showToast(t('split.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', ...style }}>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{t('split.totalPaid')} $</span>
      <input
        type="number" step="0.01" min="0" value={total}
        onChange={(e) => setTotal(e.target.value)}
        placeholder="0.00"
        onKeyDown={(e) => { if (e.key === 'Enter') apply(); }}
        style={{ width: '5.5rem', fontSize: '0.72rem', padding: '0.3rem 0.4rem', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', color: 'var(--text-strong)' }}
      />
      <select
        className="select-control" value={method} onChange={(e) => setMethod(e.target.value)}
        style={{ fontSize: '0.72rem', padding: '0.3rem 0.4rem', maxWidth: '130px' }}
        title={t('split.methodHint')}
      >
        <option value="weighted">{t('split.byValue')}</option>
        <option value="equal">{t('split.evenly')}</option>
      </select>
      <button className="btn btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }} disabled={busy || !entryIds.length} onClick={apply}>
        {t('split.splitAcross', { count: entryIds.length })}
      </button>
    </div>
  );
}
