const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const TEST_DIR = __dirname;
const files = fs.readdirSync(TEST_DIR)
  .filter(f => f.endsWith('.test.js') && f !== 'run.js')
  .sort();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-e2e-'));

let passedSuites = 0;
let failedSuites = 0;

async function runTestFile(file) {
  return new Promise((resolve) => {
    console.log(`\n=========================================`);
    console.log(`RUNNING TEST SUITE: ${file}`);
    console.log(`=========================================`);
    
    // Every suite drives the API as the 'admin' account. initDb only seeds that
    // account when a password is pinned — a real fresh install gets its owner
    // from the setup wizard instead, and a headless test has no browser.
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], {
      env: {
        ...process.env, DEFAULT_ADMIN_PASSWORD: 'test-admin-password',
        TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
        DB_PATH: path.join(tempDir, `${file}.db`),
      },
    });
    
    child.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(output);
    });

    child.stderr.on('data', (data) => {
      const output = data.toString();
      process.stderr.write(output);
    });
    child.on('error', error => {
      console.error(`FAIL: ${file} could not start: ${error.message}`);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`PASS: ${file} executed successfully.`);
        passedSuites++;
      } else {
        console.error(`FAIL: ${file} exited with code ${code}.`);
        failedSuites++;
      }
      
      resolve();
    });
  });
}

async function main() {
  console.log(`Discovered ${files.length} E2E test files under ${TEST_DIR}.`);
  if (!files.length) throw new Error('No E2E test files found');
  for (const file of files) {
    await runTestFile(file);
  }
  
  console.log(`\n=========================================`);
  console.log(`E2E TEST RUNNER RESULT SUMMARY:`);
  console.log(`  Passed suites: ${passedSuites} / ${files.length}`);
  console.log(`  Failed suites: ${failedSuites} / ${files.length}`);
  console.log(`=========================================`);
  
  process.exitCode = failedSuites > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Unhandled runner error:', err);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
