/**
 * Signed-URL verification used before handing a URL to Chromium's downloader.
 *
 * Chromium writes whatever the server returns to disk, so a failed request
 * (cross-region redirect, expired signature, deleted object) silently produces
 * an XML error document named like the real file — e.g. a "video.mp4" that is
 * actually an S3 <Error> payload. Probing the URL first lets the UI show a real
 * error instead.
 *
 * Lives in its own module (rather than main.js) so it can be tested without
 * booting Electron.
 */

/**
 * Turn a storage-service error response into one actionable sentence.
 * Handles the XML error shape used by S3, Aliyun OSS and, loosely, Azure.
 * @param {number} status - HTTP status code
 * @param {string} body - Response body
 * @returns {string} Human readable message
 */
function describeStorageError(status, body) {
  const pick = (tag) => {
    const match = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(body || '');
    return match ? match[1].trim() : '';
  };
  const code = pick('Code') || pick('Error');
  const message = pick('Message');
  const endpoint = pick('Endpoint');

  if (code === 'PermanentRedirect' || code === 'AuthorizationHeaderMalformed' || status === 301) {
    return 'The bucket is in a different region than the signed request' +
      (endpoint ? ` (the service expects ${endpoint})` : '') +
      ". Reopen the bucket, or select the bucket's region in the region selector, then retry.";
  }
  if (code === 'AccessDenied' || status === 403) {
    if (/expired/i.test(message)) {
      return 'The signed download link expired. Close the preview and try again.';
    }
    return `Access denied by the storage service${message ? `: ${message}` : ''}. Check the credentials and object permissions.`;
  }
  if (code === 'ExpiredToken' || code === 'TokenRefreshRequired') {
    return 'The credentials used to sign the download expired. Reconnect and try again.';
  }
  if (code === 'NoSuchKey' || code === 'NoSuchBucket' || status === 404) {
    return 'The object no longer exists. Refresh the file list and try again.';
  }
  if (code || message) {
    return `Storage service returned ${status}${code ? ` (${code})` : ''}: ${message || 'no details'}`;
  }
  return `Storage service returned HTTP ${status}.`;
}

/**
 * Probe a signed URL with a one-byte ranged GET.
 *
 * A ranged GET is used instead of HEAD because a presigned signature only
 * covers the method it was generated for (GET). Redirects are followed, which
 * mirrors Chromium; S3's PermanentRedirect carries no Location header, so it
 * surfaces here as a readable 301.
 *
 * @param {string} url - URL to verify
 * @param {Function} [fetchImpl] - fetch implementation (injectable for tests)
 * @returns {Promise<Object>} `{ ok, status?, message?, skipped? }`
 */
async function verifyDownloadUrl(url, fetchImpl) {
  if (!url || typeof url !== 'string') {
    return { ok: false, message: 'No download URL was generated.' };
  }

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    // Runtime without fetch: skip verification rather than block downloads.
    return { ok: true, skipped: true };
  }

  let response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' }
    });
  } catch (error) {
    return { ok: false, message: `Could not reach the storage endpoint: ${error.message}` };
  }

  // 206 = ranged content, 416 = range unsatisfiable (empty object) — both mean
  // the request was authorized and the object exists.
  if (response.ok || response.status === 206 || response.status === 416) {
    if (response.body && typeof response.body.cancel === 'function') {
      // Release the socket without downloading the payload twice.
      Promise.resolve(response.body.cancel()).catch(() => {});
    }
    return { ok: true, status: response.status };
  }

  let body = '';
  try {
    body = await response.text();
  } catch (error) {
    body = '';
  }
  return {
    ok: false,
    status: response.status,
    message: describeStorageError(response.status, body)
  };
}

module.exports = { verifyDownloadUrl, describeStorageError };
