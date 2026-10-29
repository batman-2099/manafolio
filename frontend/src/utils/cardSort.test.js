import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('filing color order groups multicolor identities after mono-green', async () => {
  const server = await createServer({
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, ws: false },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { sortCardsByOrder } = await server.ssrLoadModule('/src/utils/cardSort.js');
    const cards = [
      { name: 'Gold Z', color_identity: ['W', 'U'] },
      { name: 'Colorless', color_identity: [] },
      { name: 'Green', color_identity: '["G"]' },
      { name: 'Gold A', color_identity: '["B","R"]' },
      { name: 'White', color_identity: 'W' },
    ];
    for (const by of ['color', 'color_identity']) {
      assert.deepEqual(sortCardsByOrder([...cards], [{ by }, { by: 'name' }]).map(card => card.name),
        ['White', 'Green', 'Gold A', 'Gold Z', 'Colorless']);
      assert.deepEqual(sortCardsByOrder([...cards], [{ by, dir: 'desc' }, { by: 'name' }]).map(card => card.name),
        ['Colorless', 'Gold A', 'Gold Z', 'Green', 'White']);
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
