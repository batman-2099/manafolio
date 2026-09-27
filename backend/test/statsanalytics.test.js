const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-stats-analytics-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';
const db = require('../src/db');
const router = require('../src/routes/stats');
async function stats(userId, inventory = 'all', endpoint = '/stats') {
  const handler = router.stack.find(layer => layer.route?.path === endpoint).route.stack[0].handle;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await handler({ user: { id: userId }, query: { inventory, period: '7d' } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  return res.body;
}

async function main() {
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 8, 23);
  try {
    await db.initDb();
    const users = [];
    for (const name of ['owner', 'other', 'empty']) {
      users.push((await db.run('INSERT INTO users (username, password_hash, share_token) VALUES (?, ?, ?)', [name, 'test', `stats-${name}`])).lastID);
    }
    const [owner, other, empty] = users;
    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const blankGrowth = months.map(month => ({ month, physical: 0, arena: 0, graveyard: 0 }));
    const colorNames = ['White', 'Blue', 'Black', 'Red', 'Green', 'Colorless', 'Unknown'];
    const manaNames = ['0', '1', '2', '3', '4', '5', '6', '7+', 'Unknown'];
    const distribution = (names, owned = {}, decks = {}) => names.map(name => ({ name, owned: owned[name] || 0, decks: decks[name] || 0 }));
    const blank = {
      growth: blankGrowth, deckPerformance: [],
      colors: distribution(colorNames), mana: distribution(manaNames)
    };
    assert.deepStrictEqual((await stats(owner)).analytics, blank);

    for (const [id, name, identity, cmc, types, subtypes, game] of [
      ['multi', 'Multicolor', '["W","Green","W"]', 2, '["Creature"]', '[]', 'mtg'],
      ['zero', 'Zero Artifact', '[]', 0, '["Artifact"]', '[]', 'mtg'],
      ['unknown', 'Unknown Card', null, null, null, null, 'mtg'],
      ['land', 'Island', null, 0, '["Land"]', '["Island"]', 'mtg'],
      ['high', 'Expensive Spell', '["R"]', 9, '["Sorcery"]', '[]', 'mtg'],
      ['archived', 'Archived Enchantment', '["B"]', 5, '["Enchantment"]', '[]', 'mtg'],
      ['legacy', 'Legacy Card', '["White"]', 2, '[]', '[]', 'unsupported']
    ]) {
      await db.run('INSERT INTO card_cache (id, name, color_identity, cmc, types, subtypes, game) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, name, identity, cmc, types, subtypes, game]);
    }
    await db.run("INSERT INTO sets (id, name, printed_total) VALUES ('shared', 'Shared Set', 10), ('archive', 'Archive Set', 20)");
    for (const [card, price] of [['multi', 10], ['zero', 3], ['unknown', 0], ['land', 2], ['high', 7], ['archived', 20], ['legacy', 1000]]) {
      const archive = card === 'archived';
      await db.run('UPDATE card_cache SET price_trend = ?, set_id = ?, set_name = ?, rarity = ? WHERE id = ?',
        [price, archive ? 'archive' : 'shared', archive ? 'Archive Set' : 'Shared Set', archive ? 'Rare' : 'Common', card]);
    }
    for (const [card, quantity, inventory, added, user = owner] of [
      ['multi', 2, 'collection', '2025-09-30T23:30:00-01:00'],
      ['multi', 3, 'collection', '2026-09-01T00:30:00+01:00'],
      ['zero', 4, 'collection', '2026-09-02 12:00:00'],
      ['unknown', 5, 'collection', '2026-09-02 12:00:00'],
      ['land', 6, 'collection', '2026-09-02 12:00:00'],
      ['high', 7, 'arena', '2026-09-02 12:00:00'],
      ['zero', 1, 'collection', '2025-09-30 23:59:59'],
      ['multi', 100, 'wishlist', '2026-09-02 12:00:00'],
      ['multi', 11, 'graveyard', '2026-08-10 12:00:00'],
      ['land', 2, 'graveyard', '2025-10-05 12:00:00'],
      ['archived', 8, 'graveyard', '2026-09-22 12:00:00'],
      ['archived', 100, 'wishlist', '2026-09-02 12:00:00'],
      ['archived', 100, 'graveyard', '2026-09-02 12:00:00', other],
      ['legacy', 100, 'graveyard', '2026-09-02 12:00:00'],
      ['multi', 100, 'collection', '2026-09-02 12:00:00', other],
      ['legacy', 100, 'collection', '2026-09-02 12:00:00']
    ]) {
      await db.run('INSERT INTO collection (user_id, card_id, quantity, list_type, added_at, purchase_price) VALUES (?, ?, ?, ?, ?, 1)', [user, card, quantity, inventory, added]);
    }
    await db.run("INSERT INTO price_history (card_id, price, recorded_at) VALUES ('multi', 8, '2026-09-01 00:00:00'), ('multi', 12, '2026-09-20 00:00:00')");
    const decks = {};
    for (const [name, user, inventory, wins, losses, game = 'mtg'] of [
      ['Physical', owner, 'collection', 3, 1], ['Shared slots', owner, 'collection', 0, 0],
      ['Arena', owner, 'arena', 0, 2], ['Other user', other, 'collection', 99, 1],
      ['Legacy', owner, 'collection', 99, 1, 'unsupported'], ['Empty deck', empty, 'collection', 0, 0]
    ]) {
      decks[name] = (await db.run('INSERT INTO decks (name, user_id, inventory_type, wins, losses, game) VALUES (?, ?, ?, ?, ?, ?)', [name, user, inventory, wins, losses, game])).lastID;
    }
    for (const [deck, card, quantity] of [
      ['Physical', 'multi', 2], ['Physical', 'zero', 1], ['Physical', 'land', 4],
      ['Physical', 'uncached', 3], ['Shared slots', 'multi', 4], ['Arena', 'high', 2],
      ['Other user', 'multi', 99], ['Legacy', 'multi', 99]
    ]) {
      await db.run('INSERT INTO deck_cards (deck_id, card_id, quantity) VALUES (?, ?, ?)', [decks[deck], card, quantity]);
    }
    const performance = [
      { id: decks.Arena, name: 'Arena', inventory_type: 'arena', wins: 0, losses: 2, games: 2, winRate: 0 },
      { id: decks['Shared slots'], name: 'Shared slots', inventory_type: 'collection', wins: 0, losses: 0, games: 0, winRate: null },
      { id: decks.Physical, name: 'Physical', inventory_type: 'collection', wins: 3, losses: 1, games: 4, winRate: 75 }
    ];
    for (const inventory of ['all', 'collection', 'arena']) {
      const physical = inventory !== 'arena';
      const arena = inventory !== 'collection';
      const response = await stats(owner, inventory);
      const result = response.analytics;
      assert.strictEqual(response.summary.archivedCards, 0);
      assert.strictEqual(response.summary.physicalCards, physical ? 21 : 0);
      assert.strictEqual(response.summary.digitalCards, arena ? 7 : 0);
      assert.strictEqual(response.summary.totalCards, (physical ? 21 : 0) + (arena ? 7 : 0));
      assert.strictEqual(response.summary.unsortedCount, physical ? 21 : 0);
      assert.strictEqual(response.summary.totalValue, (physical ? 77 : 0) + (arena ? 49 : 0));
      assert.strictEqual(response.summary.totalSpent, response.summary.totalCards);
      assert.deepStrictEqual(response.setProgress, [{
        setId: 'shared', setName: 'Shared Set', ownedUnique: inventory === 'all' ? 5 : physical ? 4 : 1,
        totalCards: 10, percent: inventory === 'all' ? 50 : physical ? 40 : 10
      }]);
      for (const card of [...response.topValuable, ...response.recentAdditions]) {
        assert.ok((inventory === 'all' ? ['collection', 'arena'] : [inventory]).includes(card.list_type));
        assert.notStrictEqual(card.card_id, 'legacy');
      }
      const history = await stats(owner, inventory, '/stats/history');
      assert.deepStrictEqual(history.map(point => point.value),
        [67, 67, 67, 87, 87, 87, 87].map(value => (physical ? value : 0) + (arena ? 49 : 0)));
      assert.deepStrictEqual(result.growth, months.map((month, i) => ({
        month, physical: physical ? ({ 0: 2, 10: 3, 11: 15 }[i] || 0) : 0,
        arena: arena && i === 11 ? 7 : 0, graveyard: 0
      })));
      assert.deepStrictEqual(result.deckPerformance, performance.filter(deck => inventory === 'all' || deck.inventory_type === inventory));
      assert.deepStrictEqual(result.colors, distribution(colorNames,
        { ...(physical ? { White: 5, Green: 5, Blue: 6, Colorless: 5, Unknown: 5 } : {}), ...(arena ? { Red: 7 } : {}) },
        { ...(physical ? { White: 6, Green: 6, Blue: 4, Colorless: 1, Unknown: 3 } : {}), ...(arena ? { Red: 2 } : {}) }
      ));
      assert.deepStrictEqual(result.mana, distribution(manaNames,
        { ...(physical ? { 0: 5, 2: 5, Unknown: 5 } : {}), ...(arena ? { '7+': 7 } : {}) },
        { ...(physical ? { 0: 1, 2: 6, Unknown: 3 } : {}), ...(arena ? { '7+': 2 } : {}) }
      ));
    }
    const graveyard = await stats(owner, 'graveyard');
    assert.deepStrictEqual({
      totalCards: graveyard.summary.totalCards,
      archivedCards: graveyard.summary.archivedCards,
      physicalCards: graveyard.summary.physicalCards,
      digitalCards: graveyard.summary.digitalCards,
      unsortedCount: graveyard.summary.unsortedCount,
      uniqueCards: graveyard.summary.uniqueCards,
      totalValue: graveyard.summary.totalValue,
      totalSpent: graveyard.summary.totalSpent
    }, {
      totalCards: 21, archivedCards: 21, physicalCards: 0, digitalCards: 0,
      unsortedCount: 0, uniqueCards: 3, totalValue: 274, totalSpent: 21
    });
    assert.deepStrictEqual(graveyard.analytics, {
      growth: months.map((month, i) => ({ month, physical: 0, arena: 0, graveyard: { 0: 2, 10: 11, 11: 8 }[i] || 0 })),
      deckPerformance: [],
      colors: distribution(colorNames, { White: 11, Green: 11, Blue: 2, Black: 8 }),
      mana: distribution(manaNames, { 2: 11, 5: 8 })
    });
    assert.deepStrictEqual(graveyard.types, [
      { name: 'Creature', value: 11 }, { name: 'Land', value: 2 }, { name: 'Enchantment', value: 8 }
    ]);
    assert.deepStrictEqual(graveyard.rarities, [{ name: 'Common', value: 13 }, { name: 'Rare', value: 8 }]);
    assert.deepStrictEqual(graveyard.sets, [
      { id: 'archive', name: 'Archive Set', count: 8, value: 160 },
      { id: 'shared', name: 'Shared Set', count: 13, value: 114 }
    ]);
    assert.deepStrictEqual(graveyard.setProgress, [
      { setId: 'shared', setName: 'Shared Set', ownedUnique: 2, totalCards: 10, percent: 20 },
      { setId: 'archive', setName: 'Archive Set', ownedUnique: 1, totalCards: 20, percent: 5 }
    ]);
    assert.deepStrictEqual(graveyard.recentAdditions.map(card => [card.card_id, card.quantity, card.list_type]), [
      ['archived', 8, 'graveyard'], ['multi', 11, 'graveyard'], ['land', 2, 'graveyard']
    ]);
    assert.deepStrictEqual(graveyard.topValuable.map(card => [card.card_id, card.quantity, card.list_type]), [
      ['archived', 8, 'graveyard'], ['multi', 11, 'graveyard'], ['land', 2, 'graveyard']
    ]);
    assert.deepStrictEqual((await stats(owner, 'graveyard', '/stats/history')).map(point => point.value),
      [92, 92, 92, 136, 136, 136, 296]);
    assert.deepStrictEqual((await stats(empty)).analytics, {
      ...blank,
      deckPerformance: [{ id: decks['Empty deck'], name: 'Empty deck', inventory_type: 'collection', wins: 0, losses: 0, games: 0, winRate: null }]
    });
    assert.deepStrictEqual((await stats(empty, 'arena')).analytics, blank);
    const emptyArchive = await stats(empty, 'graveyard');
    assert.deepStrictEqual(emptyArchive.analytics, blank);
    assert.strictEqual(emptyArchive.summary.totalCards, 0);
    assert.strictEqual(emptyArchive.summary.archivedCards, 0);
    assert.deepStrictEqual(emptyArchive.topValuable, []);
    assert.deepStrictEqual(emptyArchive.recentAdditions, []);
    assert.deepStrictEqual(emptyArchive.setProgress, []);
    assert.deepStrictEqual((await stats(empty, 'graveyard', '/stats/history')).map(point => point.value), [0, 0, 0, 0, 0, 0, 0]);
  } finally {
    Date.now = realNow;
    await new Promise(resolve => db.dbConnection.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main()
  .then(() => console.log('Stats analytics regression passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
