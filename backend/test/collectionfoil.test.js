const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-collection-foil-'));
process.env.DB_PATH = path.join(temp, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-foil-password';
const db = require('../src/db');
const router = require('../src/routes/collection');
const imports = require('../src/routes/importExport');
const { parseThirdPartyCSV } = require('../src/utils/csvMappers');
const { generateExportCSV } = require('../src/utils/csvExporters');
const foilTreatments = require('../../shared/foilTreatments.json');
const api = require('../src/scryfallApi');
const id = number => `mtg-00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
async function request(routes, route, method, body = {}, params = {}) {
  const handler = routes.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack.at(-1).handle;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ user: { id: 1 }, body, params, accepts: () => 'application/json' }, res);
  return res;
}
(async () => {
  const originalAdapter = api.client.defaults.adapter;
  try {
    await db.initDb();
    api.client.defaults.adapter = async () => { throw new Error('Foil selection must stay offline'); };
    for (const [number, finishes, promos] of [[1, ['nonfoil', 'foil'], ['surgefoil']], [2, ['foil', 'etched'], []], [3, ['nonfoil'], []], [4, ['foil'], []]]) {
      await db.run(`INSERT INTO card_cache (id, name, game, language, finishes, promo_types) VALUES (?, 'Foil fixture', 'mtg', 'English', ?, ?)`,
        [id(number), JSON.stringify(finishes), JSON.stringify(promos)]);
    }
    await db.run(`INSERT INTO card_cache (id, name, game, language) VALUES (?, 'Missing metadata', 'mtg', 'English')`, [id(5)]);
    for (const number of [3, 5]) {
      for (const treatment of Object.keys(foilTreatments)) {
        const copy = await router.addCardToCollection({ id: 1 }, { card_id: id(number), printing: 'Holofoil', foil_treatment: treatment });
        assert.equal((await db.get('SELECT foil_treatment FROM collection WHERE id = ?', [copy.id])).foil_treatment, treatment,
          'every type is accepted regardless of nonfoil-only or missing metadata');
      }
    }
    const added = await router.addCardToCollection({ id: 1 }, { card_id: id(1), printing: 'Holofoil', quantity: 2, stackable: true });
    const entry = () => db.get('SELECT * FROM collection WHERE id = ?', [added.id]);
    assert.equal((await entry()).foil_treatment, null, 'metadata never selects a type for the user');
    await assert.rejects(router.addCardToCollection({ id: 1 }, { card_id: id(1), printing: 'Holofoil', foil_treatment: 'unknown' }), error => error.status === 400);
    const etched = await router.addCardToCollection({ id: 1 }, { card_id: id(1), printing: 'Holofoil', foil_treatment: 'etched' });
    assert.equal((await db.get('SELECT foil_treatment FROM collection WHERE id = ?', [etched.id])).foil_treatment, 'etched');
    const generic = await router.addCardToCollection({ id: 1 }, { card_id: id(2), printing: 'Holofoil' });
    assert.equal((await db.get('SELECT foil_treatment FROM collection WHERE id = ?', [generic.id])).foil_treatment, null, 'multiple finishes require no prompt');
    assert.equal((await request(router, '/collection/:id', 'put', { printing: 'Normal', foil_treatment: 'surge' }, { id: added.id })).statusCode, 200);
    assert.equal((await entry()).foil_treatment, null);
    assert.equal((await request(router, '/collection/:id', 'put', { printing: 'Holofoil' }, { id: added.id })).statusCode, 200);
    assert.equal((await entry()).foil_treatment, null);
    assert.equal((await request(router, '/collection/:id', 'put', { foil_treatment: 'traditional' }, { id: added.id })).statusCode, 200);
    await request(router, '/collection/:id', 'put', { notes: 'keep type' }, { id: added.id });
    assert.equal((await entry()).foil_treatment, 'traditional');
    assert.equal((await request(router, '/collection/:id', 'put', { foil_treatment: null }, { id: added.id })).statusCode, 200);
    await request(router, '/collection/:id', 'put', { notes: 'legacy unknown' }, { id: added.id });
    assert.equal((await entry()).foil_treatment, null, 'unrelated edits never relabel legacy foils');
    const before = await db.all('SELECT * FROM collection ORDER BY id');
    const invalidBulk = await request(router, '/collection/bulk', 'post', { entry_ids: [added.id, etched.id], action: 'printing', value: 'Holofoil', foil_treatment: 'unknown' });
    assert.equal(invalidBulk.statusCode, 400);
    assert.deepEqual(await db.all('SELECT * FROM collection ORDER BY id'), before, 'invalid bulk treatment leaves entries unchanged');
    const bulk = await request(router, '/collection/bulk', 'post', { entry_ids: [added.id, etched.id], action: 'printing', value: 'Holofoil', foil_treatment: 'surge' });
    assert.equal(bulk.statusCode, 200);
    assert.deepEqual((await db.all('SELECT foil_treatment FROM collection WHERE id IN (?, ?) ORDER BY id', [added.id, etched.id])).map(row => row.foil_treatment), ['surge', 'surge']);
    const imported = await request(imports, '/import', 'post', { format: 'json', data: [{ card_id: id(1), quantity: 1, printing: 'Holofoil', foil_treatment: 'etched' }] });
    assert.equal(imported.statusCode, 200, JSON.stringify(imported.body));
    assert.equal((await db.get('SELECT foil_treatment FROM collection ORDER BY id DESC LIMIT 1')).foil_treatment, 'etched');
    const legacyImport = await request(imports, '/import', 'post', { format: 'json', data: [{ card_id: id(2), quantity: 1, printing: 'Holofoil' }] });
    assert.equal(legacyImport.statusCode, 200, JSON.stringify(legacyImport.body));
    assert.equal((await db.get('SELECT foil_treatment FROM collection ORDER BY id DESC LIMIT 1')).foil_treatment, null);
    const invalidImport = await request(imports, '/import', 'post', { format: 'json', data: [{ card_id: id(1), printing: 'Holofoil', foil_treatment: 'unknown' }] });
    assert.equal(invalidImport.statusCode, 400);
    const csv = generateExportCSV([{ card_id: id(1), printing: 'Holofoil', foil_treatment: 'surge' }]);
    assert.ok(csv.includes('Foil Treatment') && csv.includes('"surge"'));
    assert.equal(parseThirdPartyCSV([{ 'Card ID': id(1), Printing: 'Holofoil', 'Foil Treatment': 'surge' }], 'internal')[0].foil_treatment, 'surge');
    console.log('Unrestricted foil mutation, bulk validation, import and CSV checks passed.');
  } finally {
    api.client.defaults.adapter = originalAdapter;
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
