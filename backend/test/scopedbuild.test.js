// A scoped catalog build must be ADDITIVE.
//
// The catalog is one file per (game, language), and embedPhase writes exactly the
// rows it embedded. So a build scoped to one set has to carry every other set's
// vectors forward, or "build Bloomburrow" silently deletes the Foundations
// vectors built last week — a data-loss bug that looks like a successful build
// and only shows up as scans failing for sets the user knows they built.
//
// The inverse matters just as much: an UNSCOPED build must NOT carry rows
// forward, because it has just walked every card_cache row for that language, so
// anything left over is a card that no longer exists. Keeping it leaves a vector
// that can win a scan and then resolve to no card at all.
const assert = require('assert');

process.env.DB_PATH = require('path').join(
  require('os').tmpdir(), `manafolio-scoped-${process.pid}.db`
);

const { keptFromPrev } = require('../src/catalog');

const vec = (n) => new Float32Array([n, n, n]);
const prev = {
  vecs: new Map([
    ['mtg-fdn-1', vec(1)],   // built last week, out of scope this time
    ['mtg-fdn-2', vec(2)],   // ditto
    ['mtg-blb-1', vec(3)],   // in scope now, re-embedded below
  ]),
  srcs: new Map([
    ['mtg-fdn-1', 'https://img/fdn1.jpg'],
    ['mtg-fdn-2', 'https://img/fdn2.jpg'],
    ['mtg-blb-1', 'https://img/blb1-old.jpg'],
  ]),
};

// This build embedded Bloomburrow only.
const kept = keptFromPrev(prev, ['mtg-blb-1', 'mtg-blb-2']);
const keptIds = kept.map(k => k.id).sort();

assert.deepStrictEqual(keptIds, ['mtg-fdn-1', 'mtg-fdn-2'],
  'the sets NOT in scope must be carried forward');
// The freshly embedded card must not be duplicated — it is already in `ids`, and a
// second copy would be a stale vector competing with the new one.
assert.ok(!keptIds.includes('mtg-blb-1'), 'a re-embedded card must not be carried forward');
// srcs travels with the vector, or the next build cannot tell the art is unchanged
// and re-embeds everything it just kept.
assert.strictEqual(kept.find(k => k.id === 'mtg-fdn-1').src, 'https://img/fdn1.jpg');
assert.deepStrictEqual([...kept.find(k => k.id === 'mtg-fdn-2').vec], [2, 2, 2],
  'the carried vector must be the previous one, unchanged');

// Nothing in scope: everything is carried (a stopped build must not wipe the file).
assert.strictEqual(keptFromPrev(prev, []).length, 3);
// Everything in scope: nothing to carry.
assert.strictEqual(keptFromPrev(prev, ['mtg-fdn-1', 'mtg-fdn-2', 'mtg-blb-1']).length, 0);

console.log('scopedbuild.test.js: all 6 assertions passed');
