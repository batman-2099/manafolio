import test from 'node:test';
import assert from 'node:assert/strict';
import { deckContainers } from './deckContainers.js';

test('pull-list containers combine copies across cards and compartments, not names', () => {
  assert.deepEqual(deckContainers({
    dragon: [
      { location_id: 2, location_name: 'Box 10', compartment_id: 10, take: 2 },
      { location_id: 1, location_name: 'Box 2', take: 1 },
      { location_id: null, location_name: 'Unassigned Pile', take: 3 },
    ],
    land: [
      { location_id: 2, location_name: 'Box 10', compartment_id: 11, take: 5 },
      { location_id: 3, location_name: 'Box 10', take: 1 },
      { location_id: null, location_name: 'Unassigned Pile', take: 2 },
      { location_id: 4, location_name: 'Unused', take: 0 },
    ],
    unavailable: [],
  }), [
    { id: 1, name: 'Box 2', quantity: 1 },
    { id: 2, name: 'Box 10', quantity: 7 },
    { id: 3, name: 'Box 10', quantity: 1 },
    { id: null, name: 'Unassigned Pile', quantity: 5 },
  ]);
  assert.deepEqual(deckContainers({}), []);
});
