import { displayName } from './languages';

export function deckCardMovePrompt(deck, before, afterCards, cardDetails = []) {
  if (!deck?.container_id || !deck.container_name || !before
    || !['collection', 'graveyard'].includes(deck.inventory_type)
    || before.inventory_type !== deck.inventory_type) return null;
  const counts = cards => new Map(cards.map(card => [card.card_id ?? card.id, Number(card.quantity)]));
  const previous = counts(before.cards);
  const next = counts(afterCards);
  const names = new Map([...cardDetails, ...before.cards, ...afterCards]
    .filter(card => card.name).map(card => [card.card_id ?? card.id, displayName(card)]));
  const added = [];
  const removed = [];
  for (const card_id of new Set([...previous.keys(), ...next.keys()])) {
    const delta = (next.get(card_id) || 0) - (previous.get(card_id) || 0);
    if (delta) (delta > 0 ? added : removed).push({ card_id, name: names.get(card_id) || card_id, quantity: Math.abs(delta) });
  }
  if (!added.length && !removed.length) return null;
  return {
    container_id: deck.container_id, container_name: deck.container_name,
    inventory_type: deck.inventory_type, game: deck.game,
    before_cards: [...previous].map(([card_id, quantity]) => ({ card_id, quantity })),
    added, removed,
  };
}
