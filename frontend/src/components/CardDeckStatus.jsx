import { Layers } from 'lucide-react';
import { useT } from '../utils/i18n';

export default function CardDeckStatus({ card, compact = false, details = false, id }) {
  const { t } = useT();
  const entries = card.stack_entries || [card];
  const count = entries.reduce((sum, entry) => sum + (entry.in_deck_qty || 0), 0);
  if (!count) return null;

  const checkedOut = entries.reduce((sum, entry) => sum + (entry.checked_out_qty || 0), 0);
  const total = card.quantity ?? 1;
  const singleCheckedOut = total === 1 && count === 1 && checkedOut === 1;
  const decks = new Map();
  for (const entry of entries) {
    for (const allocation of entry.deck_allocations || []) {
      const key = `${allocation.deck_id}:${allocation.checked_out}`;
      const existing = decks.get(key);
      if (existing) existing.quantity += allocation.quantity;
      else decks.set(key, { ...allocation });
    }
  }
  const allocations = [...decks.values()];
  const summary = t(singleCheckedOut ? 'deck.inPlay' : checkedOut === count ? 'cardDeck.checkedOut' : 'cardDeck.inDecks', { count, total });
  const labels = allocations.map(allocation => t('cardDeck.allocation', {
    name: allocation.name, count: allocation.quantity,
    status: t(allocation.checked_out ? 'deck.inPlay' : 'deck.pulled'),
  }));
  const description = [summary, ...labels].join('. ');

  return (
    <span id={id} className={`card-deck-status${compact ? ' card-deck-status--compact' : ''}${count >= total ? ' card-deck-status--all-out' : ''}`}
      aria-label={compact ? description : undefined} title={compact ? description : undefined}>
      <span className="card-deck-status-summary">
        <Layers size={compact ? 12 : 14} aria-hidden="true" />
        <span>{compact && !singleCheckedOut ? t('cardDeck.outCompact', { count, total }) : summary}</span>
      </span>
      {!compact && details && (
        <span className="card-deck-status-decks" role="list">
          {labels.map((label, index) => <span role="listitem" key={`${allocations[index].deck_id}:${allocations[index].checked_out}`}>{label}</span>)}
        </span>
      )}
    </span>
  );
}
