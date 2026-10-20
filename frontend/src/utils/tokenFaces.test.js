import test from 'node:test';
import assert from 'node:assert/strict';
import { isMtgToken, pairedCardName, reverseFace } from './tokenFaces.js';
import { filterOfflineCards } from './offlineFilter.js';

const token = { card_id: 'mtg-front', game: 'mtg', name: 'Goblin', subtypes: ['Token', 'Creature'], quantity: 2, list_type: 'collection' };
const pair = { ...token, reverse_card_id: 'mtg-back', reverse_name: 'Soldier', reverse_printed_name: 'Soldat', reverse_image_url: '/back.png' };
test('explicit token pair remains one searchable entry with independent reverse artwork identity', () => {
  assert.equal(isMtgToken(token), true);
  assert.equal(isMtgToken({ ...token, game: 'pokemon' }), false);
  assert.equal(isMtgToken({ ...token, subtypes: ['Creature'] }), false);
  assert.equal(pairedCardName(pair), 'Goblin // Soldat');
  assert.equal(pairedCardName(token), 'Goblin');
  assert.equal(reverseFace(pair).id, 'mtg-back');
  assert.equal(reverseFace(pair).image_url, '/back.png');
  assert.equal(reverseFace(token), null);
  assert.deepEqual(filterOfflineCards([pair, token], { query: 'soldier', inventory: 'collection' }), [pair]);
  assert.equal(pair.quantity, 2);
  assert.equal(reverseFace({ ...token, image_url_back: '/native-back.png' }).image_url, '/native-back.png');
  assert.equal(reverseFace({ ...token, card_faces: [{}, { name: 'Native back', image_uris: { normal: '/native.png' } }] }).name, 'Native back');
});

test('token set names identify cards without token type metadata', () => {
  for (const set_name of ['Sample Token Set', 'Sample Tokens', 'SAMPLE TOKENS']) {
    assert.equal(isMtgToken({ game: 'mtg', set_name, subtypes: ['Card'] }), true);
    assert.equal(isMtgToken({ supertype: 'MTG', set_name }), true);
    assert.equal(isMtgToken({ game: 'pokemon', set_name }), false);
  }
  for (const set_name of [undefined, '', 'Ordinary Set', 'Tokenized Set']) {
    assert.equal(isMtgToken({ game: 'mtg', set_name }), false);
  }
  assert.equal(isMtgToken(null), false);
});
