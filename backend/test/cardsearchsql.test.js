// Run: node test/cardsearchsql.test.js
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-searchsql-${process.pid}.db`);
const db = require('../src/db');
const { collectionQuery, localCacheQuery } = require('../src/utils/cardSearchSql');
const { normalizeSearchParams } = require('../src/routes/collection');

async function main() {
  await db.initDb();
  const user = (await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('search-owner', 'x', 'search-owner')")).lastID;
  const other = (await db.run("INSERT INTO users (username, password_hash, share_token) VALUES ('search-other', 'x', 'search-other')")).lastID;
  for (const [id, name, printed, number, game, language] of [
    ['mtg-en', 'Lightning Bolt', null, '4', 'mtg', 'English'],
    ['mtg-ja', 'Lightning Bolt', '稲妻', '004', 'mtg', 'Japanese'],
    ['mtg-promo', 'Promo One', null, 'A12', 'mtg', 'English'],
    ['mtg-other-promo', 'Promo Two', null, 'B49', 'mtg', 'English'],
    ['lorcana-card', 'Mickey Mouse', null, '4', 'lorcana', 'English'],
    ['mtg-private', 'Private Card', null, '8', 'mtg', 'English'],
    ['mtg-wishlist', 'Wishlist Card', null, '9', 'mtg', 'English'],
  ]) {
    await db.run('INSERT INTO card_cache (id, name, printed_name, number, game, language, set_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, name, printed, number, game, language, 'test']);
  }
  for (const [card, owner, qty, list] of [
    ['mtg-en', user, 2, 'collection'], ['mtg-en', user, 3, 'collection'],
    ['mtg-ja', user, 1, 'collection'], ['lorcana-card', user, 1, 'collection'],
    ['mtg-private', other, 5, 'collection'], ['mtg-wishlist', user, 7, 'wishlist'],
  ]) {
    await db.run('INSERT INTO collection (card_id, user_id, quantity, list_type) VALUES (?, ?, ?, ?)', [card, owner, qty, list]);
  }
  const query = ({ sql, params }) => db.all(sql, params);
  const owned = await query(collectionQuery('mtg', { userId: user, limit: 60, offset: 0 }));
  assert.deepStrictEqual(owned.map(row => [row.id, row.owned_qty]).sort(), [['mtg-en', 5], ['mtg-ja', 1]],
    'collection search includes owned languages, aggregates copies, and excludes other games, users and lists');
  assert.deepStrictEqual(await query(collectionQuery("mtg' OR 1=1 --", { userId: user, limit: 60, offset: 0 })), [],
    'the game parameter cannot widen collection access');

  const local = (options = {}) => query(localCacheQuery('mtg', { language: 'English', limit: 60, offset: 0, ...options }));
  for (const number of ['004', '4', '#4', '4/100']) {
    assert.deepStrictEqual((await local({ number })).map(row => row.id), ['mtg-en']);
    assert.deepStrictEqual((await local({ number, language: 'Japanese' })).map(row => row.id), ['mtg-ja']);
  }
  assert.deepStrictEqual((await local({ number: 'A12' })).map(row => row.id), ['mtg-promo'],
    'nonnumeric collector numbers must not all compare as zero');
  for (const name of ['Lightning Bolt', '稲妻']) {
    assert.deepStrictEqual((await local({ name, language: 'Japanese' })).map(row => row.id), ['mtg-ja'],
      'localized cards are searchable by either name');
  }
  assert.deepStrictEqual((await local({ name: 'Bolt', number: '004', setList: ['test'] })).map(row => row.id), ['mtg-en']);
  assert.deepStrictEqual(await local({ name: 'Bolt', number: '004', setList: ['other'] }), []);
  assert.deepStrictEqual(await local({ name: 'Bolt', limit: 1, offset: 1 }), [], 'pagination excludes the preceding result');

  assert.deepStrictEqual(normalizeSearchParams({ name: 'Lightning Bolt 5/64' }), { name: 'Lightning Bolt', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Lightning Bolt', number: '5/64' }), { name: 'Lightning Bolt', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: '5/64' }), { name: '', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: '#5' }), { name: '', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Lightning Bolt #5' }), { name: 'Lightning Bolt', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Lightning Bolt 5' }), { name: 'Lightning Bolt', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Lightning Bolt' }), { name: 'Lightning Bolt', number: '', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ q: 'Lightning Bolt 5/64' }), { name: 'Lightning Bolt', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ q: '5/64' }), { name: '', number: '5', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ name: 'Promo Card A107/A122' }), { name: 'Promo Card', number: 'A107', set: '' });
  assert.deepStrictEqual(normalizeSearchParams({ set: 'lea', number: '5/64' }), { name: '', number: '5', set: 'lea' });
  console.log('cardsearchsql.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
