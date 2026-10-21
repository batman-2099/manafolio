const db = require('../db');

function isMtgToken(card) {
  return card?.game === 'mtg' && (/\bToken\b/.test(
    [card.supertype, card.subtypes, card.type_line].join(' ')) || /\btokens?\b/i.test(card.set_name));
}

function assertTokenPair(front, reverse, listType) {
  if (listType === 'arena' || !isMtgToken(front) || !isMtgToken(reverse) || front.id === reverse.id) {
    throw Object.assign(new Error('Reverse faces require two distinct Magic tokens outside Arena'), { status: 400 });
  }
}

async function validateReverseCard(front, reverseId, listType = 'collection') {
  if (reverseId == null) return null;
  if (typeof reverseId !== 'string' || !reverseId.trim()) {
    throw Object.assign(new Error('Invalid reverse_card_id'), { status: 400 });
  }
  const reverse = await db.get('SELECT * FROM card_cache WHERE id = ?', [reverseId]);
  assertTokenPair(front, reverse, listType);
  return reverseId;
}

module.exports = { isMtgToken, assertTokenPair, validateReverseCard };
