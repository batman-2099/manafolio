// Canonical card languages shared by the frontend and backend.
const LANGUAGES = require('../../../shared/languages.json');

const DEFAULT = LANGUAGES[0];

const byCode = new Map(LANGUAGES.map(l => [l.code, l]));
const byName = new Map(LANGUAGES.map(l => [l.name.toLowerCase(), l]));
// Provider codes resolve back too, so a stored 'zht' or a legacy caller passing
// Scryfall's own spelling still lands on the right language.
const byProvider = new Map(LANGUAGES.map(l => [l.scryfall, l]));

// Resolve anything that might name a language — canonical code, display name, or
// a provider's own code — to one entry. Unknown input falls back to English
// rather than throwing: a bad `lang` query param should degrade, not 500.
function resolve(input) {
  if (!input) return DEFAULT;
  const raw = String(input).trim();
  const lower = raw.toLowerCase();
  return byCode.get(lower) || byName.get(lower) || byProvider.get(lower) || DEFAULT;
}

// Canonical code ('ja'). Used for cache ids, index filenames and API params.
const toCode = (input) => resolve(input).code;

// Display name ('Japanese'). This is what goes in collection.language.
const toName = (input) => resolve(input).name;

// Unknown or empty inputs resolve to English.
const isEnglish = (input) => resolve(input).code === 'en';

// Which languages a game is printed in. Default/fallback is all languages.
function getLanguagesForGame(game) {
  if (!game) return LANGUAGES;
  const g = String(game).toLowerCase();
  return LANGUAGES.filter(l => !l.games || l.games.includes(g));
}

const getLanguageNamesForGame = (game) => getLanguagesForGame(game).map(l => l.name);

const isLanguageSupported = (game, lang) => {
  if (!game || !lang) return true;
  const code = toCode(lang);
  return getLanguagesForGame(game).some(l => l.code === code);
};

module.exports = {
  LANGUAGES, DEFAULT, resolve, toCode, toName, isEnglish,
  getLanguagesForGame, getLanguageNamesForGame, isLanguageSupported,
};
