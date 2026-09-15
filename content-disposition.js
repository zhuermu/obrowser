/**
 * Build an ASCII-only download header (RFC 6266 / RFC 5987).
 *
 * Signing a URL percent-encodes its query, but the storage service decodes the
 * response override before emitting the HTTP header. Raw Unicode in filename=
 * therefore still fails on S3 with "cannot be represented using ISO-8859-1".
 * filename* carries the original UTF-8 name; filename is a safe ASCII fallback.
 */
function downloadContentDisposition(key) {
  const basename = String(key).split('/').pop() || 'download';
  // Normalize malformed Unicode and disallow control characters in filenames.
  const filename = Buffer.from(basename, 'utf8').toString('utf8').replace(/[\x00-\x1f\x7f]/g, '_');
  // Avoid quoted-string escapes and legacy browsers interpreting %xx in the
  // fallback. The extended parameter preserves these characters unambiguously.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/gu, '_');
  const disposition = `attachment; filename="${fallback}"`;
  if (fallback === filename) return disposition;

  const encoded = encodeURIComponent(filename).replace(/['()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename*=UTF-8''${encoded}`;
}

module.exports = { downloadContentDisposition };
