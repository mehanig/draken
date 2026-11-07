const fs = require('node:fs');

function releaseVersion({ event, ref, input, version, lockVersion, lockRootVersion }) {
  const requested = event === 'workflow_dispatch' && ref === 'refs/heads/master' ? input
    : event === 'push' && ref.startsWith('refs/tags/v') ? ref.slice('refs/tags/v'.length) : '';
  if (typeof requested !== 'string' || requested.trim() !== requested || !/^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(requested)) {
    throw new Error('Release requires a strict stable version and a master dispatch or version tag.');
  }
  if (requested !== version || requested !== lockVersion || requested !== lockRootVersion) throw new Error('Release version must already match committed package.json and package-lock.json.');
  return requested;
}
module.exports = { releaseVersion };
if (require.main === module) {
  try {
    const version = releaseVersion({ event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF || '', input: process.env.RELEASE_VERSION,
      version: require('../package.json').version, lockVersion: require('../package-lock.json').version, lockRootVersion: require('../package-lock.json').packages?.['']?.version });
    if (!process.env.GITHUB_OUTPUT) throw new Error('GitHub output file is required.');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
    console.log(`Validated release ${version}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
