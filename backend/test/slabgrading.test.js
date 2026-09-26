// Runnable checks for graded-slab support (PSA cert lookup + collection grading).
//
// Nothing here touches the network. PSA meters its public API per token and a cert
// costs a request, so the client is exercised against a recorded payload and a
// stubbed transport — which is also the only way to test the failure branches
// (401, 404, an empty 200) without holding four deliberately-broken tokens.
//
// The behaviours worth locking down, in the order they bite:
//   1. A cert is cached forever and the cache hit needs NO token. Break this and
//      every collection view re-bills PSA for grades that cannot change.
//   2. 'AUTHENTIC' has no numeric grade. Parsing it as 0 makes an ungraded slab
//      sort below a PSA 1 and display as a grade the card never received.
//   3. grader 'Raw' clears grade and cert. Otherwise a cracked slab keeps a grade
//      it no longer claims, and every read depends on which column it consults.
//   4. One cert cannot be entered twice, and quantity cannot multiply a slab.
//
// No framework — plain node + assert. Run: `node test/slabgrading.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-slab-${process.pid}.db`);
// initDb only seeds the 'admin' user when this is set — the wizard creates the
// owner account otherwise, and these tests want a user id 1 to exist.
process.env.DEFAULT_ADMIN_PASSWORD = 'test-admin-password';

const db = require('../src/db');
const psaApi = require('../src/psaApi');

// Synthetic Magic certificate in PSA's documented response shape.
const CERTIFICATE = {
  PSACert: {
    CertNumber: '82613901',
    Year: '1993',
    Brand: 'MAGIC THE GATHERING',
    Subject: 'BLACK LOTUS',
    Category: 'TCG CARDS',
    CardNumber: '232',
    VarietyPedigree: 'ALPHA',
    CardGrade: 'MINT 9',
    TotalPopulation: 1234,
    PopulationHigher: 567,
  },
};

