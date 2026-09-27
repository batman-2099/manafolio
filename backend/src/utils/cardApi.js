// Validate card identities before calling Scryfall.
const scryfallApi = require('../scryfallApi');
const languages = require('./languages');

const isMtgId = (id) => typeof id === 'string' && id.startsWith('mtg-');

function gameOf(id, requestedGame) {
  if (!isMtgId(id) || (requestedGame !== undefined && requestedGame !== 'mtg')) {
    throw Object.assign(new Error('Unsupported card ID or game'), { status: 400 });
  }
  return 'mtg';
}

// Returns null when Scryfall does not have the requested Magic card.
async function getCardById(id, { game } = {}) {
  gameOf(id, game);
  return scryfallApi.getCardById(id);
}

// The same card as printed in `language`, or null when there is no such printing.
//
// A copy's language is not always the printing that was picked. Quick Add lets the
// language be changed after a card is chosen, and a camera scan is answered by
// whichever catalog exists (English, on most installs) whatever language is being
// scanned. Both leave the collection row pointing at the ENGLISH printing, so a card
// filed as Japanese still shows its English name everywhere: printed_name belongs to
// the printing, not to the copy.
//
// Null means keep the card you had when no printing exists in the requested language.
async function printingInLanguage(card, language) {
  if (!card) return null;
  if (card.game !== 'mtg') {
    throw Object.assign(new Error('Unsupported card ID or game'), { status: 400 });
  }
  if (languages.toName(card.language) === languages.toName(language)) return null;
  const set = String(card.set_id || '').replace(/^mtg-/, '');
  return scryfallApi.getPrintingInLang(set, card.number, language).catch(() => null);
}

module.exports = { isMtgId, gameOf, getCardById, printingInLanguage };
