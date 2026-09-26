import { useEffect, useId, useState } from 'react';
import CardImage from './CardImage';
import { getSlotNumber } from '../utils/getSlotNumber';
import { useT } from '../utils/i18n';

const MTG_CARD_ID = /^mtg-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function RelatedTokens({ cardIds = [], title, inventoryType = 'collection', commanderCardId }) {
  const { t } = useT();
  const headingId = useId();
  const idsKey = [...new Set((Array.isArray(cardIds) ? cardIds : [])
    .filter(id => typeof id === 'string' && MTG_CARD_ID.test(id))
    .map(id => id.toLowerCase()))].sort().join(',');
  const resultKey = `${inventoryType}:${commanderCardId || ''}:${idsKey}`;
  const [result, setResult] = useState({ key: '', status: 'loading', tokens: [] });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!idsKey) return;
    const controller = new AbortController();
    setResult({ key: resultKey, status: 'loading', tokens: [] });
    async function load() {
      try {
        const response = await fetch('/api/cards/related-tokens', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            card_ids: idsKey.split(','),
            inventory_type: inventoryType,
            ...(commanderCardId ? { commander_card_id: commanderCardId } : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Token lookup failed');
        const data = await response.json();
        if (!Array.isArray(data.tokens)) throw new Error('Invalid token response');
        if (!controller.signal.aborted) {
          setResult({ key: resultKey, status: 'ready', tokens: data.tokens });
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult({ key: resultKey, status: 'error', tokens: [] });
        }
      }
    }
    load();
    return () => controller.abort();
  }, [idsKey, inventoryType, commanderCardId, resultKey, attempt]);

  if (!idsKey) return null;
  const status = result.key === resultKey ? result.status : 'loading';

  return (
    <section aria-labelledby={headingId} style={{ minWidth: 0, borderTop: '1px solid var(--border-glass)', paddingTop: '1rem' }}>
      <h3 id={headingId} style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>{title ?? t('relatedTokens.title')}</h3>
      {status === 'loading' && <p role="status">{t('relatedTokens.loading')}</p>}
      {status === 'error' && (
        <div>
          <p role="alert" style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('relatedTokens.error')}</p>
          <button type="button" className="btn btn-secondary" onClick={() => setAttempt(value => value + 1)}>{t('relatedTokens.retry')}</button>
        </div>
      )}
      {status === 'ready' && (result.tokens.length === 0 ? (
        <p role="status" style={{ color: 'var(--text-muted)' }}>{t('relatedTokens.empty')}</p>
      ) : (
        <ul className="card-grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {result.tokens.map(token => (
            <li key={token.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', minWidth: 0, background: 'var(--surface-1)', border: '1px solid var(--border-glass)', borderRadius: 'var(--radius-sm)', padding: '0.5rem', overflowWrap: 'anywhere' }}>
              <CardImage card={{ ...token, id: token.matched_card_id || token.id }} game="mtg" loading="lazy" style={{ width: '100%', aspectRatio: '5 / 7', objectFit: 'contain', borderRadius: 'var(--radius-sm)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{token.name}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                  {t(inventoryType === 'arena'
                    ? token.owned ? 'relatedTokens.ownedArena' : 'relatedTokens.notOwnedArena'
                    : token.owned ? 'relatedTokens.owned' : 'relatedTokens.notOwned')}
                </span>
              </div>
              {token.owned && inventoryType === 'collection' && (
                <ul style={{ listStyle: 'none', margin: '0.25rem 0 0', padding: 0, color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  {token.locations.map((location, index) => {
                    const slot = getSlotNumber(location);
                    return (
                      <li key={index}>
                        {location.location_name
                          ? `${location.location_name}${location.compartment_display ? ` • ${location.compartment_display}` : ''}${slot !== null ? ` • ${t('wizard.slot', { slot })}` : ''}`
                          : t('bulk.unassignedPile')}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {t('relatedTokens.createdBy')}
                {[...new Set(token.source_cards.map(source => source.name))].map(name => (
                  <span key={name} style={{ display: 'block' }}>{name}</span>
                ))}
              </p>
              </div>
            </li>
          ))}
        </ul>
      ))}
    </section>
  );
}
