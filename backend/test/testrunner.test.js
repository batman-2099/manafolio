const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-runner-check-'));
try {
  const foreign = path.join(root, 'manafolio-foreign-12345.db');
  fs.writeFileSync(foreign, 'another running suite owns this file');
  for (const runner of ['run.js', 'e2e/run.js']) {
    const directory = path.join(root, runner === 'run.js' ? 'unit' : 'e2e');
    fs.mkdirSync(directory);
    fs.copyFileSync(path.join(__dirname, runner), path.join(directory, 'run.js'));
    fs.writeFileSync(path.join(directory, 'owned.test.js'), `
      const fs = require('fs'), os = require('os'), path = require('path');
      const temp = os.tmpdir();
      if (path.dirname(process.env.DB_PATH) !== temp) throw new Error('database escaped owned directory');
      fs.writeFileSync(process.env.DB_PATH, 'owned database');
      fs.writeFileSync(process.env.RECEIPT, temp);
      process.stdout.write('PASS: F1-');
      setTimeout(() => {
        process.stdout.write('TC1\\nPASS: F12-TC345\\n');
        process.stderr.write('FAIL: F1-');
        setTimeout(() => process.stderr.write('TC2\\n'), 10);
      }, 10);
      process.exitCode = Number(process.env.FAIL_FIXTURE);
    `);
    for (const failure of [0, 1]) {
      const receipt = path.join(directory, 'receipt');
      const result = spawnSync(process.execPath, [path.join(directory, 'run.js')], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, RECEIPT: receipt, FAIL_FIXTURE: String(failure) },
      });
      assert.strictEqual(result.status, failure, result.stdout + result.stderr);
      if (runner === 'e2e/run.js') {
        assert.match(result.stdout, new RegExp('Passed suites: ' + (failure ? 0 : 1) + ' / 1'));
        assert.match(result.stdout, new RegExp('Failed suites: ' + failure + ' / 1'));
        assert.doesNotMatch(result.stdout, /(?:Passed|Failed|Total) test cases:/, 'only exit-code suite totals are reported');
        assert.match(result.stdout, /PASS: F1-TC1/, 'split stdout remains visible');
        assert.match(result.stderr, /FAIL: F1-TC2/, 'split stderr remains visible');
      }
      assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'another running suite owns this file');
      const owned = fs.readFileSync(receipt, 'utf8');
      assert.notStrictEqual(owned, root);
      assert.strictEqual(path.dirname(owned), root);
      assert.strictEqual(fs.existsSync(owned), false, 'owned files are cleaned after success or failure');
    }
  }
  console.log('test runners preserve foreign files and clean their own temporary directories');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
