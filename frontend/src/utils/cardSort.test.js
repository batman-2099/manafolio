import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('filing and dividers use card colors, not Commander color identity', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { sortCardsByOrder } = await server.ssrLoadModule('/src/utils/cardSort.js');
    const { getSortCategories } = await server.ssrLoadModule('/src/components/CompartmentView.jsx');
    const cards = [
      { name: 'Gold Z', types: ['W', 'U'], color_identity: ['W', 'U'] },
      { name: 'Shattered Sanctum', types: [], color_identity: ['W', 'B'] },
      { name: 'Green', types: '["G"]', color_identity: ['G'] },
      { name: 'Gold A', types: '["B","R"]', color_identity: ['B', 'R'] },
      { name: 'Nick Fury', types: ['White'], color_identity: ['W', 'U', 'B', 'R', 'G'] },
    ];
    for (const by of ['color', 'color_identity']) {
      assert.deepEqual(sortCardsByOrder([...cards], [{ by }, { by: 'name' }]).map(card => card.name),
        ['Nick Fury', 'Green', 'Gold A', 'Gold Z', 'Shattered Sanctum']);
      assert.deepEqual(sortCardsByOrder([...cards], [{ by, dir: 'desc' }, { by: 'name' }]).map(card => card.name),
        ['Shattered Sanctum', 'Gold A', 'Gold Z', 'Green', 'Nick Fury']);
      assert.equal(getSortCategories(cards[4], [{ by, divider: true }])[0].label, 'White');
      assert.equal(getSortCategories(cards[1], [{ by, divider: true }])[0].label, 'Colorless');
      for (const [colors, expected] of [
        [['B', 'W'], 'Multicolor'], ['["Black","White"]', 'Multicolor'],
        [['B'], 'Black'], ['["W"]', 'White'], [[], 'Colorless'], [null, 'Colorless'],
      ]) {
        assert.equal(getSortCategories({ types: colors, color_identity: ['W', 'U', 'B', 'R', 'G'] }, [{ by, divider: true }])[0].label, expected);
      }
    }
  } finally {
    await server.close();
  }
});

test('alphabetical set filing differs from chronological collection sorting', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { sortCardsByOrder } = await server.ssrLoadModule('/src/utils/cardSort.js');
    const sets = [{ name: 'Zeta' }, { name: 'Alpha' }];
    const cards = [
      { name: 'Zebra', set_name: 'Alpha', number: '1' },
      { name: 'Apple', set_name: 'Alpha', number: '99' },
      { name: 'Birch', set_name: 'Zeta', number: '1' },
    ];
    assert.deepEqual(sortCardsByOrder([...cards], [{ by: 'set_name' }, { by: 'name' }], undefined, sets).map(card => card.name),
      ['Apple', 'Zebra', 'Birch']);
    assert.deepEqual(sortCardsByOrder([...cards], [{ by: 'set' }, { by: 'number' }], undefined, sets).map(card => card.name),
      ['Birch', 'Zebra', 'Apple']);
    const duplicateSets = [{ name: 'Zeta' }, { name: 'Alpha' }, { name: 'Zeta' }];
    const withUnknown = [...cards, { name: 'Unknown B', set_name: 'Unknown B' }, { name: 'Unknown A', set_name: 'Unknown A' }, { name: 'Missing' }];
    for (const [dir, expected] of [
      ['asc', ['Birch', 'Zebra', 'Apple', 'Missing', 'Unknown A', 'Unknown B']],
      ['desc', ['Unknown B', 'Unknown A', 'Missing', 'Zebra', 'Apple', 'Birch']],
    ]) {
      assert.deepEqual(sortCardsByOrder([...withUnknown], [{ by: 'set', dir }, { by: 'number' }], undefined, duplicateSets).map(card => card.name), expected);
    }
    for (const list of [[], null]) {
      assert.deepEqual(sortCardsByOrder([...withUnknown], [{ by: 'set' }, { by: 'number' }], undefined, list).map(card => card.name),
        ['Missing', 'Zebra', 'Apple', 'Unknown A', 'Unknown B', 'Birch']);
    }
  } finally {
    await server.close();
  }
});

test('card type sorting uses the type line, with stable multi-type precedence and name ties', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { sortCardsByOrder, typeCategory, colorCategory, COLLECTION_SORT_CRITERIA } = await server.ssrLoadModule('/src/utils/cardSort.js');
    const cards = [
      { name: 'A sorcery', types: ['White'], subtypes: ['Sorcery'] },
      { name: 'Z creature', types: [], subtypes: ['Artifact', 'Creature', 'Golem'] },
      { name: 'B creature', types: ['Green'], subtypes: ['Legendary', 'Enchantment', 'Creature'] },
      { name: 'C land', types: [], subtypes: '["Basic","Land","Island"]' },
      { name: 'Other', types: ['Blue'], subtypes: [] },
    ];
    assert.deepEqual(sortCardsByOrder([...cards], COLLECTION_SORT_CRITERIA['type-asc']).map(card => card.name),
      ['B creature', 'Z creature', 'A sorcery', 'C land', 'Other']);
    assert.deepEqual(sortCardsByOrder([...cards], [{ by: 'type', dir: 'desc' }, { by: 'name' }]).map(card => card.name),
      ['Other', 'C land', 'A sorcery', 'B creature', 'Z creature']);
    assert.equal(typeCategory('not JSON'), 'Other');
    assert.equal(typeCategory({ Creature: true }), 'Other');
    assert.equal(colorCategory(['White', 'Blue']), 'Multicolor', 'printed-color filters remain independent of card type');
    assert.equal(colorCategory([]), 'Colorless');
  } finally {
    await server.close();
  }
});
