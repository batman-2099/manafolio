const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-mtg-colors-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { getSortCategory, sortCards } = require('../src/utils/compartmentSort');
const { BASIC_LAND_COLORS, normalizeMtgColorIdentity } = require('../src/utils/mtgColors');
const { normalizeCard, cacheCards } = require('../src/scryfallApi');

async function testBasicLandSort() {
  try {
    for (const [name, color] of Object.entries(BASIC_LAND_COLORS)) {
      assert.deepStrictEqual(normalizeMtgColorIdentity([], `Basic Land — ${name}`, name), [color]);
      const normalized = normalizeCard({ id: name, name, colors: [], type_line: `Basic Land — ${name}` });
      assert.deepStrictEqual(normalized.types, [color]);
      assert.strictEqual(getSortCategory(normalized, [{ by: 'color', divider: true }]), color);
      const land = { name, supertype: 'MTG', types: [], subtypes: ['Basic', 'Land', name], color_identity: [color] };
      for (const by of ['color', 'color_identity']) {
        assert.strictEqual(getSortCategory(land, [{ by, divider: true }]), 'Colorless');
      }
    }
    const nick = { name: 'Nick Fury, Director of S.H.I.E.L.D.', types: ['White'], color_identity: ['W', 'U', 'B', 'R', 'G'] };
    const land = { name: 'Plains', types: [], color_identity: ['W'] };
    const multicolor = { name: 'Azorius Card', types: '["W","U"]', color_identity: ['W', 'U'] };
    for (const by of ['color', 'color_identity']) {
      const scheme = [{ by, divider: true }];
      assert.strictEqual(getSortCategory(nick, scheme), 'White');
      assert.strictEqual(getSortCategory(multicolor, scheme), 'Multicolor');
      for (const types of [['W'], '["White"]', 'White', '"W"']) {
        assert.strictEqual(getSortCategory({ ...nick, types }, scheme), 'White');
      }
      for (const types of [[], '[]', '', null, undefined]) {
        assert.strictEqual(getSortCategory({ ...nick, types }, scheme), 'Colorless');
      }
      assert.deepStrictEqual(sortCards([land, multicolor, nick], scheme).map(card => card.name),
        [nick.name, multicolor.name, land.name]);
    }
    await db.initDb();
    for (const [type_line, produced_mana, expected] of [
      ['Land', ['W', 'U'], ['White', 'Blue']],
      ['Land', ['C', 'R', 'G', 'R'], ['Red', 'Green']],
      ['Land', ['W', 'U', 'B', 'R', 'G'], ['White', 'Blue', 'Black', 'Red', 'Green']],
      ['Land', ['C', 'U'], []],
      ['Land', ['U', 'U'], []],
      ['Land', ['C'], []],
      ['Land', undefined, []],
      ['Artifact', ['W', 'U'], []],
    ]) {
      const card = normalizeCard({ id: 'mana-land', name: 'Sample producer', type_line, produced_mana, colors: [], color_identity: ['U'] });
      assert.deepStrictEqual(card.types, expected);
      assert.deepStrictEqual(card.color_identity, ['Blue'], 'mana production must not replace Commander identity');
      assert.strictEqual(getSortCategory(card, [{ by: 'color' }]), expected.length > 1 ? 'Multicolor' : 'Colorless');
      await cacheCards([card]);
      assert.deepStrictEqual(JSON.parse((await db.get("SELECT types FROM card_cache WHERE id = 'mtg-mana-land'")).types), expected);
    }
    for (const name of ['Snow-Covered Forest', 'Forest Bear', 'Island Sanctuary', 'swamp']) {
      assert.deepStrictEqual(normalizeCard({ id: name, name, colors: [] }).types, [], 'only exact basic land names receive an override');
    }
    await db.run("INSERT INTO card_cache (id, name, game, types) VALUES ('non-magic', 'Forest', 'other', '[]'), ('near-name', 'Snow-Covered Forest', 'mtg', '[]')");
    for (const [name] of Object.entries(BASIC_LAND_COLORS)) {
      await db.run('INSERT INTO card_cache (id, name, subtypes, game, color_identity) VALUES (?, ?, ?, ?, ?)', [
        `mtg-${name.toLowerCase()}`, name, JSON.stringify(['Basic', 'Land', name]), 'mtg', '[]'
      ]);
    }
    await db.initDb();
    for (const [name, color] of Object.entries(BASIC_LAND_COLORS)) {
      const row = await db.get('SELECT color_identity, types FROM card_cache WHERE id = ?', [`mtg-${name.toLowerCase()}`]);
      assert.strictEqual(row.color_identity, JSON.stringify([color]));
      assert.deepStrictEqual(JSON.parse(row.types), [color], 'startup repairs cached exact-name land colors');
      await cacheCards([normalizeCard({ id: name.toLowerCase(), name, colors: [], type_line: `Basic Land — ${name}` })]);
      assert.deepStrictEqual(JSON.parse((await db.get('SELECT types FROM card_cache WHERE id = ?', [`mtg-${name.toLowerCase()}`])).types),
        [color], 'provider refresh retains the requested color');
    }
    assert.deepStrictEqual((await db.all("SELECT types FROM card_cache WHERE id IN ('non-magic', 'near-name')")).map(row => row.types), ['[]', '[]'],
      'startup leaves other games and non-exact names unchanged');
  } finally {
    try { db.dbConnection.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch { /* not present */ }
    }
  }
}

testBasicLandSort()
  .then(() => console.log('MTG basic land sort self-check passed'))
  .catch(error => { console.error(error); process.exitCode = 1; });
