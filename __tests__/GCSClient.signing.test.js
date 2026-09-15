/**
 * GCSClient signing + configuration tests.
 *
 * V4 signing with a service account key is a purely local operation, so these
 * run offline against the real @google-cloud/storage SDK using a throwaway RSA
 * key generated at test time (no real credentials involved).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GCSClient = require('../storage-clients/GCSClient');
const { guessContentType, enhanceGcsError } = GCSClient;

const BUCKET = 'obrowser-signing-test';
let credentials;
let keyFilePath;

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  credentials = {
    type: 'service_account',
    project_id: 'obrowser-test',
    private_key_id: 'testkeyid',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: 'obrowser@obrowser-test.iam.gserviceaccount.com',
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token'
  };

  keyFilePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obrowser-gcs-')), 'sa.json');
  fs.writeFileSync(keyFilePath, JSON.stringify(credentials), { mode: 0o600 });
});

afterAll(() => {
  if (keyFilePath) fs.rmSync(path.dirname(keyFilePath), { recursive: true, force: true });
});

async function clientFromJson() {
  const gcs = new GCSClient();
  await gcs.initialize({ authMethod: 'service-account', credentialsJson: JSON.stringify(credentials) });
  return gcs;
}

describe('GCS V4 signed URLs', () => {
  test('download URL is signed and forces an attachment', async () => {
    const gcs = await clientFromJson();
    const url = await gcs.getObjectUrl(BUCKET, 'clips/demo.mp4', 'download');
    const parsed = new URL(url);

    expect(parsed.hostname).toBe('storage.googleapis.com');
    expect(parsed.pathname).toBe(`/${BUCKET}/clips/demo.mp4`);
    expect(parsed.searchParams.get('X-Goog-Algorithm')).toBe('GOOG4-RSA-SHA256');
    expect(parsed.searchParams.get('X-Goog-Credential')).toContain(credentials.client_email);
    expect(parsed.searchParams.get('X-Goog-Credential')).toContain('/auto/storage/goog4_request');
    expect(parsed.searchParams.get('X-Goog-Expires')).toBe('3600');
    expect(parsed.searchParams.get('response-content-disposition'))
      .toBe('attachment; filename="demo.mp4"');
    // A 2048-bit RSA signature is 256 bytes, hex-encoded.
    expect(parsed.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]{512}$/);
  });

  test('view URL of a PDF sets the content type and no disposition', async () => {
    const gcs = await clientFromJson();
    const parsed = new URL(await gcs.getObjectUrl(BUCKET, 'docs/report.pdf', 'view'));

    expect(parsed.searchParams.get('response-content-type')).toBe('application/pdf');
    expect(parsed.searchParams.get('response-content-disposition')).toBeNull();
  });

  test('view URL of a video sets neither override', async () => {
    const gcs = await clientFromJson();
    const parsed = new URL(await gcs.getObjectUrl(BUCKET, 'clips/demo.mp4', 'view'));

    expect(parsed.searchParams.get('response-content-disposition')).toBeNull();
    expect(parsed.searchParams.get('response-content-type')).toBeNull();
  });

  test('preview URL honours the requested expiry', async () => {
    const gcs = await clientFromJson();
    const parsed = new URL(await gcs.getSignedUrl(BUCKET, 'a.txt', 600));

    expect(parsed.searchParams.get('X-Goog-Expires')).toBe('600');
    expect(parsed.searchParams.get('X-Goog-Signature')).toMatch(/^[0-9a-f]{512}$/);
  });

  test('keys with spaces and unicode are encoded correctly', async () => {
    const gcs = await clientFromJson();
    const key = 'folder name/中文 file.mp4';
    const parsed = new URL(await gcs.getObjectUrl(BUCKET, key, 'download'));

    expect(decodeURIComponent(parsed.pathname)).toBe(`/${BUCKET}/${key}`);
    const disposition = parsed.searchParams.get('response-content-disposition');
    expect(disposition).toMatch(/^[\x20-\x7e]+$/);
    expect(disposition).toContain('filename="__ file.mp4"');
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe('中文 file.mp4');
  });

  test('a key file on disk signs identically to inline JSON', async () => {
    const fromFile = new GCSClient();
    await fromFile.initialize({ authMethod: 'service-account', keyFilename: keyFilePath });

    const parsed = new URL(await fromFile.getObjectUrl(BUCKET, 'a.bin', 'download'));
    expect(parsed.searchParams.get('X-Goog-Credential')).toContain(credentials.client_email);
  });
});

describe('GCSClient configuration', () => {
  test('a missing key file fails fast with a clear message', async () => {
    const gcs = new GCSClient();
    await expect(gcs.initialize({
      authMethod: 'service-account',
      keyFilename: '/tmp/definitely-not-here.json'
    })).rejects.toThrow(/key file not found/i);
  });

  test('malformed inline JSON is reported as such', async () => {
    const gcs = new GCSClient();
    await expect(gcs.initialize({
      authMethod: 'service-account',
      credentialsJson: '{not json'
    })).rejects.toThrow(/could not be parsed/i);
  });

  test('service-account without any credential is rejected', async () => {
    const gcs = new GCSClient();
    await expect(gcs.initialize({ authMethod: 'service-account' }))
      .rejects.toThrow(/service account JSON key file is required/i);
  });

  test('auth method defaults to ADC when nothing is supplied', async () => {
    const gcs = new GCSClient();
    await gcs.initialize({});
    expect(gcs.originalConfig.authMethod).toBe('adc');
    expect(gcs.storage).toBeDefined();
  });

  test('a key file implies the service-account method', async () => {
    const gcs = new GCSClient();
    await gcs.initialize({ keyFilename: keyFilePath });
    expect(gcs.originalConfig.authMethod).toBe('service-account');
  });

  test('a custom endpoint keeps authentication enabled for service accounts', async () => {
    const gcs = new GCSClient();
    await gcs.initialize({
      authMethod: 'service-account',
      keyFilename: keyFilePath,
      endpoint: 'https://private.googleapis.com'
    });
    // The SDK disables auth for custom endpoints unless this is set, which would
    // otherwise turn a private-endpoint connection into anonymous requests.
    expect(gcs.storage.authClient).toBeDefined();
    expect(gcs.originalConfig.endpoint).toBe('https://private.googleapis.com');
  });
});

describe('helpers', () => {
  test('content type guessing covers the previewable types', () => {
    expect(guessContentType('a.mp4')).toBe('video/mp4');
    expect(guessContentType('a.PDF')).toBe('application/pdf');
    expect(guessContentType('a.txt')).toBe('text/plain');
    expect(guessContentType('a.unknownext')).toBeUndefined();
    expect(guessContentType('noextension')).toBeUndefined();
  });

  test('403 is translated into an IAM hint', () => {
    const err = Object.assign(new Error('storage.objects.list denied'), { code: 403 });
    expect(enhanceGcsError(err).message).toMatch(/Storage Object Viewer/);
  });

  test('missing ADC is translated into a login hint', () => {
    const err = new Error('Could not load the default credentials');
    expect(enhanceGcsError(err).message).toMatch(/gcloud auth application-default login/);
  });

  test('an unsignable credential explains why preview/download fails', () => {
    // User-account ADC has no private key, so V4 signing is impossible.
    const err = new Error('Cannot sign data without `client_email`.');
    const message = enhanceGcsError(err).message;
    expect(message).toMatch(/no private key to sign with/i);
    expect(message).toMatch(/service account/i);
  });

  test('an unrelated error is passed through untouched', () => {
    const err = new Error('socket hang up');
    expect(enhanceGcsError(err)).toBe(err);
  });
});
