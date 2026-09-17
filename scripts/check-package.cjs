// Run before signing/notarization, and again against release archives if needed.
const path = require('path');
const assert = require('assert/strict');
const asar = require('@electron/asar');
const { version } = require('../package.json');

function checkPackage(archive) {
  const entries = asar.listPackage(archive).map(entry => entry.replace(/^\//, ''));
  const forbidden = entries.filter(entry => /(^|\/)(\.env($|\.)|\.agents(\/|$)|\.codex(\/|$)|\.azurite(\/|$)|\.aws(\/|$))/.test(entry));
  assert.deepEqual(forbidden, [], 'Build must not contain environment files, credentials or local tool state');
  for (const entry of [
    'main.js', 'renderer.js', 'workspace-ui.js', 'transfers-ui.js', 'ui-icons.js',
    'index.html', 'ui.css', 'download-manager.js', 'upload-progress.js',
    'download-verifier.js', 'content-disposition.js', 'storage-clients/StorageClientFactory.js'
  ]) assert.ok(entries.includes(entry), `Missing runtime file: ${entry}`);
  for (const entry of ['uploads-ui.js', 'scripts', '__tests__', 'dist', 'docs', 'OBrowser_Logo_v1']) {
    assert.ok(!entries.includes(entry), `Non-runtime file was packaged: ${entry}`);
  }
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json').toString());
  assert.equal(metadata.version, version, 'Packaged version must match the release');
  const html = asar.extractFile(archive, 'index.html').toString();
  assert.ok(html.includes('transfers-ui.js') && html.includes('id="transferPanel"'), 'Packaged UI must include Transfers');
  console.log(`PASS package audit: ${path.relative(process.cwd(), archive)} (v${metadata.version}, no local environment files)`);
}

module.exports = async context => {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  checkPackage(path.join(resources, 'app.asar'));
};
module.exports.checkPackage = checkPackage;
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/check-package.cjs /path/to/app.asar');
  for (const archive of process.argv.slice(2)) checkPackage(archive);
}
