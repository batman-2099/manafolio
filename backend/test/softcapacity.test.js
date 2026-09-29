// Real HTTP routes and isolated SQLite: capacity warns, never reroutes a move.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-soft-capacity-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
let server;

async function main() {
  await db.initDb();
  const userId = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('capacity-test', 'unused', 'capacity-test')`)).lastID;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: userId }; next(); });
  app.use('/api', require('../src/routes/collection'));
  app.use('/api', require('../src/routes/storage'));
  app.use('/api', require('../src/routes/importExport'));
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  const request = async (url, method = 'GET', body, status = 200) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
    });
    const result = await response.json();
    assert.strictEqual(response.status, status, JSON.stringify(result));
    return result;
  };
  for (const [id, name] of [['a', 'Alpha'], ['m', 'Middle'], ['z', 'Zulu'], ['import', 'Import copy']]) {
    await db.run(`INSERT INTO card_cache (id, name, game, types) VALUES (?, ?, 'mtg', '[]')`, [id, name]);
  }
  const container = async (name, sort = 'custom', stacking = 0, type = 'Box') => {
    const id = (await db.run(`INSERT INTO locations (name, type, sort_order, rule_type, game, user_id, allow_stacking)
      VALUES (?, ?, ?, 'any', 'mtg', ?, ?)`, [name, type, sort, userId, stacking])).lastID;
    const compartment = (await db.run(`INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 1, 1)`, [id])).lastID;
    return { id, compartment };
  };
  const add = async (card = 'm', destination = null, quantity = 1, list = 'collection') => (await db.run(
    `INSERT INTO collection (card_id, quantity, printing, language, location_id, compartment_id, position, user_id, game, list_type)
     VALUES (?, ?, 'Normal', 'English', ?, ?, ?, ?, 'mtg', ?)`,
    [card, quantity, destination?.id ?? null, destination?.compartment ?? null, destination ? 1000 : 0, userId, list]
  )).lastID;
  const stored = id => db.get('SELECT * FROM collection WHERE id = ?', [id]);
  const usage = async destination => (await request(`/locations/${destination.id}/compartments`)).find(c => c.id === destination.compartment);

  const target = await container('Chosen full box', 'name-asc');
  await add('m', target);
  const spare = await container('Spare empty box');
  const first = await add('a', null, 3);
  const moved = await request(`/collection/${first}`, 'PUT', { location_id: target.id });
  assert.strictEqual(moved.placement.location_id, target.id);
  assert.strictEqual((await stored(first)).quantity, 3);
  assert.strictEqual((await usage(target)).count, 4);
  assert.strictEqual((await usage(target)).capacity, 1);
  assert.strictEqual((await usage(spare)).count, 0);
  await db.run('DELETE FROM compartments WHERE location_id = ?', [spare.id]);
  await db.run('DELETE FROM locations WHERE id = ?', [spare.id]);
  const last = await add('z');
  await request(`/collection/${last}`, 'PUT', { location_id: target.id });
  assert.strictEqual((await stored(last)).location_id, target.id, 'no spare container must have the same result');
  assert.strictEqual((await stored(last)).position, 5000, 'sorted overflow follows all existing copies');

  const explicit = await add('m');
  await request(`/collection/${explicit}`, 'PUT', { compartment_id: target.compartment });
  assert.strictEqual((await stored(explicit)).compartment_id, target.compartment);
  const bulk = await add('z', null, 2);
  await request('/collection/bulk', 'POST', { action: 'move', entry_ids: [bulk], value: target.id });
  assert.strictEqual((await stored(bulk)).location_id, target.id);
  assert.strictEqual((await stored(bulk)).quantity, 2);

  const manual = await container('Manual overflow', 'custom', 0, 'Binder');
  await add('a', manual);
  const manualCard = await add('z');
  await request(`/collection/${manualCard}/place`, 'POST', { compartment_id: manual.compartment, slot: 2 });
  assert.strictEqual((await stored(manualCard)).position, 2000);
  assert.strictEqual((await usage(manual)).count, 2);
  const row = await container('Manual row');
  await add('a', row);
  const rowCard = await add('m');
  await request(`/collection/${rowCard}/place`, 'POST', { compartment_id: row.compartment, slot: 2 });
  assert.strictEqual((await stored(rowCard)).position, 2000);

  const batch = [await add('a'), await add('z')];
  const recommendations = await request(`/locations/${manual.id}/recommend-batch`, 'POST', { entry_ids: batch });
  assert.deepStrictEqual(recommendations.map(r => [r.recommended.location_id, r.recommended.position]), [[manual.id, 3000], [manual.id, 4000]]);
  const applied = await request(`/locations/${manual.id}/apply-all`, 'POST', { entry_ids: batch });
  assert.strictEqual(applied.filed, 2);
  for (const id of batch) assert.strictEqual((await stored(id)).location_id, manual.id);
  const resorted = await request(`/locations/${manual.id}/resort`, 'POST', {});
  assert.strictEqual(resorted.length, 4);
  assert.ok(resorted.every(r => r.recommended?.location_id === manual.id));
  assert.strictEqual((await usage(manual)).count, 4);

  // Earlier free pages remain preferred even when a late alphabetical card sorts beyond nominal capacity.
  const sorted = await container('Earlier free page', 'name-asc');
  const secondComp = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 2, 1)', [sorted.id])).lastID;
  await add('a', { id: sorted.id, compartment: secondComp });
  const freeRec = await request(`/locations/${sorted.id}/recommend`, 'POST', { card_id: 'z' });
  assert.strictEqual(freeRec.compartment_id, sorted.compartment);

  const stack = await container('Stacking overflow', 'custom', 1, 'Binder');
  await add('a', stack, 4);
  const twin = await add('a');
  await request(`/collection/${twin}`, 'PUT', { location_id: stack.id });
  assert.strictEqual((await stored(twin)).position, 1000);
  assert.strictEqual((await usage(stack)).count, 1);
  const different = await add('z');
  await request(`/collection/${different}`, 'PUT', { location_id: stack.id });
  assert.strictEqual((await stored(different)).position, 2000);
  assert.strictEqual((await usage(stack)).count, 2);
  const extraPage = (await db.run('INSERT INTO compartments (location_id, idx, capacity) VALUES (?, 2, 1)', [stack.id])).lastID;
  await add('a', { id: stack.id, compartment: extraPage });
  const summary = (await request('/locations')).find(location => location.id === stack.id);
  assert.strictEqual(summary.total_cards, 3, 'identical stacks on separate pages occupy separate slots');
  assert.strictEqual(summary.total_capacity, 2);

  // Capacity fallback cannot bypass locks or rules, including a twin on a now-ineligible page.
  await db.run('UPDATE locations SET locked = 1 WHERE id = ?', [stack.id]);
  assert.strictEqual((await request(`/locations/${stack.id}/recommend`, 'POST', { card_id: 'a' })).rejected, true);
  await db.run('UPDATE locations SET locked = 0 WHERE id = ?', [stack.id]);
  await db.run('UPDATE compartments SET locked = 1 WHERE location_id = ?', [stack.id]);
  assert.strictEqual((await request(`/locations/${stack.id}/recommend`, 'POST', { card_id: 'a' })).rejected, true);
  await db.run('UPDATE compartments SET locked = 0, rule_config = ? WHERE location_id = ?', [JSON.stringify([{ field: 'name', operator: 'equals', value: 'Alpha', action: 'exclude' }]), stack.id]);
  assert.strictEqual((await request(`/locations/${stack.id}/recommend`, 'POST', { card_id: 'a' })).rejected, true);
  await db.run(`UPDATE locations SET rule_type = 'compound', rule_config = ? WHERE id = ?`, [JSON.stringify([{ field: 'name', operator: 'equals', value: 'Zulu', action: 'exclude' }]), stack.id]);
  assert.strictEqual((await request(`/locations/${stack.id}/recommend`, 'POST', { card_id: 'z' })).rejected, true);

  const arena = await add('m', null, 1, 'arena');
  await request(`/collection/${arena}`, 'PUT', { compartment_id: manual.compartment }, 400);
  assert.strictEqual((await stored(arena)).location_id, null);
  await request(`/collection/${arena}/place`, 'POST', { compartment_id: manual.compartment, slot: 9 }, 400);
  const foreign = await container('Foreign box');
  const otherUser = (await db.run(`INSERT INTO users (username, password_hash, share_token) VALUES ('capacity-other', 'unused', 'capacity-other')`)).lastID;
  await db.run('UPDATE locations SET user_id = ? WHERE id = ?', [otherUser, foreign.id]);
  await request(`/collection/${arena}`, 'PUT', { compartment_id: foreign.compartment }, 400);

  // Container import movement preserves its limit and total owned quantity while splitting a legacy stack.
  const imported = await container('Imported box');
  await add('a', imported);
  const source = await add('import', row, 4);
  const before = await db.get('SELECT SUM(quantity) AS n FROM collection WHERE user_id = ?', [userId]);
  const report = await request('/import-container/move', 'POST', { location_id: imported.id, card_id: 'import', printing: 'Normal', requested: 3 });
  assert.strictEqual(report.moved, 3);
  assert.strictEqual((await usage(imported)).capacity, 1);
  assert.strictEqual((await usage(imported)).count, 4);
  assert.strictEqual((await stored(source)).quantity, 1);
  assert.deepStrictEqual(await db.get('SELECT SUM(quantity) AS n FROM collection WHERE user_id = ?', [userId]), before);
  console.log('PASS: advisory capacity keeps moves, placement, filing and imports in the chosen eligible container');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => db.dbConnection.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
