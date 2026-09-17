const path = require('path');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const pkg = require('../package.json');
const lock = require('../package-lock.json');

describe('release packaging boundary', () => {
  const root = path.resolve(__dirname, '..');
  const matcher = new FileMatcher(root, '/unused-release-target', value => value, pkg.build.files);
  const included = file => matcher.createFilter()(path.join(root, file), { isDirectory: () => false });

  test('the manifest and lockfile share the release version', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[''].version).toBe(pkg.version);
  });

  test.each(['.env', '.env.production', '.env.example', '.aws/credentials', '.codex/config.toml',
    '.agents/local.json', '.azurite/credentials.json', 'service-account.json',
    'dist/mac/OBrowser.app/Contents/Resources/app.asar', 'scripts/notarize-images.cjs', '__tests__/ui-wiring.test.js'])
  ('excludes local configuration and non-runtime file: %s', file => {
    expect(included(file)).toBe(false);
  });

  test.each(['main.js', 'renderer.js', 'transfers-ui.js', 'download-manager.js', 'upload-progress.js',
    'index.html', 'ui.css', 'obrowser.svg', 'storage-clients/AWSS3Client.js'])
  ('includes runtime file: %s', file => {
    expect(included(file)).toBe(true);
  });

  test('audits every package before signing or uploading for notarization', () => {
    expect(pkg.build.afterPack).toBe('scripts/check-package.cjs');
  });
});
