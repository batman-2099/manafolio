import { getCardDisplayName } from './langHelper.js';

export function isMtgToken(card) {
  return (card?.game === 'mtg' || card?.supertype === 'MTG') && (card.subtypes || []).includes('Token');
}

export function pairedCardName(card) {
  const front = getCardDisplayName(card.name, card.printed_name);
  return card.reverse_card_id ? `${front} // ${getCardDisplayName(card.reverse_name || card.reverse_card_id, card.reverse_printed_name)}` : front;
}

export function reverseFace(card) {
  if (card?.reverse_card_id) return { id: card.reverse_card_id, name: card.reverse_name, printed_name: card.reverse_printed_name, image_url: card.reverse_image_url, set_name: card.reverse_set_name, number: card.reverse_number, game: card.game };
  const faces = card?.card_faces;
  const back = Array.isArray(faces) ? faces[1] : null;
  const image = card?.image_url_back || back?.image_uris?.normal || back?.image_url;
  return image ? { name: back?.name || card.name, image_url: image, game: card.game } : null;
}
