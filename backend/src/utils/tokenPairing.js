const db = require('../db');

function assertTokenPair(front, reverse, listType) {
  const isToken = card => card?.game === 'mtg' && /\bToken\b/.test(
    [card.supertype, card.subtypes, card.type_line].join(' '));
  if (listType === 'arena' || !isToken(front) || !isToken(reverse) || front.id === reverse.id) {
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

module.exports = { assertTokenPair, validateReverseCard };
