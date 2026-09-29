// Runnable check for the global Scryfall rate-limit cooldown.
// A 429 means "everything you are sending is too much". Backing off only the
// request that got it leaves the rest of the queue firing at full rate, which
// keeps the penalty alive — that is what produced repeated 429s in the logs.
// This pins the fix: one 429 pauses EVERY subsequent Scryfall request.
// No framework — plain node + assert. Run: `node test/scryfallcooldown.test.js`
const assert = require('assert');
const os = require('os');
const path = require('path');

process.env.DB_PATH = path.join(os.tmpdir(), `manafolio-cooldown-${process.pid}.db`);
const scryfallApi = require('../src/scryfallApi');

const RETRY_AFTER_S = 1;
let calls = 0;
let rateLimitNext = true;

scryfallApi.client.defaults.adapter = async (config) => {
  calls++;
  if (rateLimitNext) {
    rateLimitNext = false;
    const err = new Error('Request failed with status code 429');
    err.response = { status: 429, headers: { 'retry-after': String(RETRY_AFTER_S) }, data: {}, config };
    throw err;
  }
  return { status: 200, statusText: 'OK', headers: {}, config, data: { object: 'list', data: [], has_more: false } };
};

async function main() {
  // 1. A 429 with Retry-After is absorbed: the call still succeeds, but only
  //    after waiting out the window rather than hammering straight through it.
  let t0 = Date.now();
  const first = await scryfallApi.scryGetRetried('/cards/search?q=a');
  let elapsed = Date.now() - t0;
  assert.strictEqual(first.status, 200, 'should recover after the cooldown');
  assert.ok(elapsed >= RETRY_AFTER_S * 1000 * 0.8,
    `retry should wait out Retry-After, waited only ${elapsed}ms`);
  assert.strictEqual(calls, 2, 'exactly one retry after the 429');

  // 2. The cooldown is GLOBAL. Trip it again, then fire an unrelated request:
  //    it must wait too, even though it never saw a 429 itself.
  rateLimitNext = true;
  const tripped = scryfallApi.scryGetRetried('/cards/search?q=b').catch(() => {});
  // Give the 429 a moment to land and arm the cooldown.
  await new Promise(r => setTimeout(r, 120));
  t0 = Date.now();
  await scryfallApi.scryGetRetried('/cards/search?q=c');
  elapsed = Date.now() - t0;
  await tripped;
  assert.ok(elapsed >= RETRY_AFTER_S * 1000 * 0.5,
    `an unrelated request must also wait out the cooldown, waited only ${elapsed}ms`);

  console.log('scryfallcooldown.test.js: all assertions passed');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
