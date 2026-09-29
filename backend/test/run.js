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

// Each invocation owns its temporary files; never sweep another run's databases.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-unit-'));
const testEnv = { ...process.env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir };

const TEST_DIR = __dirname;
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js'))
  .sort();

const failed = [];
try {
  if (!files.length) throw new Error('No test files found in test/');
  for (const file of files) {
    const { status } = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
      stdio: 'inherit',
      env: { ...testEnv, DB_PATH: path.join(tempDir, `${file}.db`) },
    });
    if (status !== 0) failed.push(file);
    console.log(`${status === 0 ? 'PASS' : 'FAIL'}: ${file}`);
  }
  console.log(`\n${files.length - failed.length}/${files.length} unit test files passed.`);
  if (failed.length) {
    console.error(`Failed: ${failed.join(', ')}`);
    process.exitCode = 1;
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
