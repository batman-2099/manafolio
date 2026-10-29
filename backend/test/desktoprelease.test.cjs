// The release workflows run on Ubuntu with Bash and jq; no registry/API calls here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/docker-build.yml'), 'utf8');
function script(name) {
  const step = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(step >= 0, name);
  const start = workflow.indexOf('        run: |\n', step) + '        run: |\n'.length;
  const lines = [];
  for (const line of workflow.slice(start).split('\n')) {
    if (!line.startsWith('          ')) break;
    lines.push(line.slice(10));
  }
  assert.ok(lines.length, name);
  return lines.join('\n');
}
const check = script('Check stable release eligibility');
const promote = script('Promote current stable release to latest');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manafolio-release-'));
const output = path.join(directory, 'output');
function run(source, tag, release) {
  return execFileSync('bash', ['-e', '-o', 'pipefail', '-c', `
    gh() { printf '%s' "$RELEASE_JSON"; }
    docker() { printf 'DOCKER %s\\n' "$*"; }
    ${source}
  `], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: 'Owner/Manafolio', GITHUB_REF_NAME: tag, RELEASE_JSON: JSON.stringify(release) } });
}
try {
  const stable = { tag_name: 'v2.4.2', draft: false, prerelease: false };
  for (const [tag, release, eligible] of [
    ['v2.4.2', stable, true],
    ['v2.4.1', stable, false],
    ['v2.5.0-rc.1', { ...stable, tag_name: 'v2.5.0-rc.1' }, false],
    ['v2.4.2', { ...stable, prerelease: true }, false],
    ['v2.4.2', { ...stable, draft: true }, false],
  ]) {
    fs.writeFileSync(output, '');
    run(check, tag, release);
    assert.equal(fs.readFileSync(output, 'utf8').includes('eligible=true'), eligible, tag);
  }
  assert.match(run(promote, 'v2.4.2', stable), /DOCKER buildx imagetools create -t ghcr.io\/owner\/manafolio:latest ghcr.io\/owner\/manafolio:2.4.2/);
  assert.doesNotMatch(run(promote, 'v2.4.1', stable), /DOCKER/, 'a stale queued release cannot promote after a newer release becomes current');
  console.log('Release policy rejects old/prerelease promotion and rechecks current stable eligibility before promotion.');
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
