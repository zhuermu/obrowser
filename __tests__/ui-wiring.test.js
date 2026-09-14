/**
 * Guards the wiring a storage type needs across the UI and the main process.
 *
 * Adding a provider touches five places (dropdown, form save switch, the
 * type-name maps, the badge colour, the factory). Missing one produces a
 * connection that silently saves without credentials or shows a raw type id, so
 * these checks are asserted statically instead of by clicking through Electron.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf-8');
const StorageClientFactory = require('../storage-clients/StorageClientFactory');

/** Storage types offered by the connection dialog. */
function optionTypes() {
  const select = /<select[^>]*id="storageType"[\s\S]*?<\/select>/.exec(html);
  expect(select).not.toBeNull();
  return [...select[0].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
}

const types = optionTypes();

describe('storage type wiring', () => {
  test('the dropdown lists the expected providers', () => {
    expect(types).toEqual(['aws-s3', 'azure-blob', 'aliyun-oss', 'gcs']);
  });

  test('every dropdown type is registered in the client factory', () => {
    const supported = StorageClientFactory.getSupportedClientTypes();
    for (const type of types) {
      expect(supported).toContain(type);
    }
  });

  test('every dropdown type has a branch in the save handler', () => {
    for (const type of types) {
      expect(renderer).toContain(`case '${type}':`);
    }
  });

  test('every type has a badge colour so the label stays readable', () => {
    for (const type of types) {
      expect(html).toContain(`.connection-type-${type} {`);
    }
  });

  test('badge labels come from one shared map, aligned on the AWS "S3" style', () => {
    const map = /const STORAGE_TYPE_LABELS = \{[\s\S]*?\};/.exec(renderer);
    expect(map).not.toBeNull();
    expect(map[0]).toContain("'aws-s3': 'S3'");
    expect(map[0]).toContain("'azure-blob': 'ABS'");
    expect(map[0]).toContain("'aliyun-oss': 'OSS'");
    expect(map[0]).toContain("'gcs': 'GCS'");
    for (const type of types) {
      expect(map[0]).toContain(`'${type}':`);
    }
  });

  test('no render site hardcodes its own type-to-label chain', () => {
    // A per-site ternary chain is what silently labelled GCS connections "S3".
    expect(renderer).not.toMatch(/type === 'aws-s3' \? 'S3'/);
    expect(html).not.toMatch(/type === 'aws-s3' \? 'S3'/);
    // Both render paths must go through the shared helper.
    expect(renderer).toContain('window.storageTypeLabel = storageTypeLabel;');
    expect(html).toContain('window.storageTypeLabel(connection.type)');
  });

  test('Copy Path uses each provider native URI scheme, not always s3://', () => {
    const map = /const STORAGE_PATH_SCHEMES = \{[\s\S]*?\};/.exec(renderer);
    expect(map).not.toBeNull();
    expect(map[0]).toContain("'aws-s3': 's3'");
    expect(map[0]).toContain("'gcs': 'gs'");
    expect(map[0]).toContain("'aliyun-oss': 'oss'");
    // No literal s3:// template left in the copy-path handlers.
    expect(renderer).not.toMatch(/`s3:\/\/\$\{/);
  });

  test('the retired pcg type is gone from the UI but still loadable', () => {
    expect(html).not.toContain('value="pcg"');
    expect(renderer).not.toContain("case 'pcg':");
    // A connection saved by an older build must not hard-fail...
    expect(StorageClientFactory.getSupportedClientTypes()).toContain('pcg');
    // ...and gets migrated to aws-s3 on load.
    expect(renderer).toContain("if (conn.type === 'pcg')");
  });

  test('provider-specific fields are hidden by default in CSS', () => {
    for (const type of types) {
      // Without this rule the fields of every provider show at once.
      expect(html).toContain(`#connectionForm .form-group.${type},`);
    }
  });

  test('common form groups stay visible for every type', () => {
    // updateFormFields decides "common" by excluding all provider classes; a
    // missing entry would hide that provider's own fields.
    const guards = [...renderer.matchAll(/classList\.contains\('aws-s3'\)/g)];
    expect(guards.length).toBeGreaterThanOrEqual(3);
    for (const type of types) {
      expect(renderer).toContain(`classList.contains('${type}')`);
    }
  });
});

describe("local credential guidance", () => {
  test('the AWS profile field is a dropdown, not a free-text box', () => {
    // Typing a profile name from memory is the thing this replaces.
    expect(html).toMatch(/<select[^>]*id="awsProfile"/);
    expect(html).not.toMatch(/<input[^>]*id="awsProfile"/);
  });

  test('AWS profile has refresh, status and an SSO sign-in control', () => {
    expect(html).toContain('onclick="refreshAwsProfiles()"');
    expect(html).toContain('onclick="awsSsoLogin()"');
    expect(html).toContain('id="awsProfileStatus"');
    expect(html).toContain('onchange="checkAwsProfileStatus()"');
  });

  test('GCS ADC has a status line and a gcloud sign-in control', () => {
    expect(html).toContain('id="gcsAdcStatus"');
    expect(html).toContain('onclick="gcloudAdcLogin()"');
    expect(html).toContain('onclick="refreshGcloudAdcStatus()"');
    expect(html).toContain('gcs-auth-adc');
  });

  test('the ADC block is hidden by default and toggled with the auth method', () => {
    expect(html).toContain('#connectionForm .form-group.gcs-auth-adc');
    expect(renderer).toContain("document.querySelectorAll('#connectionForm .gcs-auth-adc')");
    // It must not be force-shown by the generic edit loop either.
    expect(renderer).toContain("!field.classList.contains('gcs-auth-adc')");
  });

  test('all four inline handlers are exposed on window', () => {
    for (const fn of ['refreshAwsProfiles', 'checkAwsProfileStatus', 'awsSsoLogin',
                      'refreshGcloudAdcStatus', 'gcloudAdcLogin']) {
      expect(renderer).toContain(`window.${fn} = ${fn};`);
    }
  });

  test('the profile dropdown is populated before the saved value is selected', () => {
    // Assigning .value on an empty <select> silently does nothing.
    expect(renderer).toContain("refreshAwsProfiles(connection.profile || '')");
    expect(renderer).not.toContain("if (profileEl) profileEl.value = connection.profile");
  });

  test('the SSO login IPC validates the profile against the discovered list', () => {
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
    // Prevents a crafted value becoming an extra CLI argument.
    expect(main).toContain('isKnownProfileName(profileName, profiles)');
    // And the child process must not go through a shell.
    expect(main).toContain('shell: false');
  });
});

describe('GCS form fields', () => {
  test('the key file picker and auth method are present', () => {
    expect(html).toContain('id="gcsAuthMethod"');
    expect(html).toContain('id="gcsKeyFilename"');
    expect(html).toContain('id="gcsProjectId"');
    expect(html).toContain('onclick="browseGcsKeyFile()"');
  });

  test('the picker handlers are exposed to inline HTML handlers', () => {
    // Inline onclick/onchange attributes resolve against `window`.
    expect(renderer).toContain('window.browseGcsKeyFile = browseGcsKeyFile;');
    expect(renderer).toContain('window.updateGcsAuthFields = updateGcsAuthFields;');
  });

  test('the key file input is editable, not readonly', () => {
    // A readonly input renders greyed out and looks broken/disabled.
    const input = /<input[^>]*id="gcsKeyFilename"[^>]*>/.exec(html);
    expect(input).not.toBeNull();
    expect(input[0]).not.toContain('readonly');
  });

  test('auth-method subgroups are not force-shown by the generic edit loop', () => {
    // editConnection re-shows every .form-group of the selected type; if the
    // auth subgroups are included, the GCS key file stays visible under ADC.
    expect(renderer).toContain("!field.classList.contains('gcs-auth-sa')");
    expect(renderer).toContain("!field.classList.contains('aws-auth-profile')");
    // ...and the per-method visibility is re-applied afterwards.
    expect(renderer).toMatch(/storageType === 'gcs' && typeof updateGcsAuthFields === 'function'/);
  });

  test('GCS save is validated so the required key file is enforced', () => {
    expect(renderer).toMatch(/Please select the service account JSON key file/);
  });

  test('GCS uses its own endpoint input so AWS defaults cannot leak in', () => {
    expect(html).toContain('id="gcs_endpoint"');
    // The shared #endpoint input gets provider default values assigned to it.
    const gcsEndpointDiv = /<div class="gcs">\s*<input[^>]*id="gcs_endpoint"/.test(html);
    expect(gcsEndpointDiv).toBe(true);
  });

  test('the key file path is stored, not the key material', () => {
    expect(renderer).toContain('connection.keyFilename');
    // The private key itself must never be copied into the connection profile.
    expect(renderer).not.toContain('connection.privateKey');
    expect(renderer).not.toContain('connection.credentialsJson');
  });
});
