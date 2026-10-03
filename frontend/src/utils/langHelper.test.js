// Self-check for provider names and supported languages.
// Run: `node src/utils/langHelper.test.js`
import assert from 'node:assert';
import { getCardDisplayName } from './langHelper.js';

// 1. When printed_name exists, it always wins regardless of language.
assert.strictEqual(getCardDisplayName('Ancestral Katana', '祖先の刀'), '祖先の刀');
assert.strictEqual(getCardDisplayName('Lightning Bolt', 'Foudre'), 'Foudre');
assert.strictEqual(getCardDisplayName('Lightning Bolt'), 'Lightning Bolt');
assert.strictEqual(getCardDisplayName(null), '');

// Game-scoped language filtering in frontend.
import { getLanguagesForGame } from './languages.js';
assert.deepStrictEqual(getLanguagesForGame('unsupported'), []);

console.log('langHelper.test.js OK');
