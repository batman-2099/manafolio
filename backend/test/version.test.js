// Runnable check for the update-check version comparison. The whole feature
// hinges on "1.4.9" being OLDER than "1.4.10", which a string compare gets
// backwards. No framework — plain node + assert.
// Run: `node test/version.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-version-${process.pid}.db`);
const { isNewer } = require('../src/routes/settings');

// [candidate, current, expected]
const CASES = [
  ['1.4.43', '1.4.42', true],
  ['1.4.42', '1.4.42', false],
  ['1.4.41', '1.4.42', false],
  ['1.4.10', '1.4.9', true, 'double-digit patch beats single digit'],
  ['1.4.9', '1.4.10', false, 'string compare would call this newer'],
  ['1.5.0', '1.4.99', true, 'minor outranks patch'],
  ['2.0.0', '1.9.9', true, 'major outranks minor'],
  ['v1.4.43', '1.4.42', true, 'a leading v from the git tag is tolerated'],
  ['1.5', '1.4.42', true, 'missing patch segment counts as zero'],
  ['1.4', '1.4.0', false, 'missing patch segment equals .0'],
];

for (const [candidate, current, expected, why] of CASES) {
  assert.strictEqual(
    isNewer(candidate, current), expected,
    `isNewer(${candidate}, ${current}) should be ${expected}${why ? ` — ${why}` : ''}`
  );
}

console.log(`version.test.js: all ${CASES.length} assertions passed`);
process.exit(0);
