import test from 'node:test';
import assert from 'node:assert/strict';
import { artUrl, noteArtChanged } from './cardArt.js';

test('successful art changes invalidate only that card URL, including replacements and bundled fallback', () => {
  const cardId = 'replacement/art';
  const original = artUrl(cardId);
  const other = artUrl('unchanged-card');
  assert.equal(original, '/api/card-art/replacement%2Fart.png');
  noteArtChanged(cardId, true);
  const uploaded = artUrl(cardId);
  assert.notEqual(uploaded, original);
  assert.equal(artUrl(cardId), uploaded);
  noteArtChanged(cardId, true);
  const replaced = artUrl(cardId);
  assert.notEqual(replaced, uploaded);
  noteArtChanged(cardId, false);
  assert.notEqual(artUrl(cardId), replaced);
  assert.equal(artUrl('unchanged-card'), other);
});
