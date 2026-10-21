import { useEffect, useRef, useState } from 'react';
import { useT } from '../utils/i18n';

export default function SetCodeField({ id, label, value, onChange, lang = 'en', disabled = false }) {
  const { t } = useT();
  const [knownSets, setKnownSets] = useState([]);
  const [open, setOpen] = useState(false);
  const input = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setKnownSets([]);
    fetch(`/api/sets?game=mtg&lang=${encodeURIComponent(lang)}`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : [])
      .then(rows => {
        if (controller.signal.aborted) return;
        const seen = new Set();
        setKnownSets(rows
          .filter(set => !set.game || set.game === 'mtg')
          .map(set => ({ code: String(set.id || '').replace(/^mtg-/, ''), name: set.name, symbol_url: set.symbol_url }))
          .filter(set => set.code && !seen.has(set.code) && seen.add(set.code))
          .reverse());
      })
      .catch(() => {});
    return () => controller.abort();
  }, [lang]);

  return <div className="search-sets-field" style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', position: 'relative', minWidth: 0 }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => { if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); input.current?.focus(); setOpen(false); } }}>
    <label className="control-label" htmlFor={id}>{label}</label>
    <input ref={input} id={id} type="text" className="input-control" autoComplete="off"
      style={{ width: '100%', minWidth: 0 }} disabled={disabled}
      placeholder={t('search.setsPlaceholderMtg')} value={value}
      aria-controls={open && !disabled ? `${id}-suggestions` : undefined}
      onFocus={() => setOpen(true)} onChange={event => { onChange(event.target.value); setOpen(true); }} />
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      {knownSets.filter(set => value.toLowerCase().split(/[\s,]+/).includes(set.code.toLowerCase())).map(set => (
        <span key={set.code} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}>
          {set.symbol_url && <img src={set.symbol_url} alt="" width="20" height="20" style={{ objectFit: 'contain', background: '#fff', borderRadius: '3px', padding: '2px' }} onError={event => { event.currentTarget.style.display = 'none'; }} />}
          {set.name} ({set.code.toUpperCase()})
        </span>
      ))}
    </div>
    {open && !disabled && (
      <section id={`${id}-suggestions`} aria-label={t('search.setSuggestions')} style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, maxHeight: '260px', overflowY: 'auto', background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)' }}>
        {knownSets.filter(set => {
          const term = value.split(/[\s,]+/).at(-1).toLowerCase();
          return !term || set.code.toLowerCase().includes(term) || set.name.toLowerCase().includes(term);
        }).map(set => (
          <button key={set.code} type="button" className="btn btn-secondary"
            style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', gap: '0.5rem', textAlign: 'left' }}
            onClick={() => { onChange(value.replace(/[^\s,]*$/, set.code)); input.current?.focus(); setOpen(false); }}>
            {set.symbol_url && <img src={set.symbol_url} alt="" width="24" height="24" loading="lazy" style={{ objectFit: 'contain', background: '#fff', borderRadius: '3px', padding: '2px' }} onError={event => { event.currentTarget.style.display = 'none'; }} />}
            {set.name} ({set.code.toUpperCase()})
          </button>
        ))}
      </section>
    )}
  </div>;
}
