import assert from 'node:assert';

import { isGameEnabled, defaultGame, defaultGameFilter, gameLabel } from './games.js';

assert.ok(isGameEnabled('mtg'));
assert.ok(!isGameEnabled('unknown'));
assert.ok(!isGameEnabled('lorcana'));
assert.strictEqual(defaultGame(), 'mtg');
assert.strictEqual(defaultGameFilter(), 'mtg');
assert.strictEqual(gameLabel('unknown'), 'Magic: The Gathering');
assert.strictEqual(gameLabel('mtg', true), 'MTG');

console.log('Magic-only game configuration self-check passed');
