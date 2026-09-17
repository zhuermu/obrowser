// Notarize and staple release DMGs, without echoing credentials in commands/errors.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const pkg = require('../package.json');
const env = { ...process.env, ...dotenv.parse(fs.readFileSync(path.join(__dirname, '..', '.env'))) };
const secrets = [env.APPLE_ID, env.APPLE_APP_SPECIFIC_PASSWORD].filter(Boolean);
const redact = value => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('xcrun', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', () => reject(new Error('Could not launch xcrun.')));
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(redact(output))));
  });
}

(async () => {
  if (!env.APPLE_ID || !env.APPLE_APP_SPECIFIC_PASSWORD) throw new Error('Apple notarization credentials are not configured.');
  const files = process.argv.slice(2);
  if (!files.length) throw new Error('Provide one or more release DMG paths.');
  for (const file of files) {
    if (path.extname(file) !== '.dmg' || !fs.statSync(file).isFile()) throw new Error('Expected an existing DMG file.');
    console.log(`Submitting ${path.basename(file)} for notarization…`);
    const output = await run(['notarytool', 'submit', path.resolve(file),
      '--apple-id', env.APPLE_ID, '--password', env.APPLE_APP_SPECIFIC_PASSWORD,
      '--team-id', pkg.build.mac.notarize.teamId, '--wait', '--output-format', 'json']);
    const result = JSON.parse(output.trim());
    if (result.status !== 'Accepted') throw new Error(`Notarization status: ${result.status}; submission: ${result.id}`);
    console.log(`Accepted: ${result.id}`);
    await run(['stapler', 'staple', path.resolve(file)]);
    await run(['stapler', 'validate', path.resolve(file)]);
    console.log(`PASS notarized and stapled: ${path.basename(file)}`);
  }
})().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
