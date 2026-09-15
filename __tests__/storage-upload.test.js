const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const { S3Client } = require('@aws-sdk/client-s3');
const AWSS3Client = require('../storage-clients/AWSS3Client');
const AzureBlobClient = require('../storage-clients/AzureBlobClient');
const AliyunOSSClient = require('../storage-clients/AliyunOSSClient');
const GCSClient = require('../storage-clients/GCSClient');
const StorageClientInterface = require('../storage-clients/StorageClientInterface');

const MiB = 1024 * 1024;

describe('S3 managed streaming uploads (real Upload SDK, offline command transport)', () => {
  let sdk;
  let client;
  beforeEach(() => {
    sdk = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
    sdk.send = jest.fn(async command => {
      switch (command.constructor.name) {
        case 'CreateMultipartUploadCommand': return { UploadId: 'fixture-upload' };
        case 'UploadPartCommand': return { ETag: `part-${command.input.PartNumber}` };
        case 'CompleteMultipartUploadCommand': return { ETag: 'complete' };
        case 'PutObjectCommand': return { ETag: 'single' };
        case 'AbortMultipartUploadCommand': return {};
        default: throw new Error(`Unexpected command ${command.constructor.name}`);
      }
    });
    client = new AWSS3Client();
    client.getClientForBucket = jest.fn().mockResolvedValue(sdk);
  });
  afterEach(() => sdk.destroy());

  test('streams multiple bounded parts and reports acknowledged bytes', async () => {
    const size = 17 * MiB;
    const onProgress = jest.fn();
    const body = Readable.from(Array.from({ length: 17 }, () => Buffer.alloc(MiB)));
    await expect(client.uploadObject('bucket', 'movie.mp4', body, { contentLength: size, onProgress })).resolves.toMatchObject({ success: true });
    const commands = sdk.send.mock.calls.map(([command]) => command);
    const parts = commands.filter(command => command.constructor.name === 'UploadPartCommand');
    expect(parts.map(part => part.input.Body.length)).toEqual([8 * MiB, 8 * MiB, MiB]);
    expect(commands.at(-1).constructor.name).toBe('CompleteMultipartUploadCommand');
    expect(onProgress).toHaveBeenCalledWith(8 * MiB);
    expect(onProgress).toHaveBeenLastCalledWith(size);
  });

  test('an empty file uses a single put and reports zero bytes', async () => {
    const onProgress = jest.fn();
    await client.uploadObject('bucket', 'empty.txt', Readable.from([]), { contentLength: 0, onProgress });
    expect(sdk.send.mock.calls.map(([command]) => command.constructor.name)).toEqual(['PutObjectCommand']);
    expect(onProgress).toHaveBeenCalledWith(0);
  });

  test('aborts unfinished multipart uploads when a part fails', async () => {
    const original = sdk.send.getMockImplementation();
    sdk.send.mockImplementation(command => {
      if (command.constructor.name === 'UploadPartCommand') throw new Error('Part rejected');
      return original(command);
    });
    await expect(client.uploadObject('bucket', 'movie.mp4', Readable.from([Buffer.alloc(9 * MiB)]), { contentLength: 9 * MiB })).rejects.toThrow('Part rejected');
    expect(sdk.send.mock.calls.some(([command]) => command.constructor.name === 'AbortMultipartUploadCommand')).toBe(true);
  });
});

