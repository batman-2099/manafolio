// Run a catalog build from the command line.
//
// The same job the Admin → Scan catalogs button runs, for when a full build is
// better started from a terminal: a first MTG build downloads tens of
// thousands of card images and takes hours, and a browser tab is a poor place to
// keep that alive.
//
// Usage, from backend/:
//   node scripts/build-catalog.mjs --game mtg
//   node scripts/build-catalog.mjs --game mtg --skip-cache   # embed what is cached
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('../src/db');
const catalog = require('../src/catalog');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const game = arg('--game', 'mtg');
if (game !== 'mtg') throw new Error('Unsupported game');
const lang = arg('--lang', 'English');
const skipCache = process.argv.includes('--skip-cache');

async function main() {
  await db.initDb();
  catalog.start(game, lang, { skipCache });

  // Poll the same in-memory state the admin panel polls, so the two report
  // identically and there is only one definition of progress.
  let lastLine = '';
  for (;;) {
    const s = catalog.state();
    if (!s) break;
    const line = `[${s.phase}] ${s.done}/${s.total || '?'} ${s.message || ''}`;
    if (line !== lastLine) { console.log(line); lastLine = line; }
    await new Promise(r => setTimeout(r, 2000));
  }
  const done = catalog.lastResult();
  console.log(`\n${done ? `${done.phase}: ${done.message}` : 'finished'}`);
  process.exit(done && done.phase === 'error' ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
