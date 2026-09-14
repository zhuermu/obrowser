/**
 * Regression tests for cross-region ("auto-detect") behaviour.
 *
 * Bug: with no region configured, the client signs against us-east-1. Object
 * listing survived thanks to `followRegionRedirects`, but presigned URLs did
 * not — the browser cannot follow S3's 301 PermanentRedirect, so downloads
 * failed ("must be addressed using the specified endpoint") or saved the XML
 * error body as the file.
 */

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();
const constructedClients = [];

jest.mock('@aws-sdk/client-s3', () => {
  class FakeS3Client {
    constructor(config) {
      this.config = { ...config, region: async () => config.region };
      this.send = (...args) => mockSend(this, ...args);
      constructedClients.push(this);
    }
  }
  const cmd = (name) => class {
    constructor(input) {
      this.input = input;
      this.__type = name;
    }
  };
  return {
    S3Client: FakeS3Client,
    ListBucketsCommand: cmd('ListBuckets'),
    ListObjectsV2Command: cmd('ListObjectsV2'),
    PutObjectCommand: cmd('PutObject'),
    GetObjectCommand: cmd('GetObject'),
    DeleteObjectCommand: cmd('DeleteObject'),
    DeleteObjectsCommand: cmd('DeleteObjects'),
    HeadBucketCommand: cmd('HeadBucket'),
    GetBucketLocationCommand: cmd('GetBucketLocation')
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args)
}));

jest.mock('@aws-sdk/credential-providers', () => ({
  fromIni: (opts) => ({ __fromIni: opts })
}));

const AWSS3Client = require('../storage-clients/AWSS3Client');
const { bucketRegionCache, normalizeLocationConstraint } = AWSS3Client;

const BASE_CONFIG = {
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'secret',
  region: '' // "auto-detect"
};

/** Build an initialized client without triggering the bucket validation probe. */
async function newClient(config = BASE_CONFIG) {
  const client = new AWSS3Client();
  await client.initialize(config);
  return client;
}

beforeEach(() => {
  mockSend.mockReset();
  mockGetSignedUrl.mockReset();
  constructedClients.length = 0;
  bucketRegionCache.clear();
  mockGetSignedUrl.mockImplementation(async (client) => {
    const region = await client.config.region();
    return `https://s3.${region}.amazonaws.com/signed`;
  });
});

