import { buildDeckExport } from './deckText.js';

export function buildCollectionExport(cards, format) {
  if (format === 'txt') return buildDeckExport(cards, 'mtga');
  const rows = [
    ['Card ID', 'Name', 'Set Name', 'Set ID', 'Card Number', 'Quantity', 'Condition', 'Printing', 'Language', 'Purchase Price'],
    ...cards.map(card => [card.card_id, card.name, card.set_name, card.set_id, card.number, card.quantity, card.condition, card.printing, card.language, card.purchase_price]),
  ];
  return rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
}
