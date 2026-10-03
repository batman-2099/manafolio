import test from 'node:test';
import assert from 'node:assert/strict';
import { filterOfflineCards } from './offlineFilter.js';

test('offline lookup combines all search tokens and exact inventory, finish, location and color filters', () => {
  const physical = { entry_id: 1, name: 'Lightning Bolt', printed_name: 'Blitzschlag', set_name: 'Magic 2010', set_id: 'm10', number: '146', list_type: 'collection', printing: 'foil', color_identity: ['R'], location_id: 7 };
  const arena = { ...physical, entry_id: 2, list_type: 'arena', location_id: null };
  const wishlist = { ...physical, entry_id: 3, list_type: 'wishlist', color_identity: [], location_id: null };
  const cards = [physical, arena, wishlist];
  assert.deepEqual(filterOfflineCards(cards), [physical]);
  assert.deepEqual(filterOfflineCards(cards, { query: ' BLITZ m10 146 magic ', color: 'R', finish: 'foil', location: '7' }), [physical]);
  assert.deepEqual(filterOfflineCards(cards, { query: 'bolt absent' }), []);
  assert.deepEqual(filterOfflineCards(cards, { color: 'U' }), []);
  assert.deepEqual(filterOfflineCards(cards, { finish: 'normal' }), []);
  assert.deepEqual(filterOfflineCards(cards, { location: 'unassigned' }), []);
  assert.deepEqual(filterOfflineCards(cards, { inventory: 'arena', location: 'unassigned' }), [arena]);
  assert.deepEqual(filterOfflineCards(cards, { inventory: 'wishlist', color: 'C' }), [wishlist]);
});
