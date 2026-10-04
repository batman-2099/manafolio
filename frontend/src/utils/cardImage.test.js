import test from 'node:test';
import assert from 'node:assert/strict';
import { cardThumbnailUrl } from './cardImage.js';

test('dashboard thumbnails resize only Scryfall normal URLs without changing the card', () => {
  const card = Object.freeze({ image_url: 'https://cards.scryfall.io/normal/front/6/8/686d43eb-ea91-4ae1-bdc4-dcd885688acd.jpg?1789737534' });
  assert.equal(cardThumbnailUrl(card.image_url), 'https://cards.scryfall.io/small/front/6/8/686d43eb-ea91-4ae1-bdc4-dcd885688acd.jpg?1789737534');
  assert.equal(card.image_url, 'https://cards.scryfall.io/normal/front/6/8/686d43eb-ea91-4ae1-bdc4-dcd885688acd.jpg?1789737534');
  assert.equal(cardThumbnailUrl('https://cards.scryfall.io/normal/back/a/b/card.jpg'), 'https://cards.scryfall.io/small/back/a/b/card.jpg');

  for (const url of [
    'https://cards.scryfall.io/small/front/a/b/card.jpg',
    'https://cards.scryfall.io/art_crop/front/a/b/card.jpg',
    'https://cards.scryfall.io/large/front/a/b/card.jpg',
    'https://cards.scryfall.io/normality/front/a/b/card.jpg',
    'https://example.com/normal/front/a/b/card.jpg',
    'https://cards.scryfall.io.example.com/normal/front/a/b/card.jpg',
    'https://cards.scryfall.io@example.com/normal/front/a/b/card.jpg',
    'https://example.com/?image=https://cards.scryfall.io/normal/front/a/b/card.jpg',
    '/api/card-art/normal/card.png',
    'data:image/png;base64,normal',
    '',
    undefined,
  ]) assert.equal(cardThumbnailUrl(url), url);
  assert.equal(cardThumbnailUrl(null), undefined);
});
