export function filterOfflineCards(cards, { query = '', inventory = 'collection', color = '', finish = '', location = '' } = {}) {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter(card => {
    if (card.list_type !== inventory) return false;
    if (finish && card.printing !== finish) return false;
    if (location === 'unassigned' && card.location_id != null) return false;
    if (location && location !== 'unassigned' && String(card.location_id) !== location) return false;
    const colors = card.color_identity || [];
    if (color === 'C' ? colors.length !== 0 : color && !colors.includes(color)) return false;
    const text = [card.name, card.printed_name, card.set_name, card.set_id, card.number].filter(value => value != null).join(' ').toLocaleLowerCase();
    return tokens.every(token => text.includes(token));
  });
}
