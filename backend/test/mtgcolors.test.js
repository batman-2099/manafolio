const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), `manafolio-mtg-colors-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('../src/db');
const { getSortCategory } = require('../src/utils/compartmentSort');
const { BASIC_LAND_COLORS, normalizeMtgColorIdentity } = require('../src/utils/mtgColors');

async function testBasicLandSort() {
  try {
    for (const [name, color] of Object.entries(BASIC_LAND_COLORS)) {
      assert.deepStrictEqual(normalizeMtgColorIdentity([], `Basic Land — ${name}`, name), [color]);
      const land = { name, supertype: 'MTG', subtypes: ['Basic', 'Land', name], color_identity: [color] };
      assert.strictEqual(getSortCategory(land, [{ by: 'color', divider: true }]), color);
    }
    await db.initDb();
    for (const [name] of Object.entries(BASIC_LAND_COLORS)) {
      await db.run('INSERT INTO card_cache (id, name, subtypes, game, color_identity) VALUES (?, ?, ?, ?, ?)', [
        `mtg-${name.toLowerCase()}`, name, JSON.stringify(['Basic', 'Land', name]), 'mtg', '[]'
      ]);
    }
    await db.initDb();
    for (const [name, color] of Object.entries(BASIC_LAND_COLORS)) {
      const row = await db.get('SELECT color_identity FROM card_cache WHERE id = ?', [`mtg-${name.toLowerCase()}`]);
      assert.strictEqual(row.color_identity, JSON.stringify([color]));
    }
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
