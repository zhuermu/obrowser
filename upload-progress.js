const fs = require('fs');

// Keep transfer reporting independent of Electron so it can be tested offline.
function createUploadHandler({ getStorageClient }) {
  return async (event, connectionId, bucket, key, filePath, uploadId) => {
    let total;
    let loaded = 0;
    let lastSentAt = 0;
    let lastStatus;
    let settled = false;
    const report = (status, error) => {
      const now = Date.now();
      if (status === lastStatus && now - lastSentAt < 100) return;
      lastStatus = status;
      lastSentAt = now;
      // Closing a window must not turn an otherwise successful upload into a failure.
      if (!uploadId || event.sender.isDestroyed()) return;
      try {
        event.sender.send('upload-progress', { uploadId, loaded, total, status, error });
      } catch (_) { /* The renderer may have closed between the check and send. */ }
    };

    try {
      report('preparing');
      const stats = await fs.promises.stat(filePath);
      if (!stats.isFile()) throw new Error('The selected path is not a file.');
      total = stats.size;
      const client = await getStorageClient(connectionId);
      report('uploading');
      await client.uploadFile(bucket, key, filePath, {
        contentLength: total,
        onProgress(bytes) {
          if (settled || !Number.isFinite(bytes)) return;
          loaded = Math.max(loaded, Math.min(total, Math.max(0, bytes)));
          report(loaded === total ? 'finalizing' : 'uploading');
        }
      });
      settled = true;
      loaded = total;
      report('completed');
      return { success: true };
    } catch (error) {
      settled = true;
      report('failed', error.message);
      throw error;
    }
  };
}

module.exports = { createUploadHandler };
