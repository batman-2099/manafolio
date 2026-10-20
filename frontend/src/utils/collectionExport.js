import { buildDeckExport } from './deckText.js';

export function buildCollectionExport(cards, format) {
  if (format === 'txt') {
    const totals = new Map();
    for (const card of cards) {
      const key = JSON.stringify([card.name, card.set_id, card.number, card.reverse_card_id || null]);
      const held = totals.get(key);
      if (held) held.quantity += card.quantity ?? 1;
      else totals.set(key, { ...card, quantity: card.quantity ?? 1 });
    }
    return buildDeckExport([...totals.values()], 'mtga');
  }
  const rows = [
    ['Card ID', 'Name', 'Set Name', 'Set ID', 'Card Number', 'Quantity', 'Condition', 'Printing', 'Language', 'Purchase Price', 'Reverse Card ID'],
    ...cards.map(card => [card.card_id, card.name, card.set_name, card.set_id, card.number, card.quantity, card.condition, card.printing, card.language, card.purchase_price, card.reverse_card_id]),
  ];
  return rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
