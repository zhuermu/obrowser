/**
 * End-to-end tests for GCSClient against fake-gcs-server, which implements the
 * real Cloud Storage JSON API. The genuine @google-cloud/storage SDK talks HTTP
 * to it, so this validates the client without a Google Cloud project.
 *
 * Start the emulator first:
 *   docker run -d --name fake-gcs -p 4443:4443 fsouza/fake-gcs-server:latest \
 *     -scheme http -port 4443 -public-host 127.0.0.1:4443
 *
 * The suite is skipped (not failed) when the emulator is unreachable.
 */

const { execFileSync } = require('child_process');

const EMULATOR = 'http://127.0.0.1:4443';
// NOTE: deliberately not using STORAGE_EMULATOR_HOST — with that env var the
// SDK drops the `/storage/v1` path prefix and every call 404s. Passing
// `apiEndpoint` produces the correct paths and also skips authentication.

const { Storage } = require('@google-cloud/storage');
const GCSClient = require('../storage-clients/GCSClient');

const BUCKET = 'obrowser-gcs-test';

function emulatorReachable() {
  try {
    const out = execFileSync('curl', ['-s', '-m', '3', `${EMULATOR}/storage/v1/b`], {
      encoding: 'utf-8'
    });
    return out.includes('storage#buckets');
  } catch (error) {
    return false;
  }
}

const available = emulatorReachable();
const itLive = available ? test : test.skip;
let admin;

beforeAll(async () => {
  if (!available) {
    console.warn(`fake-gcs-server not reachable at ${EMULATOR} — skipping GCS e2e tests.`);
    return;
  }
  admin = new Storage({ projectId: 'obrowser-test', apiEndpoint: EMULATOR });
  const bucket = admin.bucket(BUCKET);
  const [exists] = await bucket.exists();
  if (exists) await bucket.deleteFiles({ force: true }).catch(() => {});
  else await admin.createBucket(BUCKET);
}, 60000);

async function newClient() {
  const client = new GCSClient();
  // 'adc' avoids requiring a key file; the emulator needs no credentials.
  await client.initialize({ authMethod: 'adc', projectId: 'obrowser-test', endpoint: EMULATOR });
  return client;
}

const streamToString = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(Buffer.from(c)));
  stream.on('error', reject);
  stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
});

async function cleanup(keys) {
  const gcs = await newClient();
  await gcs.deleteObjects(BUCKET, keys).catch(() => {});
}

