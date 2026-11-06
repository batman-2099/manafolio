const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-foil-treatments-'));
process.env.DB_PATH = path.join(dir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'foil-treatment-test-password';
const db = require('../src/db');
const api = require('../src/scryfallApi');
const { parseCardRow } = require('../src/utils/priceHelpers');
const { resolveFoilTreatment } = require('../src/utils/foilTreatments');
const foilTreatments = require('../../shared/foilTreatments.json');
const raw = extra => ({
  object: 'card', id: '00000000-0000-0000-0000-000000000010',
  name: 'Foil fixture', set: 'tst', collector_number: '10', lang: 'en',
  finishes: ['nonfoil', 'foil', 'etched'], frame: '2015', border_color: 'black', full_art: false, ...extra,
});

async function main() {
  const originalAdapter = api.client.defaults.adapter;
  const originalFetch = api.bulkFetchByIdentifier;
  try {
    api.client.defaults.adapter = async () => { throw new Error('Foil selection must stay offline'); };
    api.bulkFetchByIdentifier = async () => { throw new Error('Foil selection must not resolve availability'); };
    assert.deepStrictEqual(Object.keys(foilTreatments), [
      'traditional', 'etched', 'textured', 'surge', 'galaxy', 'halo', 'raised', 'neon_ink', 'double_rainbow',
    ]);
    for (const treatment of Object.keys(foilTreatments)) {
      assert.strictEqual(resolveFoilTreatment('Holofoil', treatment), treatment);
      assert.strictEqual(resolveFoilTreatment('Normal', treatment), null);
      assert.strictEqual(resolveFoilTreatment('Holofoil', undefined,
        { printing: 'Holofoil', foil_treatment: treatment }), treatment, 'unrelated edits preserve selected types');
    }
    assert.strictEqual(resolveFoilTreatment('Holofoil'), null, 'omitted new foil remains unspecified');
    assert.strictEqual(resolveFoilTreatment('Holofoil', null), null);
    assert.strictEqual(resolveFoilTreatment('Holofoil', undefined,
      { printing: 'Holofoil', foil_treatment: null }), null, 'legacy foils stay unspecified');
    assert.strictEqual(resolveFoilTreatment('Holofoil', null,
      { printing: 'Holofoil', foil_treatment: 'surge' }), null, 'explicit null clears a selected type');
    assert.strictEqual(resolveFoilTreatment('Normal', undefined,
      { printing: 'Holofoil', foil_treatment: 'surge' }), null);
    assert.strictEqual(resolveFoilTreatment('Holofoil', undefined, { printing: 'Normal' }), null);
    assert.throws(() => resolveFoilTreatment('Foil', 'traditional'), { status: 400 });
    for (const supplied of ['', 'unknown', 'toString', '__proto__', [], {}, true, 1]) {
      for (const printing of ['Holofoil', 'Normal']) {
        assert.throws(() => resolveFoilTreatment(printing, supplied), { status: 400 });
      }
    }

    await db.initDb();
    for (const [table, column] of [['card_cache', 'finishes'], ['card_cache', 'promo_types'],
      ['collection', 'foil_treatment'], ['scan_drafts', 'foil_treatment']]) {
      await db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    await db.run("INSERT INTO card_cache (id, name, game) VALUES ('legacy', 'Legacy', 'mtg')");
    await db.run("INSERT INTO collection (card_id, user_id, printing) VALUES ('legacy', 1, 'Holofoil')");
    await db.run("INSERT INTO scan_drafts (card_id, user_id, printing) VALUES ('legacy', 1, 'Holofoil')");
    await db.initDb();
    assert.deepStrictEqual(await db.get("SELECT finishes, promo_types FROM card_cache WHERE id = 'legacy'"),
      { finishes: null, promo_types: null });
    assert.strictEqual((await db.get('SELECT foil_treatment FROM collection')).foil_treatment, null);
    assert.strictEqual((await db.get('SELECT foil_treatment FROM scan_drafts')).foil_treatment, null);
    await db.initDb();
    assert.strictEqual((await db.get('SELECT foil_treatment FROM collection')).foil_treatment, null);

    const card = api.normalizeCard(raw({ promo_types: ['surgefoil'] }));
    await api.cacheCards([card]);
    await api.cacheCards([{ ...card, finishes: null, promo_types: null }]);
    const cached = parseCardRow(await db.get('SELECT * FROM card_cache WHERE id = ?', [card.id]));
    assert.deepStrictEqual(cached.finishes, card.finishes);
    assert.deepStrictEqual(cached.promo_types, ['surgefoil']);
    assert.deepStrictEqual(cached.printing_treatments, ['regular'], 'foil never changes art treatments');
    assert.strictEqual(api.normalizeCard(raw({ finishes: undefined })).finishes, null);
    assert.strictEqual(api.normalizeCard(raw({ finishes: 'foil' })).finishes, null);
    assert.strictEqual(api.normalizeCard(raw({ promo_types: 'surgefoil' })).promo_types, null);
    console.log('foiltreatments.test.js: unrestricted enum, offline normalization, migration and metadata cache passed');
  } finally {
    api.client.defaults.adapter = originalAdapter;
    api.bulkFetchByIdentifier = originalFetch;
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
