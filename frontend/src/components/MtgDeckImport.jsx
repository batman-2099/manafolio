import { useState } from 'react';
import { BookOpen, List, Plus, Search } from 'lucide-react';
import { useT } from '../utils/i18n';

export default function MtgDeckImport({ onAddSuccess, showToast, onChoose }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [adding, setAdding] = useState(null);
  const [details, setDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(null);
  const [containerSelections, setContainerSelections] = useState({});
  const [deckSelections, setDeckSelections] = useState({});

  const search = async (event) => {
    event?.preventDefault();
    const q = query.trim();
    setDecks([]);
    setSearched(false);
    if (q.length < 2) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/mtg-decks?q=${encodeURIComponent(q)}`);
      const body = await response.json().catch(() => []);
      if (!response.ok) return showToast?.(body.error || t('mtgDeck.errSearch'));
      setSearched(true);
      setDecks(body);
    } catch (error) {
      console.error(error);
      showToast?.(t('mtgDeck.errSearch'));
    } finally {
      setLoading(false);
    }
  };

  const addDeck = async (deck) => {
    if (!window.confirm(t('mtgDeck.confirmAdd', { name: deck.name }))) return;
    setAdding(deck.fileName);
    try {
      const response = await fetch(`/api/mtg-decks/${encodeURIComponent(deck.fileName)}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ create_container: containerSelections[deck.fileName] ?? true, create_deck: deckSelections[deck.fileName] ?? true }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return showToast?.(body?.error || t('mtgDeck.errAdd'));
      showToast?.(t('mtgDeck.added', { count: body.added, name: deck.name }));
      onAddSuccess?.();
    } catch (error) {
      console.error(error);
      showToast?.(t('mtgDeck.errAdd'));
    } finally {
      setAdding(null);
    }
  };

  const showDetails = async (deck) => {
    if (details?.fileName === deck.fileName) return setDetails(null);
    setDetailsLoading(deck.fileName);
    try {
      const response = await fetch(`/api/mtg-decks/${encodeURIComponent(deck.fileName)}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) return showToast?.(body?.error || t('mtgDeck.errDetails'));
      setDetails({ ...body, fileName: deck.fileName });
    } catch (error) {
      console.error(error);
      showToast?.(t('mtgDeck.errDetails'));
    } finally {
      setDetailsLoading(null);
    }
  };

  return (
    <div className="glass-panel" style={{ maxWidth: '720px', margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
        <BookOpen size={20} style={{ color: 'var(--accent-yellow)' }} />
        <h2 style={{ fontSize: '1.15rem', margin: 0, color: 'var(--text-strong)' }}>{t('mtgDeck.title')}</h2>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', lineHeight: 1.5, marginBottom: '1rem' }}>{t('mtgDeck.hint')}</p>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <input
          type="search"
          className="input-control"
          value={query}
          onChange={event => { setQuery(event.target.value); setSearched(false); }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              search();
            }
          }}
          placeholder={t('mtgDeck.placeholder')}
          style={{ flex: 1, minWidth: '180px' }}
        />
        <button type="button" className="btn btn-primary" onClick={search} disabled={loading || query.trim().length < 2} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Search size={16} /> {loading ? t('common.loading') : t('mtgDeck.search')}
        </button>
      </div>
      {decks.length > 0 && (
        <div style={{ display: 'grid', gap: '0.6rem', marginTop: '1rem' }}>
          {decks.map(deck => {
            const detail = details?.fileName === deck.fileName ? details : null;
            return (
              <div key={deck.fileName} style={{ padding: '0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-tertiary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                  <div>
                    <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{deck.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.2rem' }}>{[deck.type, deck.code, deck.releaseDate].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <button type="button" className="btn btn-primary" disabled={detailsLoading === deck.fileName} onClick={() => showDetails(deck)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', whiteSpace: 'nowrap' }}>
                      <List size={15} /> {detailsLoading === deck.fileName ? t('common.loading') : detail ? t('mtgDeck.hideDetails') : t('mtgDeck.details')}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={adding === deck.fileName} onClick={() => onChoose ? onChoose(deck) : addDeck(deck)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', whiteSpace: 'nowrap' }}>
                      <Plus size={15} /> {adding === deck.fileName ? t('mtgDeck.adding') : t('mtgDeck.add')}
                    </button>
                  </div>
                </div>
                {!onChoose && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={containerSelections[deck.fileName] ?? true} disabled={adding === deck.fileName} onChange={event => setContainerSelections(current => ({ ...current, [deck.fileName]: event.target.checked }))} />
                    {t('mtgDeck.createContainer')}
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={deckSelections[deck.fileName] ?? true} disabled={adding === deck.fileName} onChange={event => setDeckSelections(current => ({ ...current, [deck.fileName]: event.target.checked }))} />
                    {t('mtgDeck.createDeck')}
                  </label>
                  </div>
                )}
                {detail && (
                  <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border-glass)' }}>
                    {[
                      ['creatures', t('mtgDeck.creatures')],
                      ['spells', t('mtgDeck.spells')],
                      ['lands', t('mtgDeck.lands')],
                    ].filter(([key]) => detail[key]?.length).map(([key, title]) => (
                      <section key={key}>
                        <h3 style={{ margin: '0 0 0.35rem', color: 'var(--text-strong)', fontSize: '0.82rem' }}>{title}</h3>
                        <div style={{ display: 'grid', gap: '0.2rem', color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
                          {detail[key].map(card => <div key={`${card.name}|${card.setCode}|${card.number}`}>{card.count}× {card.name}</div>)}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {searched && !loading && decks.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '1rem' }}>{t('mtgDeck.noResults')}</p>}
      <a href="https://mtg.wtf/deck" target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: '1rem', color: 'var(--accent-yellow)', fontSize: '0.82rem' }}>
        mtg.wtf/deck
      </a>
    </div>
  );
}
