/**
 * End-to-end tests for AzureBlobClient against Azurite, Microsoft's official
 * Azure Storage emulator. This exercises the real @azure/storage-blob SDK and
 * the real Blob REST API (including SAS signing), so no Azure subscription is
 * needed to validate the implementation.
 *
 * Start the emulator first:
 *   npx azurite-blob --silent --location /tmp/azurite --blobHost 127.0.0.1 --blobPort 10000
 *
 * When the emulator is not reachable the whole suite is skipped rather than
 * failing, so `npm test` stays green on machines without it.
 */

const { execFileSync } = require('child_process');
const { BlobServiceClient, StorageSharedKeyCredential } = require('@azure/storage-blob');
const AzureBlobClient = require('../storage-clients/AzureBlobClient');

// Well-known Azurite development account.
const ACCOUNT = 'devstoreaccount1';
const KEY = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const ENDPOINT = `http://127.0.0.1:10000/${ACCOUNT}`;

const CONFIG = { accountName: ACCOUNT, accountKey: KEY, endpoint: ENDPOINT };
const CONTAINER = 'obrowser-test';

/**
 * Whether the emulator is listening. Must be resolved synchronously: Jest
 * decides which tests to run while collecting the file, before `beforeAll`.
 */
function emulatorReachable() {
  try {
    execFileSync('curl', ['-s', '-o', '/dev/null', '-m', '3', `${ENDPOINT}?comp=list`], {
      stdio: 'ignore'
    });
    return true;
  } catch (error) {
    return false;
  }
}

const available = emulatorReachable();
let admin;

const streamToString = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', (c) => chunks.push(Buffer.from(c)));
  stream.on('error', reject);
  stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
});

beforeAll(async () => {
  if (!available) {
    console.warn(`Azurite not reachable at ${ENDPOINT} — skipping Azure e2e tests. Start it with: npx azurite-blob --silent --location /tmp/azurite`);
    return;
  }

  admin = new BlobServiceClient(ENDPOINT, new StorageSharedKeyCredential(ACCOUNT, KEY));
  const container = admin.getContainerClient(CONTAINER);
  await container.deleteIfExists();
  await container.create();
}, 30000);

afterAll(async () => {
  if (available && admin) {
    await admin.getContainerClient(CONTAINER).deleteIfExists();
  }
});

const itLive = available ? test : test.skip;

async function newClient() {
  const client = new AzureBlobClient();
  await client.initialize(CONFIG);
  return client;
}

