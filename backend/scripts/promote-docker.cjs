// Run only inside the workflow's serialized alias-promotion job. Full version
// tags are published independently; queued runs must fetch eligibility again.
const { execFileSync } = require('node:child_process');

function stableVersion(release) {
  if (release?.draft !== false || release?.prerelease !== false) return null;
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(release.tag_name);
}

function aliases(tag, latest, releases) {
  const current = releases.find(release => release.tag_name === tag && stableVersion(release));
  const version = stableVersion(current);
  if (!version) return [];
  const result = [];
  if (latest?.tag_name === tag && stableVersion(latest)) result.push('latest');
  const newerPatch = releases.some(release => {
    const other = stableVersion(release);
    return other && other[1] === version[1] && other[2] === version[2] && BigInt(other[3]) > BigInt(version[3]);
  });
  if (!newerPatch) result.push(`${version[1]}.${version[2]}`);
  return result;
}

function promote({ tag, repository }, run = execFileSync) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) return [];
  const options = { encoding: 'utf8' };
  const latest = JSON.parse(run('gh', ['api', `repos/${repository}/releases/latest`], options));
  // Do not assume API order is semver order, or that a minor's newest patch is
  // on the first page. Any API failure aborts without changing aliases.
  const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`], options)).flat();
  const eligible = aliases(tag, latest, releases);
  if (eligible.length) {
    const image = `ghcr.io/${repository.toLowerCase()}`;
    run('docker', ['buildx', 'imagetools', 'create', ...eligible.flatMap(alias => ['-t', `${image}:${alias}`]), `${image}:${tag.slice(1)}`], { stdio: 'inherit' });
  }
  return eligible;
}

module.exports = { aliases, promote };
if (require.main === module) promote({ tag: process.env.GITHUB_REF_NAME, repository: process.env.GITHUB_REPOSITORY });
