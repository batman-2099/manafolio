const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const express = require('express');
const fixture = require('./fixtures/set-completion.json');

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manafolio-set-completion-'));
  process.env.DB_PATH = path.join(dir, 'sample.db');
  process.env.DEFAULT_ADMIN_PASSWORD = 'set-completion-fixture';
  process.env.SCRYFALL_GAP_SCALE = '0';
  const db = require('../src/db');
  const api = require('../src/scryfallApi');
  const originalGet = api.client.get;
  let server;
  const cards = fixture.pages.flatMap(page => page.data);
  const id = index => `mtg-${cards[index].id}`;
  let failSecond = false;
  let badPagination = false;
  const calls = [];
  api.client.get = async url => {
    calls.push(url);
    const page = new URL(url, 'https://api.scryfall.com').searchParams.get('page') === '2' ? 1 : 0;
    if (failSecond && page) throw new Error('Fixture provider offline');
    return { data: badPagination ? { ...fixture.pages[0], next_page: 'https://example.invalid/cards/search' } : fixture.pages[page] };
  };
  try {
    await db.initDb();
    await db.run(`INSERT INTO users (id, username, password_hash, share_token) VALUES (2, 'other', 'unused', 'other-share')`);
    await db.run(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('completion-fixture', 1, '2999-01-01'), ('other-fixture', 2, '2999-01-01')`);
    await db.run(`INSERT INTO sets (id, name, game) VALUES ('mtg-tst', 'Completion Fixture', 'mtg')`);
    await api.cacheCards(cards.map(card => api.normalizeCard(card)));
    const japanese = api.normalizeCard({ ...cards[0], id: 'completion-japanese', lang: 'ja' });
    const reprint = api.normalizeCard({ ...cards[4], id: 'completion-other-set', set: 'oth' });
    await api.cacheCards([japanese, reprint]);
    const own = async (card, quantity = 1, list = 'collection', printing = 'Normal', missing = 0, user = 1) =>
      (await db.run(`INSERT INTO collection (card_id, quantity, list_type, printing, missing, user_id, game) VALUES (?, ?, ?, ?, ?, ?, 'mtg')`,
        [card, quantity, list, printing, missing, user])).lastID;
    await own(id(0), 2);
    await own(id(0));
    await own(japanese.id, 1, 'collection', 'Holofoil');
    await own(id(1), 1, 'collection', 'Holofoil', 1);
    await own(id(2), 1, 'collection', 'Normal', 1);
    await own(id(2), 100, 'wishlist');
    await own(id(2), 100, 'graveyard');
    await own(id(4), 100, 'collection', 'Holofoil', 0, 2);
    await own(reprint.id, 10);
    await own(id(2), 4, 'arena');
    const reservedEntry = await own(id(3), 1, 'collection', 'Holofoil');
    const deck = (await db.run(`INSERT INTO decks (name, user_id, checked_out, inventory_type) VALUES ('Reserved', 1, 1, 'collection')`)).lastID;
    await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, 1)', [deck, id(3)]);
    await db.run('INSERT INTO deck_card_allocations (deck_id, card_id, entry_id, quantity) VALUES (?, ?, ?, 1)', [deck, id(3), reservedEntry]);
    const app = express();
    app.use('/api', require('../src/middleware/auth').authenticateToken);
    app.use('/api/sets', require('../src/routes/sets'));
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    async function request(inventory = 'collection', status = 200, token = 'completion-fixture') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sets/mtg-tst/completion?inventory_type=${inventory}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await response.json();
      assert.strictEqual(response.status, status, JSON.stringify(data));
      return data;
    }
    await request('collection', 401, '');
    await request('wishlist', 400);
    await request('graveyard', 400);
    const physical = (await request()).goals;
    assert.deepStrictEqual(Object.values(physical).map(goal => [goal.owned, goal.total]), [[2, 4], [2, 5], [2, 3]]);
    assert.strictEqual(calls.length, 2, 'the complete set includes the second provider page');
    const alpha = physical.cards.rows.find(row => row.name === 'Alpha');
    assert.deepStrictEqual(alpha.printings.map(card => [card.recorded, card.owned, card.available]), [[4, 4, 4], [1, 0, 0]], 'duplicate copies and languages count as quantity, not extra goals; lost copies remain recorded');
    const gamma = physical.foil.rows.find(row => row.name === 'Gamma').printings[0];
    assert.deepStrictEqual([gamma.recorded, gamma.owned, gamma.available], [1, 1, 0], 'reserved foil still completes the goal, but is not free');
    const arena = (await request('arena')).goals;
    assert.deepStrictEqual(Object.values(arena).map(goal => [goal.owned, goal.total]), [[1, 3], [1, 3], [0, 0]], 'Arena inventory and provider game eligibility stay separate; foil is not applicable');
    const other = (await request('collection', 200, 'other-fixture')).goals;
    assert.deepStrictEqual(Object.values(other).map(goal => [goal.owned, goal.total]), [[1, 4], [1, 5], [0, 3]], 'other accounts cannot borrow owned copies or foil availability');
    failSecond = true;
    const failure = await request('collection', 502);
    assert.strictEqual(failure.goals, undefined, 'a failed later page never becomes a complete or cached-subset result');
    failSecond = false;
    badPagination = true;
    await request('collection', 502);
    assert.ok(calls.every(url => new URL(url, 'https://api.scryfall.com').origin === 'https://api.scryfall.com'));
    badPagination = false;
    assert.strictEqual((await request()).goals.cards.total, 4, 'retry recovers after provider failure');
    console.log('Set completion: denominators, finishes, languages, reservations, isolation, pagination and retry passed.');
  } finally {
    api.client.get = originalGet;
    if (server) await new Promise(resolve => server.close(resolve));
    await new Promise((resolve, reject) => db.dbConnection.close(error => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