(async () => {
  await db.initDb();

  // --- 1. Grade parsing --------------------------------------------------------
  assert.strictEqual(psaApi.parseGrade('GEM MT 10'), 10);
  assert.strictEqual(psaApi.parseGrade('MINT 9'), 9);
  assert.strictEqual(psaApi.parseGrade('NM-MT 8'), 8);
  assert.strictEqual(psaApi.parseGrade('MINT 9.5'), 9.5, 'half grades exist on BGS/CGC labels');
  // The one that matters: a genuine, encapsulated, UNGRADED card. Null, not 0.
  assert.strictEqual(psaApi.parseGrade('AUTHENTIC'), null, 'AUTHENTIC is not a grade of zero');
  assert.strictEqual(psaApi.parseGrade('AUTHENTIC ALTERED'), null);
  assert.strictEqual(psaApi.parseGrade(''), null);
  assert.strictEqual(psaApi.parseGrade(null), null);

  // --- 2. Cert numbers normalize to digits ------------------------------------
  // Users read these off a label and type them with spaces. cert_number is the
  // cache's primary key, so '8261 3901' must not become a second row for one slab.
  assert.strictEqual(psaApi.normalizeCertNumber('8261 3901'), '82613901');
  assert.strictEqual(psaApi.normalizeCertNumber('#82613901'), '82613901');
  assert.strictEqual(psaApi.normalizeCertNumber('abc'), '');

  // --- 3. PSA's label shorthand becomes something searchable ------------------
  assert.strictEqual(psaApi.searchableName('LIGHTNING BOLT-FOIL'), 'LIGHTNING BOLT');
  assert.strictEqual(psaApi.searchableName('BLACK LOTUS (ALPHA)'), 'BLACK LOTUS');

  // --- 4. normalizeCert reads the documented shape ----------------------------
  const norm = psaApi.normalizeCert(CERTIFICATE, '82613901');
  assert.strictEqual(norm.grader, 'PSA');
  assert.strictEqual(norm.grade, 9);
  assert.strictEqual(norm.grade_label, 'MINT 9');
  assert.strictEqual(norm.subject, 'BLACK LOTUS');
  assert.strictEqual(norm.card_number, '232');
  assert.strictEqual(norm.population, 1234);
  // Casing is read tolerantly, because PSA's has moved before and a cert costs a
  // request — a renamed field must not silently blank every stored cert.
  const camel = psaApi.normalizeCert({ psaCert: { certNumber: '1', cardGrade: 'GEM MT 10', subject: 'SOL RING' } }, '1');
  assert.strictEqual(camel.grade, 10, 'camelCase response still parses');
  assert.strictEqual(camel.subject, 'SOL RING');

  // --- 5. A cached cert resolves with NO token --------------------------------
  // The whole reason psa_cert has no staleness check. If this regresses, the app
  // starts demanding a token to display grades it already knows.
  await db.run(`INSERT OR REPLACE INTO psa_cert (cert_number, payload) VALUES (?, ?)`,
    ['82613901', JSON.stringify(CERTIFICATE)]);
  const cached = await psaApi.lookupCert('8261 3901', ''); // no token, spaced input
  assert.strictEqual(cached.cached, true, 'must come from cache');
  assert.strictEqual(cached.grade, 9);

  // An UNKNOWN cert with no token is a setup error, not a lookup failure — the
  // two need different words, so the status must distinguish them.
  await assert.rejects(
    () => psaApi.lookupCert('99999999', ''),
    (e) => e.status === 400 && /token/i.test(e.message),
    'uncached + no token must say the token is missing'
  );
  await assert.rejects(() => psaApi.lookupCert('', 'tok'), (e) => e.status === 400);

  // --- 6. Failure branches map to the status the route passes through ---------
  const realGet = psaApi.client.get;
  const failWith = (status) => { psaApi.client.get = async () => { const e = new Error('x'); e.response = { status }; throw e; }; };
  try {
    failWith(401);
    await assert.rejects(() => psaApi.lookupCert('11111111', 'bad'), (e) => e.status === 401);
    failWith(404);
    await assert.rejects(() => psaApi.lookupCert('22222222', 'tok'), (e) => e.status === 404);
    failWith(429);
    await assert.rejects(() => psaApi.lookupCert('33333333', 'tok'), (e) => e.status === 429);

    // A 200 carrying nothing useful. PSA answers this for some unknown numbers
    // instead of 404, and caching it would bake a permanent "no such card" in for
    // what is probably a typo.
    psaApi.client.get = async () => ({ data: { PSACert: {} } });
    await assert.rejects(() => psaApi.lookupCert('44444444', 'tok'), (e) => e.status === 404);
    const leaked = await db.get(`SELECT cert_number FROM psa_cert WHERE cert_number = '44444444'`);
    assert.strictEqual(leaked, undefined, 'an empty response must not be cached');

    // A good response IS cached, and the second call spends no request.
    let calls = 0;
    psaApi.client.get = async () => { calls++; return { data: CERTIFICATE }; };
    await db.run(`DELETE FROM psa_cert WHERE cert_number = '82613901'`);
    const fresh = await psaApi.lookupCert('82613901', 'tok');
    assert.strictEqual(fresh.cached, false);
    assert.strictEqual(calls, 1);
    const again = await psaApi.lookupCert('82613901', 'tok');
    assert.strictEqual(again.cached, true);
    assert.strictEqual(calls, 1, 'a second lookup must not hit the network');
  } finally {
    psaApi.client.get = realGet;
  }

  // --- 7. The collection columns and their constraints -----------------------
  const cols = await db.all(`PRAGMA table_info(collection)`);
  for (const c of ['grader', 'grade', 'cert_number']) {
    assert.ok(cols.some(x => x.name === c), `collection must have ${c}`);
  }
  assert.strictEqual(cols.find(x => x.name === 'grade').type, 'REAL', 'grade must be REAL for half grades');

  const user = await db.get(`SELECT id FROM users LIMIT 1`);
  await db.run(`INSERT OR REPLACE INTO card_cache (id, name, game) VALUES ('test-slab-card', 'Black Lotus', 'mtg')`);
  const add = (grader, grade, cert) => db.run(
    `INSERT INTO collection (card_id, user_id, quantity, grader, grade, cert_number) VALUES ('test-slab-card', ?, 1, ?, ?, ?)`,
    [user.id, grader, grade, cert]
  );

  // The CHECK constraint is the last line of defence if a route forgets to validate.
  await assert.rejects(() => add('NGA', 9, null), /CHECK|constraint/i, 'unknown grader must be rejected');

  // One cert, one slab. The partial unique index is what makes a second entry an
  // error rather than a second copy.
  await add('PSA', 9, '82613901');
  await assert.rejects(() => add('PSA', 9, '82613901'), /UNIQUE|constraint/i, 'a cert cannot be entered twice');
  // Different grader, same digits: not a duplicate. PSA and CGC number
  // independently, so the index is on the pair.
  await add('CGC', 9.5, '82613901');

  // Raw rows are the overwhelming majority and have no cert — a non-partial UNIQUE
  // would have collapsed them into one, which is why the index carries a WHERE.
  await add('Raw', null, null);
  await add('Raw', null, null);
  await add('Raw', null, null);
  const raws = await db.get(`SELECT COUNT(*) n FROM collection WHERE card_id = 'test-slab-card' AND grader = 'Raw'`);
  assert.strictEqual(raws.n, 3, 'many raw copies must coexist');

  await db.run(`DELETE FROM collection WHERE card_id = 'test-slab-card'`);
  await db.run(`DELETE FROM card_cache WHERE id = 'test-slab-card'`);

  // Exercise the mounted cert endpoint, including provider dispatch and rejection.
  const express = require('express');
  const scryfall = require('../src/scryfallApi');
  const lorcast = require('../src/lorcastApi');
  const originalSearch = scryfall.searchCards;
  const originalLorcanaSearch = lorcast.searchCards;
  scryfall.searchCards = async ({ name, number }) => {
    assert.strictEqual(name, 'BLACK LOTUS');
    assert.strictEqual(number, '232');
    return { cards: [{ id: 'mtg-cert-match', name: 'Black Lotus', game: 'mtg' }] };
  };
  lorcast.searchCards = async ({ name, number }) => {
    assert.strictEqual(name, 'MICKEY MOUSE');
    assert.strictEqual(number, '1');
    return { cards: [{ id: 'lorcana-cert-match', name: 'Mickey Mouse', game: 'lorcana' }] };
  };
  for (const [number, brand, subject] of [
    ['55555555', 'DISNEY LORCANA', 'MICKEY MOUSE'],
    ['66666666', 'UNSUPPORTED GAME', 'Unsupported Card'],
  ]) {
    await db.run('INSERT INTO psa_cert (cert_number, payload) VALUES (?, ?)',
      [number, JSON.stringify({ PSACert: { ...CERTIFICATE.PSACert, CertNumber: number, Brand: brand, Subject: subject, CardNumber: '1' } })]);
  }
  const app = express();
  app.use((req, _res, next) => { req.user = { id: user.id }; next(); });
  app.use('/api', require('../src/routes/collection'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/collection/cert`;
  try {
    for (const [cert, game, card] of [
      ['82613901', 'mtg', 'mtg-cert-match'], ['55555555', 'lorcana', 'lorcana-cert-match'],
    ]) {
      const response = await fetch(`${base}/${cert}`);
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.strictEqual(body.game, game);
      assert.strictEqual(body.cert.grade, 9);
      assert.strictEqual(body.candidates[0].id, card);
    }
    assert.strictEqual((await fetch(`${base}/66666666`)).status, 400);
  } finally {
    scryfall.searchCards = originalSearch;
    lorcast.searchCards = originalLorcanaSearch;
    await new Promise(resolve => server.close(resolve));
  }

  console.log('slabgrading self-check passed');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
