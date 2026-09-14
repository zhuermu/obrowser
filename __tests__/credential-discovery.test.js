/**
 * Tests for local credential discovery: the AWS profile list offered in the
 * dialog, the Google ADC description, and the CLI lookup that a Finder-launched
 * app needs because it inherits almost no PATH.
 */

const {
  parseIni,
  classifyAwsProfile,
  listAwsProfiles,
  findExecutable,
  describeAdcCredential,
  isKnownProfileName
} = require('../credential-discovery');

// Shaped after a real ~/.aws/config using IAM Identity Center.
const AWS_CONFIG = `
[default]
region = us-east-1

[profile AdministratorAccess-767828766472]
sso_session = vscode
sso_account_id = 767828766472
sso_role_name = AdministratorAccess
region = us-east-1

[sso-session vscode]
sso_start_url = https://d-9067da612e.awsapps.com/start
sso_region = us-east-1

[profile build-role]
role_arn = arn:aws:iam::1234:role/Build
source_profile = default

[profile helper]
credential_process = /usr/local/bin/creds --json
`;

const AWS_CREDENTIALS = `
# a comment
[legacy-keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret
`;

describe('parseIni', () => {
  test('parses sections, ignores comments and blank lines', () => {
    const parsed = parseIni('[a]\n# note\n; note2\nk = v\n\n[b]\nx=1\n');
    expect(parsed).toEqual({ a: { k: 'v' }, b: { x: '1' } });
  });

  test('values containing = are preserved', () => {
    expect(parseIni('[a]\nurl = https://x/y?a=b&c=d\n').a.url).toBe('https://x/y?a=b&c=d');
  });

  test('keys before any section header are ignored', () => {
    expect(parseIni('stray = 1\n[a]\nk=v')).toEqual({ a: { k: 'v' } });
  });

  test('empty or non-string input yields an empty object', () => {
    expect(parseIni('')).toEqual({});
    expect(parseIni(undefined)).toEqual({});
    expect(parseIni(null)).toEqual({});
  });
});

describe('classifyAwsProfile', () => {
  test.each([
    [{ sso_session: 'x' }, 'sso'],
    [{ sso_start_url: 'x' }, 'sso'],
    [{ role_arn: 'x', source_profile: 'y' }, 'assume-role'],
    [{ credential_process: 'x' }, 'process'],
    [{ aws_access_key_id: 'x' }, 'static'],
    [{ region: 'us-east-1' }, 'unknown'],
    [{}, 'unknown']
  ])('%o -> %s', (section, expected) => {
    expect(classifyAwsProfile(section)).toBe(expected);
  });
});

describe('listAwsProfiles', () => {
  const profiles = listAwsProfiles({ configText: AWS_CONFIG, credentialsText: AWS_CREDENTIALS });
  const names = profiles.map(p => p.name);

  test('finds profiles from both config and credentials', () => {
    expect(names).toEqual([
      'default',
      'AdministratorAccess-767828766472',
      'build-role',
      'helper',
      'legacy-keys'
    ]);
  });

  test('an sso-session block is not offered as a profile', () => {
    // `[sso-session vscode]` is a shared session, not something you can select.
    expect(names).not.toContain('vscode');
    expect(names).not.toContain('sso-session vscode');
  });

  test('the "profile " prefix is stripped but default is kept as-is', () => {
    expect(names).toContain('AdministratorAccess-767828766472');
    expect(names).toContain('default');
    expect(names.every(n => !n.startsWith('profile '))).toBe(true);
  });

  test('each profile is classified so the UI can explain it', () => {
    const byName = Object.fromEntries(profiles.map(p => [p.name, p]));
    expect(byName['AdministratorAccess-767828766472'].source).toBe('sso');
    expect(byName['AdministratorAccess-767828766472'].sourceLabel).toMatch(/Identity Center/);
    expect(byName['build-role'].source).toBe('assume-role');
    expect(byName.helper.source).toBe('process');
    expect(byName['legacy-keys'].source).toBe('static');
    expect(byName.default.region).toBe('us-east-1');
  });

  test('default sorts first', () => {
    expect(names[0]).toBe('default');
  });

  test('no config files yields an empty list rather than throwing', () => {
    expect(listAwsProfiles({})).toEqual([]);
    expect(listAwsProfiles()).toEqual([]);
  });
});

