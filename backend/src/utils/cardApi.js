// Dispatch card IDs to the provider that owns them.
const scryfallApi = require('../scryfallApi');
const lorcastApi = require('../lorcastApi');
const languages = require('./languages');

const isMtgId = (id) => String(id || '').startsWith('mtg-');
const isLorcanaId = (id) => String(id || '').startsWith('lorcana-');

// The game an ID implies. `game` from the request wins when explicit; otherwise inferred from prefix.
function gameOf(id, requestedGame) {
  if (requestedGame === 'mtg' || isMtgId(id)) return 'mtg';
  if (requestedGame === 'lorcana' || isLorcanaId(id)) return 'lorcana';
  return null;
}

// Fetch a card from whichever provider minted its ID. Returns null when that
// provider does not have it.
async function getCardById(id, { game } = {}) {
  const g = gameOf(id, game);
  if (g === 'mtg') return await scryfallApi.getCardById(id);
  if (g === 'lorcana') return await lorcastApi.getCardById(id);
  return null;
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
  if (languages.toName(card.language) === languages.toName(language)) return null;
  const g = gameOf(card.id, card.game);
  if (g === 'mtg') {
    const set = String(card.set_id || '').replace(/^mtg-/, '');
    return await scryfallApi.getPrintingInLang(set, card.number, language).catch(() => null);
  }
  if (g === 'lorcana') {
    const { translateLorcanaName } = require('./lorcanaHelper');
    const targetName = languages.toName(language);
    const translated = translateLorcanaName(card.name, language);
    return {
      ...card,
      language: targetName,
      printed_name: translated,
    };
  }
  return null;
}

module.exports = { isMtgId, isLorcanaId, gameOf, getCardById, printingInLanguage };
