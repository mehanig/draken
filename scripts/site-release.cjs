// Keep published-version website copy behind npm publication, not ahead of it.
const fs = require('node:fs');
const path = require('node:path');
function validateCopy(version, html) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !html.includes(`Version ${version} / Available on npm`)
    || !html.includes(`CHANGELOG.md#${version.replaceAll('.', '')}`)) throw Error('Website release copy does not match package.json');
}
async function waitForPublished(version, { fetcher = fetch, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 40 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetcher('https://registry.npmjs.org/draken/latest', { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
    if (response.ok && (await response.json()).version === version) return;
    if (!response.ok && response.status !== 404 && response.status !== 429 && response.status < 500) throw Error(`Registry lookup failed: HTTP ${response.status}`);
    if (attempt + 1 < attempts) await pause(30000);
  }
  throw Error(`npm latest is not ${version}; website deployment was withheld`);
}
module.exports = { validateCopy, waitForPublished };
if (require.main === module) {
  const root = path.join(__dirname, '..'), version = require(path.join(root, 'package.json')).version;
  Promise.resolve().then(() => {
    validateCopy(version, fs.readFileSync(path.join(root, 'site/index.html'), 'utf8'));
    return waitForPublished(version);
  }).then(() => console.log(`npm latest and website agree on ${version}`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