describe('findExecutable', () => {
  test('finds a binary in a Homebrew location absent from PATH', () => {
    // The Finder-launch case: PATH is /usr/bin:/bin only.
    const exists = (p) => p === '/opt/homebrew/share/google-cloud-sdk/bin/gcloud';
    expect(findExecutable('gcloud', exists, { PATH: '/usr/bin:/bin', HOME: '/Users/x' }))
      .toBe('/opt/homebrew/share/google-cloud-sdk/bin/gcloud');
  });

  test('prefers PATH when the binary is there', () => {
    const exists = () => true;
    expect(findExecutable('aws', exists, { PATH: '/custom/bin', HOME: '/Users/x' }))
      .toBe('/custom/bin/aws');
  });

  test('checks the SDK installed under the home directory', () => {
    const exists = (p) => p === '/Users/x/google-cloud-sdk/bin/gcloud';
    expect(findExecutable('gcloud', exists, { PATH: '', HOME: '/Users/x' }))
      .toBe('/Users/x/google-cloud-sdk/bin/gcloud');
  });

  test('returns null when not installed anywhere', () => {
    expect(findExecutable('gcloud', () => false, { PATH: '/usr/bin', HOME: '/Users/x' })).toBeNull();
  });

  test('a predicate that throws does not abort the search', () => {
    const exists = (p) => {
      if (p.startsWith('/usr/bin')) throw new Error('EACCES');
      return p === '/opt/homebrew/bin/aws';
    };
    expect(findExecutable('aws', exists, { PATH: '/usr/bin', HOME: '/Users/x' }))
      .toBe('/opt/homebrew/bin/aws');
  });
});

describe('describeAdcCredential', () => {
  test('a user account is reported as unable to sign URLs', () => {
    const d = describeAdcCredential({ type: 'authorized_user', account: 'me@example.com' });
    expect(d.present).toBe(true);
    expect(d.canSignUrls).toBe(false);
    expect(d.description).toMatch(/cannot sign/i);
  });

  test('a service account can sign', () => {
    const d = describeAdcCredential({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' });
    expect(d.canSignUrls).toBe(true);
    expect(d.account).toBe('sa@p.iam.gserviceaccount.com');
  });

  test('impersonation can sign, and the target is extracted', () => {
    const d = describeAdcCredential({
      type: 'impersonated_service_account',
      service_account_impersonation_url:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken'
    });
    expect(d.canSignUrls).toBe(true);
    expect(d.account).toBe('sa@p.iam.gserviceaccount.com');
  });

  test('absent credentials are reported as not signed in', () => {
    const d = describeAdcCredential(null);
    expect(d.present).toBe(false);
    expect(d.description).toBe('Not signed in');
  });

  test('an unknown type is surfaced rather than assumed signable', () => {
    const d = describeAdcCredential({ type: 'external_account' });
    expect(d.canSignUrls).toBe(false);
    expect(d.description).toMatch(/external_account/);
  });
});

describe('isKnownProfileName', () => {
  const profiles = [{ name: 'dev' }, { name: 'prod' }];

  test('accepts a discovered name', () => {
    expect(isKnownProfileName('dev', profiles)).toBe(true);
  });

  test('rejects anything not discovered', () => {
    expect(isKnownProfileName('other', profiles)).toBe(false);
    expect(isKnownProfileName('', profiles)).toBe(false);
    expect(isKnownProfileName(undefined, profiles)).toBe(false);
  });

  test('rejects values that would be read as CLI flags', () => {
    // Guards `aws sso login --profile <name>` against smuggled arguments.
    expect(isKnownProfileName('--debug', profiles)).toBe(false);
    expect(isKnownProfileName('-x', [{ name: '-x' }])).toBe(false);
  });
});
