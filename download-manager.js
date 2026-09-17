/** Track Chromium downloads without buffering files or exposing signed URLs in UI events. */
function createDownloadManager(webContents, { startTimeoutMs = 60000 } = {}) {
  const pending = new Map();
  const active = new Map();
  const session = webContents.session;
  let disposed = false;

  function send(progress) {
    if (disposed || webContents.isDestroyed()) return;
    try { webContents.send('download-progress', progress); }
    catch (_) { /* The window can close between the check and send. */ }
  }

  function onDownload(event, item, owner) {
    if (owner !== webContents) return;
    const urls = [item.getURL(), ...item.getURLChain()];
    // Match the originating window AND URL (including the original URL after a
    // redirect). Identical concurrent URLs consume separate FIFO request IDs.
    const matches = [...pending.values()].filter(entry => urls.includes(entry.url));
    // A retry of the exact same URL can use whichever identical response arrives
    // first. Do not let an old timeout tombstone cancel the user's fresh retry.
    const request = matches.find(entry => !entry.expired) || matches[0];
    if (!request) return; // Unrelated browser/preview downloads remain untouched.
    pending.delete(request.id);
    clearTimeout(request.timer);
    if (request.expired) {
      event.preventDefault(); // A timed-out request must not later save silently.
      return;
    }

    let lastStatus;
    let lastSentAt = 0;
    function report(status, error, force = false) {
      const now = Date.now();
      if (!force && status === lastStatus && now - lastSentAt < 100) return;
      lastStatus = status;
      lastSentAt = now;
      const loaded = Math.max(0, item.getReceivedBytes());
      const nativeTotal = item.getTotalBytes();
      send({
        downloadId: request.id, status, loaded,
        // Electron returns 0 for unknown sizes as well as empty files.
        total: nativeTotal > 0 ? nativeTotal : status === 'completed' ? loaded : null,
        path: item.getSavePath(), error
      });
    }
    function updated(_, state) {
      const status = state === 'interrupted' ? 'interrupted'
        : item.isPaused() ? 'paused' : item.getSavePath() ? 'downloading' : 'awaiting-save';
      report(status);
    }
    function done(_, state) {
      const status = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';
      report(status, status === 'failed'
        ? 'Download interrupted. Check your network and available disk space, then try again.' : undefined, true);
      cleanup();
    }
    function cleanup() {
      item.removeListener('updated', updated);
      item.removeListener('done', done);
      active.delete(request.id);
    }
    active.set(request.id, { cleanup });
    item.on('updated', updated);
    item.once('done', done);
    // Keep Electron's native save dialog and its overwrite confirmation.
    report(item.getSavePath() ? 'downloading' : 'awaiting-save', undefined, true);
  }

  function start({ downloadId, url }) {
    if (disposed || webContents.isDestroyed()) throw new Error('The download window is closed.');
    if (typeof downloadId !== 'string' || !downloadId || pending.has(downloadId) || active.has(downloadId)) {
      throw new Error('Invalid or duplicate download ID.');
    }
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error('Invalid download URL.'); }
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Download URL must use HTTP or HTTPS.');
    const request = { id: downloadId, url: parsed.href };
    request.timer = setTimeout(() => {
      request.expired = true;
      // Keep a tombstone until a late DownloadItem arrives, so it can be stopped.
      send({ downloadId, status: 'failed', error: 'The download did not start. Please try again.' });
    }, startTimeoutMs);
    request.timer.unref?.();
    pending.set(downloadId, request);
    try {
      webContents.downloadURL(request.url);
      return { success: true };
    } catch (error) {
      clearTimeout(request.timer);
      pending.delete(downloadId);
      send({ downloadId, status: 'failed', error: 'Could not start the download. Please try again.' });
      throw error;
    }
  }

  function dispose() {
    disposed = true;
    session.removeListener('will-download', onDownload);
    webContents.removeListener('destroyed', dispose);
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
    for (const entry of active.values()) entry.cleanup();
  }
  session.on('will-download', onDownload);
  webContents.once('destroyed', dispose);
  return { start, dispose };
}

module.exports = { createDownloadManager };
