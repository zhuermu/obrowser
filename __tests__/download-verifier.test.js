/**
 * Tests for the signed-URL preflight that stops S3 XML error bodies from being
 * saved to disk as "video.mp4" / "report.pdf".
 */

const { verifyDownloadUrl, describeStorageError } = require('../download-verifier');

const PERMANENT_REDIRECT_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>PermanentRedirect</Code><Message>The bucket you are attempting to access must be addressed using the specified endpoint. Please send all future requests to this endpoint.</Message><Endpoint>my-bucket.s3.ap-northeast-1.amazonaws.com</Endpoint><Bucket>my-bucket</Bucket></Error>`;

const EXPIRED_BODY = `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>`;

const fakeResponse = ({ status, body = '', ok }) => ({
  ok: ok !== undefined ? ok : status >= 200 && status < 300,
  status,
  text: async () => body,
  body: { cancel: async () => {} }
});

describe('verifyDownloadUrl', () => {
  test('accepts a ranged 206 response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse({ status: 206 }));
    const result = await verifyDownloadUrl('https://example.com/o?sig=1', fetchImpl);

    expect(result.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0];
    // Must be a GET: a presigned signature only covers the signed method.
    expect(init.method).toBe('GET');
    expect(init.headers.Range).toBe('bytes=0-0');
  });

  test('accepts 416 (empty object, range unsatisfiable)', async () => {
    const result = await verifyDownloadUrl(
      'https://example.com/o',
      jest.fn().mockResolvedValue(fakeResponse({ status: 416 }))
    );
    expect(result.ok).toBe(true);
  });

  test('rejects the cross-region 301 that would be saved as an XML file', async () => {
    const result = await verifyDownloadUrl(
      'https://s3.us-east-1.amazonaws.com/my-bucket/clip.mp4?sig=1',
      jest.fn().mockResolvedValue(fakeResponse({ status: 301, body: PERMANENT_REDIRECT_BODY }))
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(301);
    expect(result.message).toContain('different region');
    expect(result.message).toContain('my-bucket.s3.ap-northeast-1.amazonaws.com');
  });

  test('rejects an expired signature with a hint to retry', async () => {
    const result = await verifyDownloadUrl(
      'https://example.com/o',
      jest.fn().mockResolvedValue(fakeResponse({ status: 403, body: EXPIRED_BODY }))
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/expired/i);
  });

  test('reports network failures instead of throwing', async () => {
    const result = await verifyDownloadUrl(
      'https://example.com/o',
      jest.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ENOTFOUND');
  });

  test('rejects a missing URL', async () => {
    expect((await verifyDownloadUrl(undefined, jest.fn())).ok).toBe(false);
    expect((await verifyDownloadUrl('', jest.fn())).ok).toBe(false);
  });

  test('skips verification when no fetch implementation exists', async () => {
    const originalFetch = global.fetch;
    // eslint-disable-next-line no-global-assign
    delete global.fetch;
    try {
      const result = await verifyDownloadUrl('https://example.com/o');
      expect(result).toEqual({ ok: true, skipped: true });
    } finally {
      if (originalFetch) global.fetch = originalFetch;
    }
  });
});

describe('describeStorageError', () => {
  test('404 / NoSuchKey', () => {
    expect(describeStorageError(404, '<Error><Code>NoSuchKey</Code></Error>'))
      .toMatch(/no longer exists/);
  });

  test('expired STS token', () => {
    expect(describeStorageError(400, '<Error><Code>ExpiredToken</Code><Message>x</Message></Error>'))
      .toMatch(/credentials .*expired/i);
  });

  test('unknown error still includes the status code', () => {
    expect(describeStorageError(500, '')).toBe('Storage service returned HTTP 500.');
  });

  test('unrecognised code is passed through with details', () => {
    expect(describeStorageError(400, '<Error><Code>InvalidRequest</Code><Message>bad</Message></Error>'))
      .toBe('Storage service returned 400 (InvalidRequest): bad');
  });
});
