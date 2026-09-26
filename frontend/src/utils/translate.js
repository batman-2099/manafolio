// The pure half of the UI translation in i18n.jsx: no React, no DOM, so it can be
// unit-checked with plain node (see translate.test.js).

const PLURAL_SUFFIX = /\.(zero|one|two|few|many|other)$/;

// A counted phrase is stored as siblings ("collection.cardUnit.one",
// ".other", ...) and the locale's own rules pick one, so no `n === 1` anywhere.
// Which categories exist differs per language: Japanese needs one, Russian four.
const lookup = (dict, key, vars, locale) => {
  if (dict && vars && typeof vars.count === 'number') {
    const cat = new Intl.PluralRules(locale).select(vars.count);
    const plural = dict[`${key}.${cat}`] ?? dict[`${key}.other`];
    if (plural != null) return plural;
  }
  return dict ? dict[key] : undefined;
};

// Falls back key by key, not file by file: a translation that covers twenty
// strings is useful immediately, the rest stay English until somebody fills them.
// Numbers are locale-formatted, so pass a string for digits that must stay
// verbatim (set codes, card numbers).
export const translate = (dict, fallback, locale, key, vars) => {
  const raw = lookup(dict, key, vars, locale) ?? lookup(fallback, key, vars, locale) ?? key;
  if (!vars) return raw;
  return String(raw).replace(/\{(\w+)\}/g, (whole, name) => {
    const v = vars[name];
    if (v == null) return whole;
    return typeof v === 'number' ? new Intl.NumberFormat(locale).format(v) : String(v);
  });
};

// First of the browser's preferred languages we actually ship. The full tag wins
// over the bare language, so a pt-BR reader gets pt-BR.json when it exists and
// pt.json when it does not.
export const pickLocale = (available, preferred) => {
  for (const tag of preferred) {
    const lower = String(tag).toLowerCase();
    const hit = available.find(l => l.toLowerCase() === lower)
      || available.find(l => l.toLowerCase() === lower.split('-')[0]);
    if (hit) return hit;
  }
  return 'en';
};

export { PLURAL_SUFFIX };
