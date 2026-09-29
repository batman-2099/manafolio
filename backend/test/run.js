// Runs every unit test in test/, discovered rather than listed.
//
// Non-recursive on purpose: test/e2e has its own runner (test/e2e/run.js), because
// those suites need a live server and a pinned admin password.
//
// Every file is a plain assert script, so a child that exits 0 passed and anything
// else failed. One child process each, which is also the isolation the two tests
// that used to be invoked separately (bootstrapowner, scanlang) were getting.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Clear throwaway databases a previous run left behind.
//
// Each test names its temp database after its own process.pid, and it deletes the
// file on the way out — but not if it was killed, and Windows recycles PIDs freely.
// A stale file means the next test to draw that PID calls initDb against a database
// that ALREADY has an admin user and collection rows, and then fails an assertion
// about how many rows it can see. That is a test failure describing nothing but a
// dirty temp directory, which is the fastest way to teach people to ignore a suite.
//
// Matched tightly — `manafolio-<name>-<digits>.db` in the OS temp dir, plus its WAL
// sidecars — because that is exactly the shape the tests generate and nothing else.
function clearStaleTestDatabases() {
  const dir = os.tmpdir();
  const shape = /^manafolio-[a-z-]+-\d+\.db(-wal|-shm)?$/i;
  let cleared = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!shape.test(name)) continue;
    try { fs.unlinkSync(path.join(dir, name)); cleared++; } catch { /* locked or gone */ }
  }
  if (cleared) console.log(`Cleared ${cleared} stale test database file(s) from ${dir}.`);
}
clearStaleTestDatabases();

const TEST_DIR = __dirname;
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('No test files found in test/ — that is a broken checkout, not a pass.');
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const { status } = spawnSync(process.execPath, [path.join(TEST_DIR, file)], { stdio: 'inherit' });
  if (status !== 0) failed.push(file);
  console.log(`${status === 0 ? 'PASS' : 'FAIL'}: ${file}`);
}

console.log(`\n${files.length - failed.length}/${files.length} unit test files passed.`);
if (failed.length) {
  console.error(`Failed: ${failed.join(', ')}`);
  process.exit(1);
}
