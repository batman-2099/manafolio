const assert = require('node:assert/strict');
const { aliases, promote } = require('../scripts/promote-docker.cjs');

const stable = tag_name => ({ tag_name, draft: false, prerelease: false });
const current = stable('v2.4.2');
const old = stable('v2.4.1');
const nextMinor = stable('v2.5.0');
const prerelease = { ...stable('v2.4.9'), prerelease: true };
const draft = { ...stable('v2.4.8'), draft: true };
const rc = stable('v2.4.10-rc.1');
const releases = [old, prerelease, draft, rc, current];
assert.deepEqual(aliases(current.tag_name, current, releases), ['latest', '2.4']);
assert.deepEqual(aliases(old.tag_name, current, releases), [], 'old patches cannot roll back either alias');
assert.deepEqual(aliases(current.tag_name, nextMinor, [...releases, nextMinor]), ['2.4'], 'older minor lines still get their newest stable patch');
for (const release of [prerelease, draft, rc]) {
  assert.deepEqual(aliases(release.tag_name, release, releases), [], 'prereleases and drafts never promote');
}
assert.deepEqual(aliases('v2.4.3', stable('v2.4.3'), releases), [], 'unpublished tags never promote');
assert.deepEqual(aliases(current.tag_name, { ...current, prerelease: true }, releases), ['2.4']);
assert.deepEqual(aliases(current.tag_name, { ...current, draft: true }, releases), ['2.4']);
assert.deepEqual(aliases('v2.4.9', stable('v2.4.10'), [stable('v2.4.9'), stable('v2.4.10')]), [], 'patches compare numerically');

function promotion(tag, latest, pages) {
  const calls = [];
  const eligible = promote({ tag, repository: 'Owner/Manafolio' }, (command, args) => {
    calls.push([command, ...args]);
    if (command === 'gh') return JSON.stringify(args.at(-1).endsWith('/latest') ? latest : pages);
    assert.equal(command, 'docker');
  });
  return { eligible, calls };
}
const promoted = promotion(current.tag_name, current, [[old], [current]]);
assert.deepEqual(promoted.calls.at(-1), ['docker', 'buildx', 'imagetools', 'create', '-t', 'ghcr.io/owner/manafolio:latest', '-t', 'ghcr.io/owner/manafolio:2.4', 'ghcr.io/owner/manafolio:2.4.2']);
assert.deepEqual(promoted.calls[1], ['gh', 'api', '--paginate', '--slurp', 'repos/Owner/Manafolio/releases?per_page=100']);
const stale = promotion(old.tag_name, current, [[old], [current]]);
assert.deepEqual(stale.eligible, []);
assert.ok(stale.calls.every(([command]) => command !== 'docker'), 'a stale queued run must recheck both aliases');
assert.deepEqual(promotion(current.tag_name, nextMinor, [[nextMinor], releases]).eligible, ['2.4']);
assert.deepEqual(promotion(rc.tag_name, rc, [releases]).calls, []);
const failedCalls = [];
assert.throws(() => promote({ tag: current.tag_name, repository: 'Owner/Manafolio' }, command => {
  failedCalls.push(command);
  throw new Error('API unavailable');
}), /API unavailable/);
assert.deepEqual(failedCalls, ['gh'], 'API errors must not publish aliases');
console.log('Release policy preserves latest and minor aliases across stale runs, pagination, drafts, and prereleases.');
