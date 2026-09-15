const fs = require('fs');
const { createUploadHandler } = require('../upload-progress');

describe('upload IPC progress', () => {
  let event;
  let uploadFile;
  let getStorageClient;
  let handler;
  const reports = () => event.sender.send.mock.calls.map(([, progress]) => progress);
  const run = () => handler(event, 'connection-1', 'bucket', 'folder/movie.mp4', '/fixture/movie.mp4', 'upload-1');

  beforeEach(() => {
    jest.spyOn(fs.promises, 'stat').mockResolvedValue({ size: 1000, isFile: () => true });
    event = { sender: { isDestroyed: jest.fn(() => false), send: jest.fn() } };
    uploadFile = jest.fn().mockResolvedValue({ success: true });
    getStorageClient = jest.fn().mockResolvedValue({ uploadFile });
    handler = createUploadHandler({ getStorageClient });
  });
  afterEach(() => jest.restoreAllMocks());

  test('reports a real byte count, then waits for cloud confirmation before completion', async () => {
    uploadFile.mockImplementation(async (bucket, key, file, options) => {
      expect([bucket, key, file, options.contentLength]).toEqual(['bucket', 'folder/movie.mp4', '/fixture/movie.mp4', 1000]);
      options.onProgress(1000);
      expect(reports().at(-1)).toMatchObject({ status: 'finalizing', loaded: 1000, total: 1000 });
      expect(reports().some(item => item.status === 'completed')).toBe(false);
    });
    await expect(run()).resolves.toEqual({ success: true });
    expect(getStorageClient).toHaveBeenCalledWith('connection-1');
    expect(reports().map(item => item.status)).toEqual(['preparing', 'uploading', 'finalizing', 'completed']);
    expect(reports().at(-1)).toMatchObject({ uploadId: 'upload-1', loaded: 1000, total: 1000 });
    expect(event.sender.send.mock.calls.every(([channel]) => channel === 'upload-progress')).toBe(true);
  });

  test('throttles updates, clamps bytes, and does not go backwards during retries', async () => {
    let now = 1000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    uploadFile.mockImplementation(async (_, __, ___, { onProgress }) => {
      now += 101;
      onProgress(200);
      onProgress(300);
      expect(reports().at(-1).loaded).toBe(200);
      now += 101;
      onProgress(100);
      expect(reports().at(-1).loaded).toBe(300);
      onProgress(NaN);
      onProgress(Infinity);
      onProgress(2000);
      expect(reports().at(-1)).toMatchObject({ loaded: 1000, status: 'finalizing' });
    });
    await run();
    expect(reports()).toHaveLength(6);
  });

  test('a cloud error after sending all bytes remains failed', async () => {
    uploadFile.mockImplementation(async (_, __, ___, { onProgress }) => {
      onProgress(1000);
      throw new Error('Access denied');
    });
    await expect(run()).rejects.toThrow('Access denied');
    expect(reports().at(-1)).toMatchObject({ status: 'failed', error: 'Access denied' });
    expect(reports().some(item => item.status === 'completed')).toBe(false);
  });

  test('missing files fail visibly before any cloud request', async () => {
    fs.promises.stat.mockRejectedValue(new Error('File no longer exists'));
    await expect(run()).rejects.toThrow('File no longer exists');
    expect(getStorageClient).not.toHaveBeenCalled();
    expect(reports().at(-1).status).toBe('failed');
  });

  test('directories cannot be uploaded as files', async () => {
    fs.promises.stat.mockResolvedValue({ isFile: () => false });
    await expect(run()).rejects.toThrow('not a file');
    expect(uploadFile).not.toHaveBeenCalled();
  });

  test('zero-byte uploads complete without invalid progress', async () => {
    fs.promises.stat.mockResolvedValue({ size: 0, isFile: () => true });
    await run();
    expect(reports().at(-1)).toMatchObject({ loaded: 0, total: 0, status: 'completed' });
  });

  test('a closed renderer cannot fail the upload', async () => {
    event.sender.isDestroyed.mockReturnValue(true);
    await expect(run()).resolves.toEqual({ success: true });
    expect(event.sender.send).not.toHaveBeenCalled();
    event.sender.isDestroyed.mockReturnValue(false);
    event.sender.send.mockImplementation(() => { throw new Error('WebContents destroyed'); });
    await expect(run()).resolves.toEqual({ success: true });
  });

  test('ignores SDK progress callbacks after settling', async () => {
    let lateProgress;
    uploadFile.mockImplementation(async (_, __, ___, { onProgress }) => { lateProgress = onProgress; });
    await run();
    lateProgress(1);
    expect(reports().at(-1).status).toBe('completed');
  });
});
