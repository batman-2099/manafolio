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