describe('GCSClient against fake-gcs-server', () => {
  itLive('lists buckets in the S3-compatible shape', async () => {
    const gcs = await newClient();
    const buckets = await gcs.listBuckets();

    const found = buckets.find(b => b.Name === BUCKET);
    expect(found).toBeDefined();
    expect(found.IsGCSBucket).toBe(true);
  });

  itLive('uploads, lists, downloads and deletes an object', async () => {
    const gcs = await newClient();
    const body = Buffer.from('hello gcs', 'utf-8');

    const uploaded = await gcs.uploadObject(BUCKET, 'root.txt', body);
    expect(uploaded.success).toBe(true);

    const listing = await gcs.listObjects(BUCKET, '');
    const entry = listing.data.find(i => i.Key === 'root.txt');
    expect(entry).toBeDefined();
    expect(entry.isFolder).toBe(false);
    expect(entry.Size).toBe(body.length);
    expect(entry.ContentType).toBe('text/plain');
    expect(entry.LastModified).toBeInstanceOf(Date);

    const got = await gcs.getObject(BUCKET, 'root.txt');
    expect(got.ContentLength).toBe(body.length);
    expect(await streamToString(got.Body)).toBe('hello gcs');

    await gcs.deleteObject(BUCKET, 'root.txt');
    const after = await gcs.listObjects(BUCKET, '');
    expect(after.data.find(i => i.Key === 'root.txt')).toBeUndefined();
  });

  itLive('rolls sub-paths up into folders one level at a time', async () => {
    const gcs = await newClient();
    await gcs.uploadObject(BUCKET, 'lvl/a.txt', Buffer.from('a'));
    await gcs.uploadObject(BUCKET, 'lvl/sub/b.txt', Buffer.from('b'));

    try {
      const root = await gcs.listObjects(BUCKET, '');
      expect(root.data.map(i => i.Key)).toContain('lvl/');
      expect(root.data.find(i => i.Key === 'lvl/').isFolder).toBe(true);

      const inside = await gcs.listObjects(BUCKET, 'lvl');
      const keys = inside.data.map(i => i.Key);
      expect(keys).toContain('lvl/a.txt');
      expect(keys).toContain('lvl/sub/');
      // Grandchildren must not leak into the current folder view.
      expect(keys).not.toContain('lvl/sub/b.txt');
    } finally {
      await cleanup(['lvl/a.txt', 'lvl/sub/b.txt']);
    }
  });

  itLive('shows a folder whose only content is nested deeper', async () => {
    const gcs = await newClient();
    await gcs.uploadObject(BUCKET, 'deep/x/y.txt', Buffer.from('y'));

    try {
      const root = await gcs.listObjects(BUCKET, '');
      expect(root.data.map(i => i.Key)).toContain('deep/');

      const inside = await gcs.listObjects(BUCKET, 'deep');
      expect(inside.data.map(i => i.Key)).toContain('deep/x/');
    } finally {
      await cleanup(['deep/x/y.txt']);
    }
  });

  itLive('createFolder normalizes the path and marks it as a directory', async () => {
    // fake-gcs-server is filesystem-backed and cannot store an object whose
    // name ends with '/', which is precisely how real GCS folder placeholders
    // work. So assert on the request the client issues rather than round-tripping.
    const gcs = await newClient();
    const bucketRef = gcs.storage.bucket(BUCKET);
    const fileRef = bucketRef.file('placeholder');
    const save = jest.spyOn(fileRef, 'save').mockResolvedValue([]);
    jest.spyOn(gcs.storage, 'bucket').mockReturnValue(bucketRef);
    const file = jest.spyOn(bucketRef, 'file').mockReturnValue(fileRef);

    try {
      const result = await gcs.createFolder(BUCKET, 'docs');

      expect(result.success).toBe(true);
      // 'docs' must become 'docs/'.
      expect(file).toHaveBeenCalledWith('docs/');
      expect(save).toHaveBeenCalledWith('', expect.objectContaining({
        resumable: false,
        contentType: 'application/x-directory'
      }));

      // An already-normalized path must not gain a second slash.
      await gcs.createFolder(BUCKET, 'docs/');
      expect(file).toHaveBeenLastCalledWith('docs/');
    } finally {
      jest.restoreAllMocks();
    }
  });

  itLive('a folder placeholder is never listed as a 0-byte file', async () => {
    // Emulated via a real nested object: listing inside 'holder/' must show the
    // child, and the rollup at the root must show 'holder/' as a folder.
    const gcs = await newClient();
    await gcs.uploadObject(BUCKET, 'holder/child.txt', Buffer.from('c'));

    try {
      const root = await gcs.listObjects(BUCKET, '');
      const folder = root.data.find(i => i.Key === 'holder/');
      expect(folder).toBeDefined();
      expect(folder.isFolder).toBe(true);
      expect(folder.Size).toBe(0);

      const inside = await gcs.listObjects(BUCKET, 'holder');
      expect(inside.data.map(i => i.Key)).toEqual(['holder/child.txt']);
    } finally {
      await cleanup(['holder/child.txt']);
    }
  });

  itLive('batch delete reports per-object results', async () => {
    const gcs = await newClient();
    await gcs.uploadObject(BUCKET, 'batch/1.txt', Buffer.from('1'));
    await gcs.uploadObject(BUCKET, 'batch/2.txt', Buffer.from('2'));

    const result = await gcs.deleteObjects(BUCKET, ['batch/1.txt', 'batch/2.txt', 'batch/missing.txt']);

    expect(result.deleted.map(d => d.Key)).toEqual(['batch/1.txt', 'batch/2.txt']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].Key).toBe('batch/missing.txt');
    expect(result.success).toBe(false);
  });

  itLive('paginates listings larger than one page', async () => {
    const gcs = await newClient();
    const keys = Array.from({ length: 12 }, (_, i) => `page/f${String(i).padStart(2, '0')}.txt`);
    for (const key of keys) {
      await gcs.uploadObject(BUCKET, key, Buffer.from(key));
    }

    try {
      // Force multi-page behaviour by shrinking the page size.
      const original = gcs.storage.bucket(BUCKET).getFiles.bind(gcs.storage.bucket(BUCKET));
      const bucketRef = gcs.storage.bucket(BUCKET);
      jest.spyOn(gcs.storage, 'bucket').mockReturnValue(bucketRef);
      jest.spyOn(bucketRef, 'getFiles').mockImplementation((query) =>
        original({ ...query, maxResults: 5 })
      );

      const listing = await gcs.listObjects(BUCKET, 'page');
      expect(listing.data.map(i => i.Key).sort()).toEqual(keys);
    } finally {
      jest.restoreAllMocks();
      await cleanup(keys);
    }
  });

  itLive('surfaces a readable error for a missing object', async () => {
    const gcs = await newClient();
    await expect(gcs.getObject(BUCKET, 'does-not-exist.txt')).rejects.toThrow();
  });

  itLive('is reachable through StorageClientFactory as type "gcs"', async () => {
    // Mirrors what main.js does for a saved connection.
    const StorageClientFactory = require('../storage-clients/StorageClientFactory');
    const client = await StorageClientFactory.createClient('gcs', {
      authMethod: 'adc',
      projectId: 'obrowser-test',
      endpoint: EMULATOR
    });

    await client.uploadObject(BUCKET, 'via-factory.txt', Buffer.from('factory'));
    try {
      const listing = await client.listObjects(BUCKET, '');
      expect(listing.type).toBe('objects');
      expect(listing.data.map(i => i.Key)).toContain('via-factory.txt');
    } finally {
      await client.deleteObject(BUCKET, 'via-factory.txt');
    }
  });
});
