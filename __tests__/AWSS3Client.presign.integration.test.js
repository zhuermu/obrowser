/**
 * Integration test: uses the REAL @aws-sdk/client-s3 + s3-request-presigner to
 * confirm the presigned URL is actually signed for the bucket's home region.
 *
 * No network access is needed: the bucket->region mapping is primed in the
 * shared cache, and presigning is a local (offline) operation.
 */

const AWSS3Client = require('../storage-clients/AWSS3Client');
const { bucketRegionCache } = AWSS3Client;

const CONFIG = {
  accessKey: 'AKIAIOSFODNN7EXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: '' // "auto-detect" -> signs against us-east-1 by default
};

beforeEach(() => bucketRegionCache.clear());
afterAll(() => bucketRegionCache.clear());

test('presigned download URL targets the bucket home region host', async () => {
  const s3 = new AWSS3Client();
  await s3.initialize(CONFIG);
  expect(s3.baseRegion).toBe('us-east-1');

  // Region already known (e.g. discovered while listing the bucket).
  bucketRegionCache.set('obrowser-tokyo', 'ap-northeast-1');

  const url = await s3.getObjectUrl('obrowser-tokyo', 'clips/demo.mp4', 'download');
  const parsed = new URL(url);

  // Host must be the Tokyo endpoint, otherwise S3 answers 301 PermanentRedirect
  // and Chromium saves the XML error body as "demo.mp4".
  expect(parsed.hostname).toBe('obrowser-tokyo.s3.ap-northeast-1.amazonaws.com');
  // SigV4 credential scope must match the region as well.
  expect(parsed.searchParams.get('X-Amz-Credential')).toContain('/ap-northeast-1/s3/aws4_request');
  expect(parsed.searchParams.get('response-content-disposition'))
    .toBe('attachment; filename="demo.mp4"');
  expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
});

test('a us-east-1 bucket keeps using the base client', async () => {
  const s3 = new AWSS3Client();
  await s3.initialize(CONFIG);
  bucketRegionCache.set('obrowser-virginia', 'us-east-1');

  const url = await s3.getObjectUrl('obrowser-virginia', 'a.bin', 'download');
  expect(new URL(url).hostname).toBe('obrowser-virginia.s3.us-east-1.amazonaws.com');
  expect(await s3.getClientForBucket('obrowser-virginia')).toBe(s3.client);
});

test('Chinese download names produce an ASCII response override with a UTF-8 filename', async () => {
  const s3 = new AWSS3Client();
  await s3.initialize(CONFIG);
  bucketRegionCache.set('obrowser-singapore', 'ap-southeast-1');
  const filename = '沉淀物料包_MiniMax-H3竖屏短剧.tar.gz';
  const key = `h3-portrait-p1/${filename}`;
  const parsed = new URL(await s3.getObjectUrl('obrowser-singapore', key, 'download'));

  expect(parsed.hostname).toBe('obrowser-singapore.s3.ap-southeast-1.amazonaws.com');
  expect(decodeURIComponent(parsed.pathname)).toBe(`/${key}`);
  expect(parsed.searchParams.get('X-Amz-Credential')).toContain('/ap-southeast-1/s3/aws4_request');
  const disposition = parsed.searchParams.get('response-content-disposition');
  // URLSearchParams removes only the URL encoding; the actual header value
  // must still be ASCII, with UTF-8 percent-encoding inside filename*.
  expect(disposition).toMatch(/^[\x20-\x7e]+$/);
  expect(disposition).toContain('filename="______MiniMax-H3____.tar.gz"');
  expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1])).toBe(filename);
  expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
});

test('view URLs (preview) are signed for the bucket region too', async () => {
  const s3 = new AWSS3Client();
  await s3.initialize(CONFIG);
  bucketRegionCache.set('obrowser-frankfurt', 'eu-central-1');

  const viewUrl = await s3.getObjectUrl('obrowser-frankfurt', 'doc.pdf', 'view');
  const previewUrl = await s3.getSignedUrl('obrowser-frankfurt', 'doc.pdf', 600);

  expect(new URL(viewUrl).hostname).toBe('obrowser-frankfurt.s3.eu-central-1.amazonaws.com');
  expect(new URL(previewUrl).hostname).toBe('obrowser-frankfurt.s3.eu-central-1.amazonaws.com');
  // View mode must not force a download disposition.
  expect(new URL(viewUrl).searchParams.get('response-content-disposition')).toBeNull();
  expect(new URL(viewUrl).searchParams.get('response-content-type')).toBe('application/pdf');
});

test('custom S3-compatible endpoints still presign against that endpoint', async () => {
  const s3 = new AWSS3Client();
  await s3.initialize({ ...CONFIG, region: 'us-east-1', endpoint: 'http://127.0.0.1:9000' });

  const url = await s3.getObjectUrl('minio-bucket', 'a.txt', 'download');
  const parsed = new URL(url);
  expect(parsed.host).toBe('127.0.0.1:9000');
  expect(parsed.pathname).toContain('minio-bucket');
});
