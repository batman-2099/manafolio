import { useState, useRef, useEffect, useId } from 'react';
import { ChevronDown, Check, X, Square } from 'lucide-react';
import { useT } from '../utils/i18n';

// A reusable checklist dropdown, standing in for a native <select> wherever
// a filter should allow choosing several values at once instead of one.
// Empty selections mean no filter. Optional excludedValue enables
// the include → exclude → clear cycle; ordinary checklists stay binary.
export default function MultiSelectDropdown({ label, options, value, onChange, allLabel, excludedValue }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const groupId = useId();

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (optValue) => {
    if (excludedValue) {
      if (value.includes(optValue)) onChange(value.filter(v => v !== optValue), [...excludedValue, optValue]);
      else if (excludedValue.includes(optValue)) onChange(value, excludedValue.filter(v => v !== optValue));
      else onChange([...value, optValue], excludedValue);
      return;
    }
    onChange(
      value.includes(optValue)
        ? value.filter(v => v !== optValue)
        : [...value, optValue]
    );
  };

  const summary = excludedValue?.length
    ? `${t('filter.require')}: ${value.length} · ${t('filter.exclude')}: ${excludedValue.length}`
    : value.length === 0
    ? allLabel
    : value.length === 1
      ? (options.find(o => o.value === value[0])?.label ?? value[0])
      : t('bulk.selected', { count: value.length });

  return (
    <div ref={ref} style={{ position: 'relative', zIndex: open ? 100 : 0 }} onKeyDown={(event) => {
      if (open && event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }}>
      <button
        ref={triggerRef}
        type="button"
        className="select-control"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', textAlign: 'left' }}
        aria-controls={open ? groupId : undefined}
        aria-expanded={open}
        aria-label={label}
        aria-describedby={`${groupId}-summary`}
      >
        <span id={`${groupId}-summary`} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <ChevronDown size={14} style={{ flexShrink: 0, marginLeft: '0.4rem' }} />
      </button>

      {open && (
        <div
          id={groupId}
          role="group"
          aria-label={label}
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 101,
            minWidth: '100%', maxHeight: '260px', overflowY: 'auto',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-glass)',
            borderRadius: 'var(--radius-sm)', padding: '0.35rem', boxShadow: 'var(--shadow-glow)'
          }}
        >
          {(value.length > 0 || excludedValue?.length > 0) && (
            <button
              type="button"
              className="btn btn-secondary"
              style={{ width: '100%', fontSize: '0.72rem', padding: '0.3rem', marginBottom: '0.3rem' }}
              onClick={() => excludedValue ? onChange([], []) : onChange([])}
            >
              {t('bulk.clear')}
            </button>
          )}
          {/* Native controls preserve keyboard activation and focus. */}
          {options.map(opt => excludedValue ? (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              aria-describedby={`${groupId}-${opt.value}-state`}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', width: '100%', minHeight: 44, padding: '0.35rem 0.4rem', border: 0, borderRadius: 'var(--radius-sm)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}
            >
              {value.includes(opt.value) ? <Check size={18} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--accent-green)' }} />
                : excludedValue.includes(opt.value) ? <X size={18} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--accent-red)' }} />
                  : <Square size={18} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--text-secondary)' }} />}
              {opt.label}
              <span id={`${groupId}-${opt.value}-state`} hidden>{value.includes(opt.value) ? t('filter.require') : excludedValue.includes(opt.value) ? t('filter.exclude') : allLabel}</span>
            </button>
          ) : (
            <label
              key={opt.value}
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.4rem', borderRadius: '5px', cursor: 'pointer', fontSize: '0.82rem' }}
            >
              <input
                type="checkbox"
                checked={value.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                style={{ width: '14px', height: '14px', flexShrink: 0, cursor: 'pointer', accentColor: 'var(--accent-red)' }}
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
