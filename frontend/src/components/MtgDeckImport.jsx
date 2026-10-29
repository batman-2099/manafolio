import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, List, Plus, Search } from 'lucide-react';
import { useT } from '../utils/i18n';
import { useReverseTokenPrompt } from '../utils/useReverseTokenPrompt';
import { reverseFace } from '../utils/tokenFaces';
import './DeckBuilder.css';

export default function MtgDeckImport({ onAddSuccess, showToast, onChoose, navigationGuardRef }) {
  const { t } = useT();
  const { requestReverse, reversePrompt } = useReverseTokenPrompt();
  const [query, setQuery] = useState('');
  const [decks, setDecks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [adding, setAdding] = useState(null);
  const [details, setDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(null);
  const [containerSelections, setContainerSelections] = useState({});
  const [deckSelections, setDeckSelections] = useState({});
  const [tokenEditions, setTokenEditions] = useState({});
  const importPending = useRef(false);
  const importTrigger = useRef(null);
  const mounted = useRef(true);
  const reviewChoices = useRef({ key: null, ids: {} });

  useEffect(() => {
    if (!adding) {
      importTrigger.current?.focus();
      importTrigger.current = null;
    }
  }, [adding]);

  useLayoutEffect(() => {
    mounted.current = true;
    const guard = () => {
      if (!importPending.current) return true;
      showToast?.(t('mtgDeck.adding'), 'status');
      return false;
    };
    const beforeUnload = event => {
      if (!importPending.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    if (navigationGuardRef) navigationGuardRef.current = guard;
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mounted.current = false;
      if (navigationGuardRef?.current === guard) navigationGuardRef.current = null;
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [navigationGuardRef, showToast, t]);

  const search = async (event) => {
    event?.preventDefault();
    if (importPending.current) return;
    const q = query.trim();
    setDecks([]);
    setSearched(false);
    if (q.length < 2) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/mtg-decks?q=${encodeURIComponent(q)}`);
      const body = await response.json().catch(() => []);
      if (!response.ok) return showToast?.(body.error || t('mtgDeck.errSearch'), 'error');
      setSearched(true);
      setDecks(body);
    } catch (error) {
      console.error(error);
      showToast?.(t('mtgDeck.errSearch'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const addDeck = async (deck, trigger) => {
    if (importPending.current || !window.confirm(t('mtgDeck.confirmAdd', { name: deck.name }))) return;
    importTrigger.current = trigger;
    importPending.current = true;
    setAdding(deck.fileName);
    try {
      const tokenEdition = tokenEditions[deck.fileName] || '';
      const key = `${deck.fileName}|${tokenEdition}`;
      if (reviewChoices.current.key !== key) reviewChoices.current = { key, ids: {} };
      const tokensResponse = await fetch(`/api/mtg-decks/${encodeURIComponent(deck.fileName)}/tokens?token_edition=${encodeURIComponent(tokenEdition)}`);
      const tokens = await tokensResponse.json();
      if (!mounted.current) return;
      if (!tokensResponse.ok) return showToast?.(tokens?.error || t('mtgDeck.errAdd'), 'error');
      const reverseCardIds = {};
      for (const card of tokens.cards) {
        if (reverseFace(card) || Object.hasOwn(reverseCardIds, card.id)) continue;
        if (!Object.hasOwn(reviewChoices.current.ids, card.id)) {
          const choice = await requestReverse(card);
          if (!choice || !mounted.current) {
            reviewChoices.current = { key: null, ids: {} };
            return;
          }
          reviewChoices.current.ids[card.id] = choice.reverseCard?.id || null;
        }
        reverseCardIds[card.id] = reviewChoices.current.ids[card.id];
      }
      const response = await fetch(`/api/mtg-decks/${encodeURIComponent(deck.fileName)}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          create_container: containerSelections[deck.fileName] ?? true,
          create_deck: deckSelections[deck.fileName] ?? true,
          token_edition: tokenEdition,
          ...(Object.keys(reverseCardIds).length ? { reverse_card_ids: reverseCardIds } : {}),
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) return showToast?.(body?.error || t('mtgDeck.errAdd'), 'error');
      reviewChoices.current = { key: null, ids: {} };
      showToast?.(t('mtgDeck.added', { count: body.added, name: deck.name }), 'success');
      onAddSuccess?.();
    } catch (error) {
      console.error(error);
      showToast?.(t('mtgDeck.errAdd'), 'error');
    } finally {
      importPending.current = false;
      setAdding(null);
    }
  };

  const showDetails = async (deck) => {
    if (importPending.current) return;
    if (details?.fileName === deck.fileName) return setDetails(null);
    setDetailsLoading(deck.fileName);
    try {
      const response = await fetch(`/api/mtg-decks/${encodeURIComponent(deck.fileName)}?token_edition=${encodeURIComponent(tokenEditions[deck.fileName] || '')}`);
      const body = await response.json().catch(() => null);
      if (!response.ok) return showToast?.(body?.error || t('mtgDeck.errDetails'), 'error');
      setDetails({ ...body, fileName: deck.fileName });
    } catch (error) {
      console.error(error);
      showToast?.(t('mtgDeck.errDetails'), 'error');
    } finally {
      setDetailsLoading(null);
    }
  };

  return (
    <div className="glass-panel mtg-deck-import">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}>
        <BookOpen size={20} style={{ color: 'var(--accent-yellow)' }} />
        <h2 style={{ fontSize: 'var(--text-lg)', margin: 0, color: 'var(--text-strong)' }}>{t('mtgDeck.title')}</h2>
      </div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-md)', lineHeight: 1.5, marginBottom: 'var(--space-4)' }}>{t(onChoose ? 'mtgDeck.chooseHint' : 'mtgDeck.hint')}</p>
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
        <input
          type="search"
          className="input-control"
          disabled={!!adding}
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
        <button type="button" className="btn btn-primary" onClick={search} disabled={!!adding || loading || query.trim().length < 2} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Search size={16} /> {loading ? t('common.loading') : t('mtgDeck.search')}
        </button>
      </div>
      {decks.length > 0 && (
        <div style={{ display: 'grid', gap: '0.6rem', marginTop: '1rem' }}>
          {decks.map(deck => {
            const detail = details?.fileName === deck.fileName ? details : null;
            return (
              <div key={deck.fileName} className="mtg-deck-import-result">
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                  <div>
                    <div style={{ color: 'var(--text-strong)', fontWeight: 600 }}>{deck.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.2rem' }}>{[deck.type, deck.code, deck.releaseDate].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                    <button type="button" className="btn btn-secondary" disabled={!!adding || detailsLoading === deck.fileName} onClick={() => showDetails(deck)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', whiteSpace: 'nowrap' }}>
                      <List size={15} /> {detailsLoading === deck.fileName ? t('common.loading') : detail ? t('mtgDeck.hideDetails') : t('mtgDeck.details')}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={!!adding} onClick={event => onChoose ? onChoose(deck) : addDeck(deck, event.currentTarget)} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', whiteSpace: 'nowrap' }}>
                      <Plus size={15} /> {onChoose ? t('mtgDeck.choose') : adding === deck.fileName ? t('mtgDeck.adding') : t('mtgDeck.add')}
                    </button>
                  </div>
                </div>
                {!onChoose && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={containerSelections[deck.fileName] ?? true} disabled={!!adding} onChange={event => setContainerSelections(current => ({ ...current, [deck.fileName]: event.target.checked }))} />
                    {t('mtgDeck.createContainer')}
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={deckSelections[deck.fileName] ?? true} disabled={!!adding} onChange={event => setDeckSelections(current => ({ ...current, [deck.fileName]: event.target.checked }))} />
                    {t('mtgDeck.createDeck')}
                  </label>
                  </div>
                )}
                {!onChoose && deck.token_editions?.length > 0 && (
                  <div style={{ marginTop: '0.75rem' }}>
                    <label>
                      {t('mtgDeck.tokenEdition')}
                      <select className="select-control" value={tokenEditions[deck.fileName] || ''} disabled={!!adding || detailsLoading === deck.fileName}
                        onChange={event => {
                          setTokenEditions(current => ({ ...current, [deck.fileName]: event.target.value }));
                          if (detail) setDetails(null);
                        }} style={{ width: '100%', marginTop: '0.35rem' }}>
                        <option value="">{t('mtgDeck.listedTokens')}</option>
                        {deck.token_editions.map(edition => <option key={edition.id} value={edition.id}>{edition.label}</option>)}
                      </select>
                    </label>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginTop: '0.4rem' }}>{t('mtgDeck.tokenEditionHint')}</p>
                  </div>
                )}
                {detail && (
                  <div className="mtg-deck-import-detail">
                    {[
                      ['creatures', t('mtgDeck.creatures')],
                      ['spells', t('mtgDeck.spells')],
                      ['lands', t('mtgDeck.lands')],
                      ['tokens', t('tokens.title')],
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
      {reversePrompt}
    </div>
  );
}
