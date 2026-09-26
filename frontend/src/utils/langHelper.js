import LORCANA_TRANSLATIONS from '../../../shared/lorcanaTranslations.json' with { type: 'json' };
import { langCode } from './languages.js';

export const translateLorcanaName = (englishName, language) => {
  if (!englishName) return '';
  const lang = langCode(language);
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
};

// The name to show for a card. A printed name from the provider always wins — it
// is what is actually on the card, in any language. Failing that, an entry marked
// non-English falls back to the dictionaries, and everything else shows the English name.
export const getCardDisplayName = (englishName, language, printedName, game) => {
  if (printedName) return printedName;
  if (!englishName) return '';
  const code = langCode(language);
  if (!code || code === 'en') return englishName;

  // Lorcana translation check
  if (game === 'lorcana' || englishName.includes(' - ') || (LORCANA_TRANSLATIONS.characters && LORCANA_TRANSLATIONS.characters[englishName])) {
    const translated = translateLorcanaName(englishName, language);
    if (translated !== englishName) return translated;
  }

  return englishName;
};

export { LORCANA_TRANSLATIONS };