describe('provider progress adapters', () => {
  test('Azure uses bounded streaming buffers and adapts loadedBytes', async () => {
    const onProgress = jest.fn();
    const body = Readable.from(['video']);
    const uploadStream = jest.fn(async (stream, bufferSize, concurrency, options) => {
      expect(stream).toBe(body);
      expect([bufferSize, concurrency]).toEqual([8 * MiB, 2]);
      options.onProgress({ loadedBytes: 4 });
      return { etag: 'fixture' };
    });
    const client = new AzureBlobClient();
    client.client = { getContainerClient: () => ({ getBlockBlobClient: () => ({ uploadStream }) }) };
    await client.uploadObject('bucket', 'movie.mp4', body, { onProgress });
    expect(onProgress).toHaveBeenCalledWith(4);
    expect(uploadStream.mock.calls[0][3].blobHTTPHeaders.blobContentType).toBe('video/mp4');
  });

  test.each([4, 9 * MiB])('GCS pipes data and chooses resumable chunks by file size (%i)', async size => {
    const onProgress = jest.fn();
    let received = '';
    const destination = new Writable({ write(chunk, _, done) {
      received += chunk.toString();
      this.emit('progress', { bytesWritten: Buffer.byteLength(received) });
      done();
    } });
    const createWriteStream = jest.fn(() => destination);
    const client = new GCSClient();
    client.storage = { bucket: () => ({ file: () => ({ createWriteStream }) }) };
    await client.uploadObject('bucket', 'clip.mp4', Readable.from(['data']), { contentLength: size, onProgress });
    expect(received).toBe('data');
    expect(onProgress).toHaveBeenLastCalledWith(4);
    expect(createWriteStream).toHaveBeenCalledWith({
      contentType: 'video/mp4', resumable: size >= 8 * MiB,
      ...(size >= 8 * MiB ? { chunkSize: 8 * MiB } : {})
    });
  });

  test('GCS propagates write errors and destroys the source stream', async () => {
    const source = Readable.from(['data']);
    const client = new GCSClient();
    client.originalConfig = {};
    client.storage = { bucket: () => ({ file: () => ({ createWriteStream: () => new Writable({
      write(_, __, done) { done(new Error('Network interrupted')); }
    }) }) }) };
    await expect(client.uploadObject('bucket', 'clip.mp4', source)).rejects.toThrow('Network interrupted');
    expect(source.destroyed).toBe(true);
  });

  test('OSS computes exact bytes for out-of-order and short final parts', async () => {
    const onProgress = jest.fn();
    const client = new AliyunOSSClient();
    client.client = {
      options: { bucket: 'bucket' },
      multipartUpload: jest.fn(async (_, filePath, options) => {
        expect(filePath).toBe('/fixture/video.mp4');
        options.progress(0.25, { fileSize: 17 * MiB, partSize: 8 * MiB, doneParts: [{ number: 3 }] });
        options.progress(0.5, { fileSize: 17 * MiB, partSize: 8 * MiB, doneParts: [{ number: 3 }, { number: 1 }] });
        return { etag: 'fixture' };
      })
    };
    await client.uploadFile('bucket', 'video.mp4', '/fixture/video.mp4', { contentLength: 17 * MiB, onProgress });
    expect(onProgress.mock.calls).toEqual([[MiB], [9 * MiB]]);
  });

  test('OSS cleans up its multipart session without masking the upload error', async () => {
    const client = new AliyunOSSClient();
    client.client = {
      options: { bucket: 'bucket' },
      abortMultipartUpload: jest.fn().mockResolvedValue({}),
      multipartUpload: async (_, __, options) => {
        options.progress(0, { uploadId: 'fixture-upload', fileSize: MiB, partSize: MiB, doneParts: [] });
        throw new Error('Part failed');
      }
    };
    await expect(client.uploadFile('bucket', 'video.mp4', '/fixture/video.mp4')).rejects.toThrow('Part failed');
    expect(client.client.abortMultipartUpload).toHaveBeenCalledWith('video.mp4', 'fixture-upload');
  });
});

describe('local file streaming lifecycle', () => {
  let directory;
  let file;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obrowser-upload-test-'));
    file = path.join(directory, 'fixture.txt');
    fs.writeFileSync(file, 'fixture');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  test('passes a stream instead of a full-file buffer and closes it on success', async () => {
    const client = new StorageClientInterface();
    let body;
    client.uploadObject = jest.fn(async (_, __, stream) => {
      body = stream;
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe('fixture');
      return { success: true };
    });
    await client.uploadFile('bucket', 'key', file);
    expect(body).toBeInstanceOf(Readable);
    expect(body.destroyed).toBe(true);
  });

  test('closes the file stream if provider initialization fails', async () => {
    const client = new StorageClientInterface();
    let body;
    client.uploadObject = async (_, __, stream) => { body = stream; throw new Error('Credentials expired'); };
    await expect(client.uploadFile('bucket', 'key', file)).rejects.toThrow('Credentials expired');
    expect(body.destroyed).toBe(true);
  });

  test('a file removed before stream consumption rejects instead of becoming unhandled', async () => {
    const client = new StorageClientInterface();
    client.uploadObject = async (_, __, stream) => {
      await new Promise(resolve => setTimeout(resolve, 10));
      for await (const chunk of stream) void chunk;
    };
    await expect(client.uploadFile('bucket', 'key', path.join(directory, 'missing'))).rejects.toThrow('ENOENT');
  });
});
