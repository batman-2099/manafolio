// Self-check for provider names, translation fallback, and supported languages.
// Run: `node src/utils/langHelper.test.js`
import assert from 'node:assert';
import { getCardDisplayName } from './langHelper.js';

// 1. When printed_name exists, it always wins regardless of language.
assert.strictEqual(getCardDisplayName('Ancestral Katana', 'Japanese', '祖先の刀'), '祖先の刀');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'French', 'Foudre'), 'Foudre');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'German'), 'Lightning Bolt');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'de'), 'Lightning Bolt');

// Game-scoped language filtering in frontend.
import { getLanguagesForGame, getLanguageNamesForGame, isLanguageSupported } from './languages.js';
assert.strictEqual(getLanguagesForGame('lorcana').length, 6);
assert.ok(isLanguageSupported('lorcana', 'French'));
assert.ok(isLanguageSupported('lorcana', 'fr'));
assert.ok(!isLanguageSupported('lorcana', 'es'));
assert.ok(!isLanguageSupported('lorcana', 'Spanish'));
assert.strictEqual(getLanguageNamesForGame('lorcana').length, 6);
assert.strictEqual(getLanguagesForGame('mtg').length, 11);
// Disney Lorcana card translations.
assert.strictEqual(getCardDisplayName('Tyler Nguyen-Baker - 4*Town Fan', 'French'), 'Tyler Nguyen-Baker - Fan des 4*Town');
assert.strictEqual(getCardDisplayName('Tyler Nguyen-Baker - 4*Town Fan', 'German'), 'Tyler Nguyen-Baker - 4*Town-Fan');
assert.strictEqual(getCardDisplayName('Tyler Nguyen-Baker - 4*Town Fan', 'Italian'), 'Tyler Nguyen-Baker - Fan dei 4*Town');
assert.strictEqual(getCardDisplayName('Elsa - Snow Queen', 'French'), 'Elsa - Reine des neiges');
assert.strictEqual(getCardDisplayName('Mickey Mouse - Brave Little Tailor', 'German'), 'Micky Maus - Tapferes Schneiderlein');
assert.strictEqual(getCardDisplayName('Beast - Tragic Hero', 'it'), 'La Bestia - Eroe tragico');

console.log('langHelper.test.js OK');
