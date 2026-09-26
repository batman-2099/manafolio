import assert from 'node:assert';

const store = new Map();
globalThis.localStorage = {
  getItem: key => store.get(key) || null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
};

const {
  enabledGames, isGameEnabled,
  setGameEnabled, defaultGame, defaultGameFilter, gameLabel,
} = await import('./games.js');

assert.deepStrictEqual(enabledGames(), ['mtg']);
assert.ok(isGameEnabled('mtg'));
assert.ok(!isGameEnabled('unknown'));
assert.ok(!isGameEnabled('lorcana'));
assert.strictEqual(defaultGame(), 'mtg');
assert.strictEqual(defaultGameFilter(), 'mtg');
assert.strictEqual(gameLabel('unknown'), 'Magic: The Gathering');
assert.strictEqual(gameLabel('mtg', true), 'MTG');
assert.strictEqual(setGameEnabled('mtg', false), false);

console.log('Magic-only game configuration self-check passed');
