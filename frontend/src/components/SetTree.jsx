import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../utils/i18n';

// A release family picker: parent sets, each expandable into the subsets that ship
// with them (tokens, art series, promos, Commander decks).
//
// Shared on purpose. Three places need the same question answered — the scanner's
// set filter, the catalog build picker, and the first-run wizard — and they only
// differ in what they DO with the answer. Two copies of this drifted once already
// (the old per-set index panel vs the scanner), and the failure mode is subtle:
// each subset is its own set code in the catalog, so a list that quietly omits
// them scopes a scan to the main set and silently excludes every token in the box.
//
// Selection is a flat list of catalog set codes — parent codes and subset codes
// side by side, which is what card_cache.set_id holds and what the scan route
// filters on. The tree is a VIEW of that list, not a second format: a family is
// "on" when its parent code is present, a subset when its own code is.
export default function SetTree({
  sets,                 // [{ id, name, children: [{code,name,type,cardCount}] }]
  codeOf,               // (set) => the catalog set code for this game
  selected,             // array of selected codes
  onToggleCode,         // (code) => void
  onToggleFamily,       // (set) => void — parent + its subsets together
  counts = null,        // { <setId>: { cached, embedded } } for the coverage badge
  showCounts = false,   // counts only mean something for a locally built catalog
  query = '',           // filter text
  onlyWithCounts = false, // hide families the catalog holds nothing for
  maxHeight = 260,
  emptyLabel,
}) {
  const { t } = useT();
  const [expanded, setExpanded] = useState(() => new Set());

  const has = (code) => selected.some(c => String(c).toLowerCase() === String(code).toLowerCase());
  const embeddedIn = (code) => (counts?.[String(code).toLowerCase()]?.embedded) || 0;
  // A family's coverage includes its subsets: ticking Foundations scans its tokens
  // too, so a badge that counted only the parent would understate what is there.
  const familyEmbedded = (s) => embeddedIn(codeOf(s))
    + (s.children || []).reduce((n, c) => n + embeddedIn(c.code), 0);

  const q = query.trim().toLowerCase();
  const visible = sets
    .filter(s => !onlyWithCounts || familyEmbedded(s) > 0)
    .filter(s => !q
      || [s.id, codeOf(s), s.name].some(v => (v || '').toLowerCase().includes(q))
      || (s.children || []).some(c => [c.code, c.name].some(v => (v || '').toLowerCase().includes(q))));

  const toggleExpand = (code) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  return (
    <div style={{ maxHeight, overflowY: 'auto', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', background: 'rgba(0,0,0,0.25)' }}>
      {visible.length === 0 ? (
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0, padding: '0.6rem' }}>
          {emptyLabel || t('scan.noSetMatches')}
        </p>
      ) : visible.map((s) => {
        const code = codeOf(s);
        const kids = s.children || [];
        const on = has(code);
        const kidsOn = kids.filter(c => has(c.code)).length;
        const isExpanded = expanded.has(code);
        return (
          <div key={s.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.5rem' }}>
              {kids.length > 0 ? (
                <button
                  type="button"
                  onClick={() => toggleExpand(code)}
                  aria-expanded={isExpanded}
                  aria-label={t(isExpanded ? 'scan.collapseSubsets' : 'scan.expandSubsets')}
                  title={t(isExpanded ? 'scan.collapseSubsets' : 'scan.expandSubsets')}
                  style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, display: 'flex', flexShrink: 0 }}
                >
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : <span style={{ width: 14, flexShrink: 0 }} />}
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: 0, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={on}
                  // Partly-included family: the parent is on but some subsets were
                  // unticked. Says so instead of reading as "the whole box".
                  ref={(el) => { if (el) el.indeterminate = on && kids.length > 0 && kidsOn < kids.length; }}
                  onChange={() => onToggleFamily(s)}
                  style={{ accentColor: 'var(--accent-green)', flexShrink: 0 }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text-strong)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                <code style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textTransform: 'uppercase', flexShrink: 0 }}>{code}</code>
              </label>
              {kids.length > 0 && (
                <span style={{ fontSize: '0.62rem', color: on && kidsOn ? 'var(--accent-green)' : 'var(--text-muted)', flexShrink: 0 }}>
                  {on ? `${kidsOn}/${kids.length}` : `+${kids.length}`}
                </span>
              )}
              {/* What the scanner actually holds for this family. A set with nothing
                  embedded cannot be scanned no matter how confidently it is listed. */}
              {showCounts && (
                <span style={{ fontSize: '0.62rem', flexShrink: 0, color: familyEmbedded(s) ? 'var(--accent-green)' : 'var(--accent-yellow)' }}>
                  {familyEmbedded(s)
                    ? t('scan.setIndexedCount', { count: familyEmbedded(s) })
                    : t('scan.setNotBuilt')}
                </span>
              )}
            </div>
            {isExpanded && kids.map((c) => (
              <label key={c.code} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.25rem 0.5rem 0.25rem 2.1rem', cursor: 'pointer', opacity: has(c.code) ? 1 : 0.5 }}>
                <input
                  type="checkbox"
                  checked={has(c.code)}
                  onChange={() => onToggleCode(c.code)}
                  style={{ accentColor: 'var(--accent-green)', flexShrink: 0 }}
                />
                <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                <code style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textTransform: 'uppercase', flexShrink: 0 }}>{c.code}</code>
                <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginLeft: 'auto', flexShrink: 0, textTransform: 'capitalize' }}>{c.type}</span>
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}
