import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import Logo from './Logo';
import CardImage from './CardImage';
import Modal from './Modal';
import { displayName } from '../utils/languages';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';
import { buildDeckExport } from '../utils/deckText';
import { downloadBlob } from '../utils/downloadBlob';
import './DeckBuilder.css';

const MANA_SYMBOLS = [
  ['W', 'White', -475], ['U', 'Blue', -370], ['B', 'Black', -265],
  ['R', 'Red', -160], ['G', 'Green', -55],
];

export default function SharedDeck({ shareToken }) {
  const { t, locale } = useT();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [preview, setPreview] = useState(null);
  useBackGuard(!!preview, () => setPreview(null));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    setPreview(null);
    const load = async () => {
      try {
        const response = await fetch(`/api/shared/decks/${encodeURIComponent(shareToken)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 404 ? 'missing' : 'load');
        const result = await response.json();
        if (!controller.signal.aborted) setData(result);
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message === 'missing' ? 'sharedDeck.missing' : 'sharedDeck.loadError');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    load();
    return () => controller.abort();
  }, [shareToken, retry]);

  useEffect(() => {
    const previous = document.title;
    document.title = data ? `${data.deck.name} · Manafolio` : `${t('sharedDeck.title')} · Manafolio`;
    return () => { document.title = previous; };
  }, [data, t]);

  const printing = card => [card.set_name || card.set_id, card.number != null && card.number !== '' ? `#${card.number}` : null].filter(Boolean).join(' · ');
  const commander = data?.cards.find(card => card.id === data.deck.commander_card_id);
  const colors = MANA_SYMBOLS.filter(([symbol, name]) => commander?.color_identity?.some(color => color === symbol || color === name));

  return (
    <main className="app-container shared-deck">
      <header className="shared-deck-header">
        <a href="/" className="shared-deck-brand"><Logo style={{ width: 34, height: 34, flexShrink: 0 }} /><span>Manafolio</span></a>
        {data && <p>{t('shared.sharedBy')} <strong>{data.owner}</strong></p>}
      </header>
      {loading ? (
        <section className="glass-panel shared-deck-state" role="status">
          <div className="spinner" aria-hidden="true" />
          <p>{t('sharedDeck.loading')}</p>
        </section>
      ) : error ? (
        <section className="glass-panel shared-deck-state" role="alert">
          <h1>{t('sharedDeck.unavailable')}</h1>
          <p>{t(error)}</p>
          <button className="btn btn-secondary" onClick={() => setRetry(value => value + 1)}>{t('deck.shareRetry')}</button>
          <a href="/">{t('shared.goToManafolio')}</a>
        </section>
      ) : data && (
        <>
          <section className="glass-panel shared-deck-overview" aria-labelledby="shared-deck-title">
            <h1 id="shared-deck-title">{data.deck.name}</h1>
            <p>{t('sharedDeck.readOnly')}</p>
            <dl className="shared-deck-metadata">
              {data.deck.format && <div><dt>{t('deck.format')}</dt><dd>{data.deck.format}</dd></div>}
              {data.deck.category && <div><dt>{t('deck.category')}</dt><dd>{data.deck.category}</dd></div>}
              {commander && <div>
                <dt>{t('filter.field.color_identity')}</dt>
                <dd className="shared-deck-colors">
                  {colors.length ? colors.map(([symbol, name, x]) => (
                    <span key={symbol} title={t(`dash.color.${name}`)}>
                      <svg role="img" aria-label={t(`dash.color.${name}`)} width="20" height="20" viewBox={`${x - 50} 0 100 100`}>
                        <image href={`${import.meta.env.BASE_URL}mana.svg`} x="-945" y="-210.002" width="1045" height="730.002" />
                      </svg>
                    </span>
                  )) : <span title={t('dash.color.Colorless')}>
                    <svg role="img" aria-label={t('dash.color.Colorless')} width="20" height="20" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="50" fill="#CAC5C0" />
                      <path fill="#0D0F0F" fillRule="evenodd" d="M50 10 90 50 50 90 10 50Z M50 30 30 50 50 70 70 50Z" />
                    </svg>
                  </span>}
                </dd>
              </div>}
              <div><dt>{t('sharedDeck.cards')}</dt><dd>{data.cards.reduce((sum, card) => sum + card.quantity, 0).toLocaleString(locale)}</dd></div>
              <div><dt>{t('deck.wins')}</dt><dd>{Number(data.deck.wins ?? 0).toLocaleString(locale)}</dd></div>
              <div><dt>{t('deck.losses')}</dt><dd>{Number(data.deck.losses ?? 0).toLocaleString(locale)}</dd></div>
            </dl>
            {data.deck.description && <div className="shared-deck-description"><h2>{t('deck.description')}</h2><p>{data.deck.description}</p></div>}
            <div>
              <button className="btn btn-secondary" disabled={!data.cards.length} onClick={() => downloadBlob(
                new Blob([buildDeckExport(data.cards)], { type: 'text/plain;charset=utf-8' }),
                `${data.deck.name.replace(/[<>:"/\\|?*]/g, '_') || 'deck'}.txt`
              )}>{t('sharedDeck.exportTxt')}</button>
            </div>
          </section>
          {commander && (
            <section aria-labelledby="shared-deck-commander-title">
              <h2 id="shared-deck-commander-title">{t('deck.commander')}</h2>
              <CardImage className="shared-deck-commander-image" card={commander} alt={`${t('deck.commander')}: ${displayName(commander)}`} />
            </section>
          )}
          <section aria-labelledby="shared-deck-cards-title">
            <h2 id="shared-deck-cards-title">{t('sharedDeck.cards')}</h2>
            <p className="shared-deck-card-hint">{t('sharedDeck.previewHint')}</p>
            {data.cards.length === 0 ? <p>{t('sharedDeck.empty')}</p> : (
              <ul className="shared-deck-cards">
                {data.cards.map(card => (
                  <li key={card.id}>
                    <button className="shared-deck-card" onClick={event => setPreview({ card, trigger: event.currentTarget })} aria-label={`${t('sharedDeck.previewCard', { name: displayName(card), quantity: card.quantity, printing: printing(card) })}${card.id === data.deck.commander_card_id ? ` · ${t('deck.commander')}` : ''}`}>
                      <CardImage card={card} alt="" loading="lazy" />
                      <span className="shared-deck-card-name"><strong>{card.quantity} × {displayName(card)}</strong></span>
                      <span>{printing(card)}</span>
                      {card.id === data.deck.commander_card_id && <strong className="shared-deck-commander">{t('deck.commander')}</strong>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      {preview && (
        <Modal onClose={() => setPreview(null)} returnFocus={preview.trigger} aria-labelledby="shared-deck-preview-title">
          <div className="glass-panel shared-deck-preview">
            <div className="deck-share-heading">
              <h2 id="shared-deck-preview-title">{displayName(preview.card)}</h2>
              <button className="btn btn-secondary btn-icon-only" aria-label={t('common.close')} onClick={() => setPreview(null)}><X size={18} aria-hidden="true" /></button>
            </div>
            <CardImage card={preview.card} alt={displayName(preview.card)} />
            <p>{preview.card.quantity} × {printing(preview.card)}</p>
            {preview.card.id === data.deck.commander_card_id && <p className="shared-deck-commander">{t('deck.commander')}</p>}
          </div>
        </Modal>
      )}
    </main>
  );
}
