# Translating Manafolio

Help Magic collectors manage their collections, storage, and decks in their own language. Manafolio keeps interface translations in plain JSON files under [`frontend/src/locales/`](../frontend/src/locales); you can contribute by editing a file and opening a pull request. No translation-service account or specialist tooling is required.

English is the source dictionary. Missing translations fall back to English key by key, so partial contributions are useful. Interface language is separate from a card's printed language: translating a button does not change the language or identity of anyone's cards.

## Add or update a language

1. Check the [locale directory](../frontend/src/locales) first. Update an existing file if your language is already present.
2. For a new language, copy [`en.json`](../frontend/src/locales/en.json) and name the copy with a [BCP-47 language tag](https://www.w3.org/International/articles/language-tags/), such as `de.json`, `ja.json`, `pt-BR.json`, or `zh-Hant.json`. Use a regional/script variant when it represents a meaningful distinction that contributors can maintain.
3. Translate string values, not key names. Keep the existing key order where practical to make review easier. For a partial translation, omit untranslated keys instead of copying their English values; omitted keys automatically track future English changes.
4. Preserve placeholders and complete any plural groups you translate, as described below. Keep the file valid JSON: double-quoted keys and strings, no comments, and no trailing commas.
5. Open a pull request in the [Manafolio repository](https://github.com/batman-2099/manafolio). Describe the language and any terminology or layout questions.

Locale files are discovered automatically at build time. No import or language registry needs editing. After a build containing the file is deployed, the language appears under **Settings → Preferences**.

For example, this is a valid partial German dictionary:

```json
{
  "nav.collection": "Sammlung"
}
```

## Translation rules

### Preserve placeholders

Keep every `{placeholder}` exactly as written. You may move it to suit the sentence, but must not rename it, remove it, or invent another one.

English:

```json
{
  "toast.welcomeBack": "Welcome back, {name}!"
}
```

German:

```json
{
  "toast.welcomeBack": "Willkommen zurück, {name}!"
}
```

The app inserts the runtime value. Numeric values are locale-formatted; string values are inserted as supplied. Placeholders may represent names, sets, themes, or literal code. Do not translate what the placeholder stands for, and preserve literal commands, URLs, and identifiers in a source string unless a change is explicitly intended.

### Complete plural groups

Counted phrases use suffixes such as `.one`, `.few`, `.many`, and `.other`. The required categories come from JavaScript's `Intl.PluralRules` for the locale, based on [Unicode plural rules](https://www.unicode.org/cldr/charts/47/supplemental/language_plural_rules.html), not from English grammar.

English uses:

```json
{
  "collection.cardUnit.one": "card",
  "collection.cardUnit.other": "cards"
}
```

Russian needs four categories:

```json
{
  "collection.cardUnit.one": "карта",
  "collection.cardUnit.few": "карты",
  "collection.cardUnit.many": "карт",
  "collection.cardUnit.other": "карты"
}
```

Japanese needs only `.other`. Add the categories your locale needs and remove English categories it does not use. Preserve placeholders in every form, including `{count}` when the English phrase uses it. Fractional numbers can select categories that whole numbers do not, so do not omit `.other` merely because common integer counts use another form.

You may omit an entire plural group for English fallback. Once you translate it, supply all categories the checker names. Runtime lookup selects the locale's category, then that dictionary's `.other` if present, and finally the English dictionary if no translation resolves. An incomplete group can therefore show a grammatically wrong form or unexpected English rather than a reliably translated phrase.

### Keep product and card identities intact

Do not translate **Manafolio**, **Magic: The Gathering**, **Scryfall**, or other product/provider names. Card and set names are catalog data, not interface strings; use the supplied names rather than replacing them in a locale file.

Translate workflow labels consistently. Physical Collection, Arena, Wishlist, Graveyard, storage containers, and deck checkout describe different states or actions. Preserve those distinctions, especially in confirmation messages, restore warnings, and anything that explains whether a copy moves, is reserved, or is deleted. Older keys may remain for inherited features; a translation key's presence does not mean that feature is part of Manafolio's current Magic-focused interface.

### Use natural language and typography

Translate the meaning rather than English word order or title case. Use your language's punctuation, spacing, quotation marks, and capitalization. Keep warnings explicit; do not shorten away destructive consequences or privacy/security cautions to fit a button.

## Check your work

The locale checker requires Node and npm but no dependency install. From the repository root:

```bash
npm run check:locales --prefix frontend
```

Or, from `frontend/`:

```bash
npm run check:locales
```

The checker validates all locale files. It reports coverage and fails on invalid JSON, invalid language tags, non-string values, unknown keys, missing or invented placeholders, and incomplete required plural categories. Language-specific plural suffixes are checked against their English base, so valid `.few` or `.many` forms need not exist in `en.json`.

Missing keys are counted, not errors. Coverage counts a plural group once, rather than counting each form separately. The report gives counts, not a complete list of untranslated keys; compare your file with `en.json` to find the gaps. Values that still contain English are not automatically detected as untranslated.

The [translation workflow](../.github/workflows/locales.yml) runs this command for pull requests touching `frontend/src/locales/**`, pushes to `main` touching that directory, and manual dispatches. Its Node version is 20. Running the checker locally is optional but gives faster feedback.

## Preview in the application

For a local preview, use the repository root so both the frontend and backend start:

```bash
npm run install:all
npm run dev
```

Follow the [development setup](../README.md#development), open the frontend, and choose your language in **Settings → Preferences**. Initial selection follows the browser's supported language preferences; an explicit choice is saved in that browser's local storage.

Review real collection, storage, and deck screens, especially narrow layouts, dialogs, plural counts, placeholders, and destructive-action confirmations. If text overflows, describe the screen and include a screenshot in the pull request rather than forcing an unnatural abbreviation. Do not include private collection or account data in screenshots.

## What locale files do not control

Some displayed values still come directly from stored data or English option lists: card conditions, finish labels such as **Nonfoil** and **Foil**, rarities, format names, and card-language names in entry forms. The finish helper separates stored values from display labels, but those labels are not translated through the locale dictionary. Do not change database values or JSON keys to compensate.

Card names, set names, imported descriptions, and user-authored container/deck names are also outside the interface dictionary. Report awkward gaps in the pull request so a display-label change can be considered separately.

When new English keys are added, existing translations continue working and missing entries use English. Update the existing locale file, rerun the checker if available, and submit a pull request; no source-code registration is needed.
