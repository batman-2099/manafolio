import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toggleSetCodes } from './setSelection.js';

test('set families toggle case-insensitively while children remain independently selectable', () => {
  const original = ['other', 'TSET'];
  const family = toggleSetCodes(original, 'set', ['tset', 'pset']);
  assert.deepEqual(family, ['other', 'set', 'tset', 'pset']);
  assert.deepEqual(original, ['other', 'TSET']);
  const withoutTokens = toggleSetCodes(family, 'TSET');
  assert.deepEqual(withoutTokens, ['other', 'set', 'pset']);
  assert.deepEqual(toggleSetCodes(withoutTokens, 'SET', ['tset', 'pset']), ['other']);
  assert.deepEqual(toggleSetCodes(['other'], 'set'), ['other', 'set']);
});