describe('bucket region resolution', () => {
  test('auto-detect mode signs download URLs with the bucket home region', async () => {
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') {
        return { $metadata: { httpHeaders: { 'x-amz-bucket-region': 'ap-northeast-1' } } };
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    const s3 = await newClient();
    expect(s3.baseRegion).toBe('us-east-1');

    const url = await s3.getObjectUrl('tokyo-bucket', 'clips/demo.mp4', 'download');

    expect(url).toBe('https://s3.ap-northeast-1.amazonaws.com/signed');
    const signingClient = mockGetSignedUrl.mock.calls[0][0];
    expect(await signingClient.config.region()).toBe('ap-northeast-1');
    // The signed command must still force an attachment disposition.
    expect(mockGetSignedUrl.mock.calls[0][1].input.ResponseContentDisposition)
      .toBe('attachment; filename="demo.mp4"');
  });

  test('reads the region from HeadBucket failures (301 / wrong signing region)', async () => {
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') {
        const err = new Error('PermanentRedirect');
        err.$metadata = { httpStatusCode: 301, httpHeaders: { 'x-amz-bucket-region': 'eu-central-1' } };
        throw err;
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    const s3 = await newClient();
    expect(await s3.resolveBucketRegion('frankfurt-bucket')).toBe('eu-central-1');
  });

  test('falls back to GetBucketLocation when no region header is returned', async () => {
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') {
        const err = new Error('AccessDenied');
        err.$metadata = { httpStatusCode: 403, httpHeaders: {} };
        throw err;
      }
      if (command.__type === 'GetBucketLocation') {
        return { LocationConstraint: 'EU' };
      }
      throw new Error(`unexpected command ${command.__type}`);
    });

    const s3 = await newClient();
    // "EU" is the legacy alias for eu-west-1.
    expect(await s3.resolveBucketRegion('legacy-bucket')).toBe('eu-west-1');
  });

  test('an undiscoverable region degrades to the base client instead of throwing', async () => {
    mockSend.mockImplementation(async () => {
      const err = new Error('AccessDenied');
      err.$metadata = { httpStatusCode: 403, httpHeaders: {} };
      throw err;
    });

    const s3 = await newClient();
    expect(await s3.resolveBucketRegion('opaque-bucket')).toBeNull();
    expect(await s3.getClientForBucket('opaque-bucket')).toBe(s3.client);
  });

  test('the region probe is cached across client instances', async () => {
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') {
        return { BucketRegion: 'us-west-2' };
      }
      return {};
    });

    const first = await newClient();
    await first.resolveBucketRegion('shared-bucket');
    const second = await newClient();
    await second.resolveBucketRegion('shared-bucket');

    const headCalls = mockSend.mock.calls.filter(([, cmd]) => cmd.__type === 'HeadBucket');
    expect(headCalls).toHaveLength(1);
  });

  test('custom S3-compatible endpoints skip region probing entirely', async () => {
    const s3 = await newClient({ ...BASE_CONFIG, endpoint: 'http://127.0.0.1:9000' });

    expect(s3.usesCustomEndpoint).toBe(true);
    expect(await s3.resolveBucketRegion('minio-bucket')).toBeNull();
    expect(await s3.getClientForBucket('minio-bucket')).toBe(s3.client);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('standard AWS endpoints are not pinned on the client', async () => {
    const s3 = await newClient({ ...BASE_CONFIG, endpoint: 'https://s3.amazonaws.com' });
    expect(s3.usesCustomEndpoint).toBe(false);
    expect(s3.client.config.endpoint).toBeUndefined();
  });

  test('object operations reuse a single per-region client', async () => {
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') return { BucketRegion: 'sa-east-1' };
      return { $metadata: {} };
    });

    const s3 = await newClient();
    await s3.getObject('sp-bucket', 'a.txt');
    await s3.deleteObject('sp-bucket', 'a.txt');

    const regionClients = new Set(
      mockSend.mock.calls
        .filter(([, cmd]) => cmd.__type === 'GetObject' || cmd.__type === 'DeleteObject')
        .map(([client]) => client)
    );
    expect(regionClients.size).toBe(1);
    expect([...regionClients][0]).not.toBe(s3.client);
  });

  test('listObjects retries against the correct region on AuthorizationHeaderMalformed', async () => {
    let listAttempts = 0;
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') {
        const err = new Error('AccessDenied');
        err.$metadata = { httpStatusCode: 403, httpHeaders: {} };
        throw err;
      }
      if (command.__type === 'GetBucketLocation') {
        const err = new Error('AccessDenied');
        err.$metadata = { httpStatusCode: 403, httpHeaders: {} };
        throw err;
      }
      if (command.__type === 'ListObjectsV2') {
        listAttempts += 1;
        if (listAttempts === 1) {
          const err = new Error('The authorization header is malformed');
          err.Code = 'AuthorizationHeaderMalformed';
          err.Region = 'ap-south-1';
          throw err;
        }
        return { Contents: [{ Key: 'p/file.bin', Size: 10 }], CommonPrefixes: [] };
      }
      return {};
    });

    const s3 = await newClient();
    const result = await s3.listObjects('mumbai-bucket', 'p/');

    // Previously this returned an empty listing; now it retries and succeeds.
    expect(result.data.map(i => i.Key)).toEqual(['p/file.bin']);
    // And the discovered region is cached so the next download signs correctly.
    expect(bucketRegionCache.get('mumbai-bucket')).toBe('ap-south-1');
  });

  test('initialize caches the region revealed by the default-bucket probe', async () => {
    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'ListObjectsV2') {
        const err = new Error('The authorization header is malformed');
        err.Code = 'AuthorizationHeaderMalformed';
        err.Region = 'ca-central-1';
        throw err;
      }
      return {};
    });

    const s3 = await newClient({ ...BASE_CONFIG, bucket: 'canada-bucket' });

    expect(bucketRegionCache.get('canada-bucket')).toBe('ca-central-1');
    // No extra HeadBucket needed for the follow-up download.
    const url = await s3.getObjectUrl('canada-bucket', 'a.mp4', 'download');
    expect(url).toBe('https://s3.ca-central-1.amazonaws.com/signed');
    expect(mockSend.mock.calls.filter(([, c]) => c.__type === 'HeadBucket')).toHaveLength(0);
  });

  test('getSignedUrl (preview) also uses the bucket region', async () => {    mockSend.mockImplementation(async (client, command) => {
      if (command.__type === 'HeadBucket') return { BucketRegion: 'us-west-1' };
      return {};
    });

    const s3 = await newClient();
    const url = await s3.getSignedUrl('nocal-bucket', 'v.mp4', 60);
    expect(url).toBe('https://s3.us-west-1.amazonaws.com/signed');
  });
});

describe('normalizeLocationConstraint', () => {  test.each([
    [undefined, 'us-east-1'],
    ['', 'us-east-1'],
    [null, 'us-east-1'],
    ['null', 'us-east-1'],
    ['EU', 'eu-west-1'],
    ['ap-northeast-1', 'ap-northeast-1']
  ])('%s -> %s', (input, expected) => {
    expect(normalizeLocationConstraint(input)).toBe(expected);
  });
});
