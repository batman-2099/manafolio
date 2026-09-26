const LORCANA_TRANSLATIONS = require('../../../shared/lorcanaTranslations.json');
const { toCode } = require('./languages');

/**
 * Translate a Disney Lorcana card name into the requested target language.
 * @param {string} englishName - Card title, e.g. "Tyler Nguyen-Baker - 4*Town Fan" or "Elsa - Snow Queen"
 * @param {string} language - Target language name or code, e.g. "French" or "fr"
 * @returns {string} Localized name
 */
function translateLorcanaName(englishName, language) {
  if (!englishName) return '';
  const lang = toCode(language);
  if (!lang || lang === 'en') return englishName;

  const { characters = {}, versions = {} } = LORCANA_TRANSLATIONS;

  const sep = englishName.includes(' - ') ? ' - ' : (englishName.includes(' – ') ? ' – ' : null);
  if (sep) {
    const parts = englishName.split(sep);
    const charPart = parts[0].trim();
    const verPart = parts.slice(1).join(sep).trim();

    const charTrans = characters[charPart]?.[lang] || charPart;
    const verTrans = versions[verPart]?.[lang] || verPart;

    return `${charTrans} - ${verTrans}`;
  }

  if (characters[englishName]?.[lang]) return characters[englishName][lang];
  if (versions[englishName]?.[lang]) return versions[englishName][lang];

  return englishName;
}

module.exports = {
  translateLorcanaName,
  LORCANA_TRANSLATIONS
};
