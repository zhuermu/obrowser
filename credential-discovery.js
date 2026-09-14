/**
 * Local credential discovery for the connection dialog.
 *
 * Both AWS SSO profiles and Google ADC already live on the user's machine, so
 * the dialog should offer what is there and report whether it is still valid,
 * instead of asking people to type a profile name from memory or hunt for a
 * JSON key file.
 *
 * Everything here is pure (no fs/network) so it can be unit tested; the main
 * process supplies file contents and existence checks.
 */

/**
 * Parse an AWS-style INI file into `{ section: { key: value } }`.
 * Comments (`#` / `;`), blank lines and indented continuation values are handled
 * the way the AWS CLI treats them; unknown junk is skipped rather than throwing.
 *
 * @param {string} text - File contents
 * @returns {Object} Parsed sections
 */
function parseIni(text) {
  const sections = {};
  if (!text || typeof text !== 'string') return sections;

  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      sections[current] = sections[current] || {};
      continue;
    }

    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key) sections[current][key] = value;
  }
  return sections;
}

/**
 * Work out how a profile obtains credentials, so the UI can explain what a
 * given entry will do (and whether an SSO sign-in is what unblocks it).
 *
 * @param {Object} section - Parsed profile section
 * @returns {string} 'sso' | 'assume-role' | 'process' | 'static' | 'unknown'
 */
function classifyAwsProfile(section = {}) {
  if (section.sso_session || section.sso_start_url || section.sso_account_id) return 'sso';
  if (section.role_arn) return 'assume-role';
  if (section.credential_process) return 'process';
  if (section.aws_access_key_id) return 'static';
  return 'unknown';
}

const SOURCE_LABELS = {
  sso: 'AWS IAM Identity Center (SSO)',
  'assume-role': 'AssumeRole',
  process: 'credential_process',
  static: 'Static access key',
  unknown: 'No credential source'
};

/**
 * List the profiles available from the shared AWS config/credentials files.
 *
 * `[default]` in config is the `default` profile, `[profile X]` is `X`, and
 * `[sso-session Y]` is a shared SSO session rather than a profile, so it must
 * not be offered as one. Sections in the credentials file are profiles directly.
 *
 * @param {Object} files
 * @param {string} [files.configText] - Contents of ~/.aws/config
 * @param {string} [files.credentialsText] - Contents of ~/.aws/credentials
 * @returns {Array<Object>} Profiles with `{ name, source, sourceLabel, region, ssoSession }`
 */
function listAwsProfiles({ configText = '', credentialsText = '' } = {}) {
  const config = parseIni(configText);
  const credentials = parseIni(credentialsText);
  const byName = new Map();

  const add = (name, section) => {
    const existing = byName.get(name) || {};
    const merged = { ...existing.section, ...section };
    const source = classifyAwsProfile(merged);
    byName.set(name, {
      section: merged,
      name,
      source,
      sourceLabel: SOURCE_LABELS[source],
      region: merged.region || '',
      ssoSession: merged.sso_session || ''
    });
  };

  for (const [rawName, section] of Object.entries(config)) {
    if (/^sso-session\s+/.test(rawName)) continue; // shared SSO session, not a profile
    if (/^services\s+/.test(rawName)) continue;
    const name = rawName === 'default' ? 'default' : rawName.replace(/^profile\s+/, '');
    add(name, section);
  }
  for (const [name, section] of Object.entries(credentials)) {
    add(name, section);
  }

  return [...byName.values()]
    .map(({ section, ...rest }) => rest)
    .sort((a, b) => (a.name === 'default' ? -1 : b.name === 'default' ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Locate a CLI binary. A GUI app launched from Finder inherits a minimal PATH
 * (typically /usr/bin:/bin:/usr/sbin:/sbin), so `aws` and `gcloud` installed via
 * Homebrew or the Google SDK installer are not findable without looking.
 *
 * @param {string} name - Executable name, e.g. 'gcloud'
 * @param {Function} isExecutable - Predicate testing an absolute path
 * @param {Object} [env] - Environment, used for PATH and HOME
 * @returns {string|null} Absolute path, or null when not installed
 */
function findExecutable(name, isExecutable, env = process.env) {
  const home = env.HOME || '';
  const fixed = [
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    `${home}/google-cloud-sdk/bin/${name}`,
    `/opt/homebrew/share/google-cloud-sdk/bin/${name}`,
    `/usr/local/share/google-cloud-sdk/bin/${name}`,
    `${home}/.local/bin/${name}`
  ];
  const fromPath = (env.PATH || '').split(':').filter(Boolean).map(dir => `${dir}/${name}`);

  for (const candidate of [...fromPath, ...fixed]) {
    try {
      if (isExecutable(candidate)) return candidate;
    } catch (error) {
      // Unreadable directory — keep looking.
    }
  }
  return null;
}

/**
 * Describe a Google Application Default Credentials file.
 *
 * The distinction that matters to this app is whether the credential can sign
 * URLs: preview and download hand a signed URL to the browser, and a plain user
 * account has no private key to sign with.
 *
 * @param {Object|null} json - Parsed ADC file, or null when absent
 * @returns {Object} `{ present, type, account, canSignUrls, description }`
 */
function describeAdcCredential(json) {
  if (!json || typeof json !== 'object') {
    return {
      present: false,
      type: null,
      account: null,
      canSignUrls: false,
      description: 'Not signed in'
    };
  }

  const type = json.type || 'unknown';
  if (type === 'service_account') {
    return {
      present: true,
      type,
      account: json.client_email || null,
      canSignUrls: true,
      description: `Service account ${json.client_email || '(unknown)'}`
    };
  }
  if (type === 'impersonated_service_account') {
    // Signing works through the IAM signBlob API.
    const target = /serviceAccounts\/([^:/]+)/.exec(json.service_account_impersonation_url || '');
    return {
      present: true,
      type,
      account: target ? target[1] : null,
      canSignUrls: true,
      description: `Impersonating ${target ? target[1] : 'a service account'}`
    };
  }
  if (type === 'authorized_user') {
    return {
      present: true,
      type,
      account: json.account || null,
      canSignUrls: false,
      description: 'User account (cannot sign preview/download URLs)'
    };
  }
  return {
    present: true,
    type,
    account: null,
    canSignUrls: false,
    description: `Unrecognised credential type: ${type}`
  };
}

/**
 * Validate that a profile name came from the discovered list before it is used
 * as a CLI argument, so a crafted value cannot inject extra flags.
 *
 * @param {string} name - Candidate profile name
 * @param {Array<Object>} profiles - Discovered profiles
 * @returns {boolean} True when the name is safe to pass through
 */
function isKnownProfileName(name, profiles) {
  if (typeof name !== 'string' || !name) return false;
  if (name.startsWith('-')) return false;
  return profiles.some(p => p.name === name);
}

module.exports = {
  parseIni,
  classifyAwsProfile,
  listAwsProfiles,
  findExecutable,
  describeAdcCredential,
  isKnownProfileName,
  SOURCE_LABELS
};