describe('AzureBlobClient against Azurite', () => {
  itLive('lists containers like buckets', async () => {
    const azure = await newClient();
    const buckets = await azure.listBuckets();

    const found = buckets.find(b => b.Name === CONTAINER);
    expect(found).toBeDefined();
    // The renderer reads `Name`; a container must also carry a creation date.
    expect(found.CreationDate).toBeInstanceOf(Date);
  });

  itLive('uploads, lists, downloads and deletes a blob', async () => {
    const azure = await newClient();
    const body = Buffer.from('hello obrowser', 'utf-8');

    const uploaded = await azure.uploadObject(CONTAINER, 'root.txt', body);
    expect(uploaded.success).toBe(true);

    const listing = await azure.listObjects(CONTAINER, '');
    const entry = listing.data.find(i => i.Key === 'root.txt');
    expect(entry).toBeDefined();
    expect(entry.Size).toBe(body.length);
    expect(entry.ContentType).toBe('text/plain');
    expect(entry.isFolder).toBe(false);

    const got = await azure.getObject(CONTAINER, 'root.txt');
    expect(await streamToString(got.Body)).toBe('hello obrowser');

    await azure.deleteObject(CONTAINER, 'root.txt');
    const after = await azure.listObjects(CONTAINER, '');
    expect(after.data.find(i => i.Key === 'root.txt')).toBeUndefined();
  });

  itLive('creates a folder placeholder and lists it', async () => {
    const azure = await newClient();
    await azure.createFolder(CONTAINER, 'docs');

    const listing = await azure.listObjects(CONTAINER, '');
    const folder = listing.data.find(i => i.Key === 'docs/');
    expect(folder).toBeDefined();
    expect(folder.isFolder).toBe(true);

    await azure.deleteObject(CONTAINER, 'docs/');
  });

  itLive('lists one level deep like S3 delimiter listing', async () => {
    const azure = await newClient();
    await azure.uploadObject(CONTAINER, 'lvl/a.txt', Buffer.from('a'));
    await azure.uploadObject(CONTAINER, 'lvl/sub/b.txt', Buffer.from('b'));

    try {
      const root = await azure.listObjects(CONTAINER, '');
      const keys = root.data.map(i => i.Key);
      // A blob nested two levels down must still surface its top folder.
      expect(keys).toContain('lvl/');

      const inside = await azure.listObjects(CONTAINER, 'lvl');
      const insideKeys = inside.data.map(i => i.Key);
      expect(insideKeys).toContain('lvl/a.txt');
      expect(insideKeys).toContain('lvl/sub/');
      // The grandchild must not leak into the current folder view.
      expect(insideKeys).not.toContain('lvl/sub/b.txt');
    } finally {
      await azure.deleteObjects(CONTAINER, ['lvl/a.txt', 'lvl/sub/b.txt']);
    }
  });

  itLive('shows a folder whose only content is nested deeper', async () => {
    const azure = await newClient();
    // No blob sits directly in deep/ — its only descendant is two levels down.
    await azure.uploadObject(CONTAINER, 'deep/x/y.txt', Buffer.from('y'));

    try {
      const root = await azure.listObjects(CONTAINER, '');
      expect(root.data.map(i => i.Key)).toContain('deep/');

      const inside = await azure.listObjects(CONTAINER, 'deep');
      expect(inside.data.map(i => i.Key)).toContain('deep/x/');
    } finally {
      await azure.deleteObject(CONTAINER, 'deep/x/y.txt');
    }
  });

  itLive('batch delete reports per-blob results', async () => {
    const azure = await newClient();
    await azure.uploadObject(CONTAINER, 'batch/1.txt', Buffer.from('1'));
    await azure.uploadObject(CONTAINER, 'batch/2.txt', Buffer.from('2'));

    const result = await azure.deleteObjects(CONTAINER, ['batch/1.txt', 'batch/2.txt', 'batch/missing.txt']);

    expect(result.deleted.map(d => d.Key)).toEqual(['batch/1.txt', 'batch/2.txt']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].Key).toBe('batch/missing.txt');
    expect(result.success).toBe(false);
  });

  itLive('signed URL (preview) is fetchable and returns the content', async () => {
    const azure = await newClient();
    await azure.uploadObject(CONTAINER, 'preview.txt', Buffer.from('previewable'));

    try {
      const url = await azure.getSignedUrl(CONTAINER, 'preview.txt', 600);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('previewable');
    } finally {
      await azure.deleteObject(CONTAINER, 'preview.txt');
    }
  });

  itLive('download URL forces an attachment disposition', async () => {
    const azure = await newClient();
    await azure.uploadObject(CONTAINER, 'clips/demo.mp4', Buffer.from('not-really-video'));

    try {
      const url = await azure.getObjectUrl(CONTAINER, 'clips/demo.mp4', 'download');
      const response = await fetch(url);

      expect(response.status).toBe(200);
      // Without this header the browser would render instead of download.
      expect(response.headers.get('content-disposition')).toBe('attachment; filename="demo.mp4"');
    } finally {
      await azure.deleteObject(CONTAINER, 'clips/demo.mp4');
    }
  });

  itLive('view URL does not force a download', async () => {
    const azure = await newClient();
    await azure.uploadObject(CONTAINER, 'clips/view.mp4', Buffer.from('not-really-video'));

    try {
      const url = await azure.getObjectUrl(CONTAINER, 'clips/view.mp4', 'view');
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(response.headers.get('content-type')).toBe('video/mp4');
    } finally {
      await azure.deleteObject(CONTAINER, 'clips/view.mp4');
    }
  });

  itLive('an expired SAS token is rejected (verifier would catch it)', async () => {
    const azure = await newClient();
    await azure.uploadObject(CONTAINER, 'expire.txt', Buffer.from('x'));

    try {
      const url = await azure.getObjectUrl(CONTAINER, 'expire.txt', 'download');
      // Rewrite the expiry to the past; the signature no longer matches.
      const tampered = url.replace(/se=[^&]+/, `se=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
      const response = await fetch(tampered);

      expect(response.ok).toBe(false);
      const { verifyDownloadUrl } = require('../download-verifier');
      const check = await verifyDownloadUrl(tampered);
      expect(check.ok).toBe(false);
      expect(typeof check.message).toBe('string');
    } finally {
      await azure.deleteObject(CONTAINER, 'expire.txt');
    }
  });
});
