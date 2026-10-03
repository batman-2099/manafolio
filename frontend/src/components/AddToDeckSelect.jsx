import { useState, useEffect } from 'react';
import { useT } from '../utils/i18n';

// Deck picker that adds card(s) to the chosen deck. Owns the deck fetch so the
// places that offer "Add to Deck" (card popup, collection bulk toolbar) don't
// each re-implement the fetch + select. onAdd(deckId) performs the actual add.
// Renders nothing when the user has no decks.
export default function AddToDeckSelect({
  onAdd,
  disabled = false,
  placeholder,
  className = 'select-control',
  style,
}) {
  const { t } = useT();
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch('/api/decks')
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(items => {
        if (!cancelled) setDecks(items.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })));
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [version]);

  if (!loading && !error && decks.length === 0) return null;

  return (
    <div>
    <select
      className={className}
      aria-label={placeholder ?? t('deck.addToDeck')}
      value=""
      disabled={disabled || loading || error}
      onChange={(e) => { if (e.target.value) onAdd(e.target.value); e.target.value = ''; }}
      style={style}
    >
      <option value="">{loading ? t('common.loading') : (placeholder ?? t('deck.addToDeck'))}</option>
      {decks.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
      {loading && <span role="status">{t('common.loading')}</span>}
      {error && <div role="alert">
        <p>{t('inspector.errDecks')}</p>
        <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => setVersion(value => value + 1)}>{t('common.retry')}</button>
      </div>}
    </div>
  );
}
