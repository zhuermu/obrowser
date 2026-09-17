const { EventEmitter } = require('events');
const { createDownloadManager } = require('../download-manager');

function createWindow(id, session = new EventEmitter()) {
  return Object.assign(new EventEmitter(), { id, session, send: jest.fn(), downloadURL: jest.fn(), isDestroyed: jest.fn(() => false) });
}
function createItem(url, options = {}) {
  const item = Object.assign(new EventEmitter(), { loaded: 0, total: 100, path: '', paused: false, ...options });
  item.getURL = () => url;
  item.getURLChain = () => options.chain || [url];
  item.getReceivedBytes = () => item.loaded;
  item.getTotalBytes = () => item.total;
  item.getSavePath = () => item.path;
  item.isPaused = () => item.paused;
  return item;
}

describe('native download tracking', () => {
  let window;
  let manager;
  const url = 'https://storage.example.test/movie.mp4?signature=fixture';
  const reports = () => window.send.mock.calls.map(([, value]) => value);
  const attach = (item, owner = window) => {
    const event = { preventDefault: jest.fn() };
    window.session.emit('will-download', event, item, owner);
    return event;
  };
  beforeEach(() => {
    jest.useFakeTimers();
    window = createWindow(1);
    manager = createDownloadManager(window, { startTimeoutMs: 1000 });
  });
  afterEach(() => { manager.dispose(); jest.useRealTimers(); });

  test('tracks save selection, actual bytes and final completion without exposing the signed URL', () => {
    expect(manager.start({ downloadId: 'one', url })).toEqual({ success: true });
    expect(window.downloadURL).toHaveBeenCalledWith(url);
    expect(window.send).not.toHaveBeenCalled();
    const item = createItem(url);
    attach(item);
    expect(reports().at(-1)).toMatchObject({ downloadId: 'one', status: 'awaiting-save', loaded: 0, total: 100 });
    item.path = '/tmp/电影.mp4';
    item.loaded = 50;
    item.emit('updated', {}, 'progressing');
    expect(reports().at(-1)).toMatchObject({ status: 'downloading', loaded: 50, path: '/tmp/电影.mp4' });
    item.loaded = 100;
    jest.advanceTimersByTime(100);
    item.emit('updated', {}, 'progressing');
    expect(reports().at(-1).status).toBe('downloading');
    item.emit('done', {}, 'completed');
    expect(reports().at(-1)).toMatchObject({ status: 'completed', loaded: 100, total: 100 });
    expect(item.listenerCount('updated')).toBe(0);
    expect(item.listenerCount('done')).toBe(0);
    expect(JSON.stringify(reports())).not.toContain('signature=');
    expect(window.send.mock.calls.every(([channel]) => channel === 'download-progress')).toBe(true);
  });

  test.each([['cancelled', 'cancelled'], ['interrupted', 'failed']])('native %s is reported as %s, never success', (native, expected) => {
    manager.start({ downloadId: 'one', url });
    const item = createItem(url);
    attach(item);
    item.emit('done', {}, native);
    expect(reports().at(-1).status).toBe(expected);
    if (expected === 'failed') expect(reports().at(-1).error).toContain('interrupted');
    expect(reports().some(report => report.status === 'completed')).toBe(false);
  });

  test('unknown size and zero-byte files are distinguished only on completion', () => {
    manager.start({ downloadId: 'one', url });
    const item = createItem(url, { total: 0, loaded: 0 });
    attach(item);
    expect(reports().at(-1).total).toBeNull();
    item.emit('done', {}, 'completed');
    expect(reports().at(-1)).toMatchObject({ total: 0, loaded: 0, status: 'completed' });
    manager.start({ downloadId: 'two', url });
    const streaming = createItem(url, { total: 0, loaded: 512, path: '/tmp/file' });
    attach(streaming);
    expect(reports().at(-1)).toMatchObject({ total: null, loaded: 512 });
    streaming.emit('done', {}, 'completed');
    expect(reports().at(-1)).toMatchObject({ total: 512, loaded: 512 });
  });

  test('throttles byte updates but never drops state changes or terminal events', () => {
    manager.start({ downloadId: 'one', url });
    const item = createItem(url, { path: '/tmp/file' });
    attach(item);
    item.loaded = 10;
    item.emit('updated', {}, 'progressing');
    expect(reports()).toHaveLength(1);
    jest.advanceTimersByTime(100);
    item.emit('updated', {}, 'progressing');
    expect(reports().at(-1).loaded).toBe(10);
    item.paused = true;
    item.emit('updated', {}, 'progressing');
    expect(reports().at(-1).status).toBe('paused');
    item.paused = false;
    item.emit('updated', {}, 'interrupted');
    expect(reports().at(-1).status).toBe('interrupted');
    item.loaded = 0; // Servers without range support restart instead of resuming.
    item.emit('updated', {}, 'progressing');
    expect(reports().at(-1)).toMatchObject({ status: 'downloading', loaded: 0 });
    item.emit('done', {}, 'completed');
    expect(reports().at(-1).status).toBe('completed');
  });

  test('isolates windows and ignores unrelated downloads', () => {
    manager.start({ downloadId: 'one', url });
    const otherWindow = createWindow(2, window.session);
    attach(createItem(url), otherWindow);
    attach(createItem('https://other.test/file'));
    expect(window.send).not.toHaveBeenCalled();
    expect(attach(createItem(url)).preventDefault).not.toHaveBeenCalled();
    expect(reports().at(-1).downloadId).toBe('one');
  });

  test('matches redirect chains and separates duplicate URLs with FIFO IDs', () => {
    manager.start({ downloadId: 'one', url });
    manager.start({ downloadId: 'two', url });
    const first = createItem('https://cdn.example.test/movie', { chain: [url, 'https://cdn.example.test/movie'] });
    const second = createItem(url);
    attach(first);
    attach(second);
    first.emit('done', {}, 'completed');
    second.emit('done', {}, 'cancelled');
    expect(reports().slice(-2).map(report => [report.downloadId, report.status])).toEqual([['one', 'completed'], ['two', 'cancelled']]);
  });

  test('times out a missing native event and cancels any late download before saving', () => {
    manager.start({ downloadId: 'one', url });
    jest.advanceTimersByTime(1000);
    expect(reports().at(-1)).toMatchObject({ downloadId: 'one', status: 'failed' });
    expect(attach(createItem(url)).preventDefault).toHaveBeenCalled();
    expect(reports()).toHaveLength(1);
  });

  test('starting errors remove timers and let the request be retried', () => {
    window.downloadURL.mockImplementationOnce(() => { throw new Error('Launch failed'); });
    expect(() => manager.start({ downloadId: 'one', url })).toThrow('Launch failed');
    expect(reports().at(-1).status).toBe('failed');
    jest.advanceTimersByTime(1000);
    expect(reports()).toHaveLength(1);
    expect(() => manager.start({ downloadId: 'one', url })).not.toThrow();
  });

  test('a retry of a timed-out URL starts and any duplicate late response is stopped', () => {
    manager.start({ downloadId: 'old', url });
    jest.advanceTimersByTime(1000);
    manager.start({ downloadId: 'retry', url });
    const item = createItem(url);
    expect(attach(item).preventDefault).not.toHaveBeenCalled();
    expect(reports().at(-1).downloadId).toBe('retry');
    expect(attach(createItem(url)).preventDefault).toHaveBeenCalled();
    item.emit('done', {}, 'completed');
    expect(reports().at(-1)).toMatchObject({ downloadId: 'retry', status: 'completed' });
  });

  test('rejects unsupported URLs and duplicate IDs', () => {
    for (const invalid of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      expect(() => manager.start({ downloadId: 'one', url: invalid })).toThrow();
    }
    expect(window.downloadURL).not.toHaveBeenCalled();
    manager.start({ downloadId: 'one', url });
    expect(() => manager.start({ downloadId: 'one', url })).toThrow('duplicate');
    attach(createItem(url));
    expect(() => manager.start({ downloadId: 'one', url })).toThrow('duplicate');
  });

  test('window closure detaches listeners and timers without touching native downloads', () => {
    manager.start({ downloadId: 'one', url });
    const item = createItem(url);
    attach(item);
    manager.start({ downloadId: 'two', url });
    window.emit('destroyed');
    expect(window.session.listenerCount('will-download')).toBe(0);
    expect(item.listenerCount('updated')).toBe(0);
    jest.advanceTimersByTime(1000);
    expect(reports()).toHaveLength(1);
  });
});
