import test from 'node:test';
import assert from 'node:assert/strict';
import { preconFormat } from './preconFormat.js';

test('precon product types select supported formats and target sizes without assuming Commander', () => {
  for (const [type, format, targetSize] of [
    ['Commander Deck', 'Commander / EDH', 100],
    ['MTGO Commander Deck', 'Commander / EDH', 100],
    ['Brawl Deck', 'Brawl', 60],
    ['Historic Brawl Precon Deck', 'Brawl', 100],
    ['Pioneer Challenger Deck', 'Pioneer', 60],
    ['Modern Event Deck', 'Modern', 60],
    ['Challenger Deck', 'Standard', 60],
    ['Duel Deck', 'Casual', 60],
    [undefined, 'Casual', 60],
  ]) assert.deepEqual(preconFormat(type), { format, targetSize }, type);
});
