/**
 * Google Cloud Storage Client Implementation
 *
 * Unlike the other providers, GCS's primary credential is a single artifact —
 * a service account JSON key file — rather than an access-key/secret pair.
 * (GCS *does* have key pairs, "HMAC keys", but they exist only for the
 * S3-compatible XML API and are tucked away under Cloud Storage → Settings →
 * Interoperability.) This client uses the native JSON API via
 * @google-cloud/storage, so it accepts:
 *
 *   - 'service-account' (default): path to a service account JSON key file.
 *     Only the path is persisted in the connection profile, so the private key
 *     never gets copied into obrowser's config file.
 *   - 'adc': Application Default Credentials, i.e. whatever
 *     `gcloud auth application-default login` set up, or the service account
 *     attached to the machine. Nothing secret is stored at all.
 *
 * Signed URLs are produced with V4 signing. With a service account key this is
 * a purely local operation; under ADC with user credentials there is no private
 * key to sign with, so signing falls back to the IAM SignBlob API and requires
 * the `iam.serviceAccounts.signBlob` permission.
 */

const fs = require('fs');
const { Storage } = require('@google-cloud/storage');
const StorageClientInterface = require('./StorageClientInterface');

/**
 * Map common file extensions to content types so previews work in the browser.
 * @param {string} key - Object name
 * @returns {string|undefined} Content type, or undefined to let GCS guess
 */
function guessContentType(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  const types = {
    txt: 'text/plain',
    log: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    xml: 'application/xml',
    md: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    zip: 'application/zip'
  };
  return types[ext];
}

/**
 * Turn credential/permission failures into actionable messages.
 * @param {Error} error - Original error
 * @param {Object} config - Connection config
 * @returns {Error} Enhanced error, or the original one
 */
function enhanceGcsError(error, config = {}) {
  const message = error && error.message ? error.message : '';
  const code = error && (error.code || error.status);

  if (/cannot sign data without .?client_email/i.test(message)) {
    return new Error(
      'Preview and download need a signed URL, but the current credentials have no private key to sign with. ' +
      'User-account Application Default Credentials cannot sign. Switch this connection to a service account ' +
      'JSON key file, or use an ADC that impersonates a service account ' +
      '(`gcloud auth application-default login --impersonate-service-account=SA_EMAIL`).'
    );
  }
  if (/could not load the default credentials/i.test(message)) {
    return new Error(
      'No Google credentials found. Either select a service account JSON key file, ' +
      'or run `gcloud auth application-default login` to use Application Default Credentials.'
    );
  }
  if (/error:0909006C|no start line|DECODER routines/i.test(message)) {
    return new Error(
      'The selected file is not a valid service account JSON key (its private_key could not be parsed). ' +
      'Download a fresh key from IAM & Admin → Service Accounts → Keys.'
    );
  }
  if (code === 401 || /invalid_grant|unauthorized/i.test(message)) {
    return new Error(
      'Google rejected the credentials (401). The service account key may be disabled or deleted, ' +
      'or the ADC session may have expired — try `gcloud auth application-default login`.'
    );
  }
  if (code === 403) {
    return new Error(
      `Permission denied by Google Cloud (403): ${message}. The principal needs a role such as ` +
      '"Storage Object Viewer" (read) or "Storage Admin" (full control) on the bucket or project.'
    );
  }
  return error;
}

class GCSClient extends StorageClientInterface {
  constructor() {
    super();
    this.storage = null;
    this.originalConfig = null;
  }

  /**
   * Initialize the GCS client.
   * @param {Object} config - Connection configuration
   * @param {string} [config.authMethod] - 'service-account' (default) or 'adc'
   * @param {string} [config.keyFilename] - Path to the service account JSON key
   * @param {string} [config.credentialsJson] - Inline service account JSON
   * @param {string} [config.projectId] - Overrides the project in the key file
   * @param {string} [config.endpoint] - Custom API endpoint (emulator/private)
   * @returns {Promise<GCSClient>} This instance
   */
  async initialize(config) {
    const method = config.authMethod || (config.keyFilename || config.credentialsJson ? 'service-account' : 'adc');
    const options = {};

    if (method === 'service-account') {
      if (config.credentialsJson) {
        try {
          options.credentials = typeof config.credentialsJson === 'string'
            ? JSON.parse(config.credentialsJson)
            : config.credentialsJson;
        } catch (error) {
          throw new Error(`Service account JSON could not be parsed: ${error.message}`);
        }
      } else if (config.keyFilename) {
        if (!fs.existsSync(config.keyFilename)) {
          throw new Error(`Service account key file not found: ${config.keyFilename}`);
        }
        options.keyFilename = config.keyFilename;
      } else {
        throw new Error('A service account JSON key file is required when authMethod is "service-account".');
      }
    }

    if (config.projectId) options.projectId = config.projectId;
    // Supports the GCS emulator and private/regional endpoints.
    if (config.endpoint) {
      options.apiEndpoint = config.endpoint;
      // The SDK silently disables authentication for custom endpoints. That is
      // right for an emulator, but a private/regional Google endpoint still
      // needs the credentials, so re-enable auth whenever we actually have some.
      if (method === 'service-account') {
        options.useAuthWithCustomEndpoint = true;
      }
    }

    this.storage = new Storage(options);
    this.originalConfig = { ...config, authMethod: method };

    return this;
  }

  /**
   * List all buckets in the project
   * @returns {Promise<Array>} List of buckets in S3-compatible shape
   */
  async listBuckets() {
    try {
      const [buckets] = await this.storage.getBuckets();
      return buckets.map(bucket => ({
        Name: bucket.name,
        CreationDate: bucket.metadata && bucket.metadata.timeCreated
          ? new Date(bucket.metadata.timeCreated)
          : null,
        Location: bucket.metadata ? bucket.metadata.location : undefined,
        IsGCSBucket: true
      }));
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * List objects one level deep, mirroring S3's delimiter listing.
   * @param {string} bucket - Bucket name
   * @param {string} prefix - Optional prefix (folder path)
   * @returns {Promise<Object>} Object containing folders and files
   */
  async listObjects(bucket, prefix = '') {
    const normalizedPrefix = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';

    try {
      const bucketRef = this.storage.bucket(bucket);
      const folders = new Map();
      const files = [];

      // autoPaginate must be off to see `prefixes`, which the JSON API returns
      // per page alongside the objects.
      let query = {
        prefix: normalizedPrefix,
        delimiter: '/',
        autoPaginate: false,
        maxResults: 1000
      };

      do {
        const [pageFiles, nextQuery, apiResponse] = await bucketRef.getFiles(query);

        for (const folderPath of (apiResponse && apiResponse.prefixes) || []) {
          folders.set(folderPath, {
            Key: folderPath,
            isFolder: true,
            LastModified: null,
            Size: 0
          });
        }

        for (const file of pageFiles) {
          // Skip the placeholder object standing for the folder being listed.
          if (file.name === normalizedPrefix) continue;

          if (file.name.endsWith('/')) {
            if (!folders.has(file.name)) {
              folders.set(file.name, {
                Key: file.name,
                isFolder: true,
                LastModified: file.metadata && file.metadata.updated
                  ? new Date(file.metadata.updated)
                  : null,
                Size: 0
              });
            }
            continue;
          }

          const metadata = file.metadata || {};
          files.push({
            Key: file.name,
            isFolder: false,
            LastModified: metadata.updated ? new Date(metadata.updated) : null,
            Size: metadata.size !== undefined ? Number(metadata.size) : 0,
            ContentType: metadata.contentType || 'application/octet-stream',
            StorageClass: metadata.storageClass || 'STANDARD',
            ETag: metadata.etag
          });
        }

        query = nextQuery;
      } while (query);

      return {
        type: 'objects',
        data: [...folders.values(), ...files]
      };
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * Upload an object
   * @param {string} bucket - Bucket name
   * @param {string} key - Object name
   * @param {Buffer|string} body - Object content
   * @returns {Promise<Object>} Result of the upload operation
   */
  async uploadObject(bucket, key, body) {
    try {
      const file = this.storage.bucket(bucket).file(key);
      const contentType = guessContentType(key);

      await file.save(body, {
        // Single-request upload: simpler and faster for the desktop use case,
        // and avoids leaving orphaned resumable sessions behind on failure.
        resumable: false,
        ...(contentType ? { contentType } : {})
      });

      return { success: true, key };
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * Download an object as a stream, in the shape the app expects
   * @param {string} bucket - Bucket name
   * @param {string} key - Object name
   * @returns {Promise<Object>} `{ Body, ContentType, ContentLength, ... }`
   */
  async getObject(bucket, key) {
    try {
      const file = this.storage.bucket(bucket).file(key);
      const [metadata] = await file.getMetadata();

      return {
        Body: file.createReadStream(),
        ContentType: metadata.contentType,
        ContentLength: metadata.size !== undefined ? Number(metadata.size) : undefined,
        LastModified: metadata.updated ? new Date(metadata.updated) : undefined,
        Metadata: metadata.metadata
      };
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * Generate a V4 signed URL for temporary read access
   * @param {string} bucket - Bucket name
   * @param {string} key - Object name
   * @param {number} expiresIn - Expiration in seconds
   * @returns {Promise<string>} Signed URL
   */
  async getSignedUrl(bucket, key, expiresIn = 3600) {
    try {
      const [url] = await this.storage.bucket(bucket).file(key).getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresIn * 1000
      });
      return url;
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * Generate a signed URL for a specific operation.
   * @param {string} bucket - Bucket name
   * @param {string} key - Object name
   * @param {string} operation - 'download' or 'view'
   * @returns {Promise<string>} Signed URL
   */
  async getObjectUrl(bucket, key, operation = 'download') {
    console.log(`GCS getObjectUrl - Bucket: ${bucket}, Key: ${key}, Operation: ${operation}`);

    const fileName = key.split('/').pop();
    const isPdf = (key.split('.').pop() || '').toLowerCase() === 'pdf';

    const options = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + 3600 * 1000
    };
    if (operation === 'download') {
      // Forces the browser to save instead of render.
      options.responseDisposition = `attachment; filename="${fileName}"`;
    } else if (isPdf) {
      options.responseType = 'application/pdf';
    }

    try {
      const [url] = await this.storage.bucket(bucket).file(key).getSignedUrl(options);
      console.log(`Generated GCS signed URL with ${operation} disposition`);
      return url;
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * Delete an object
   * @param {string} bucket - Bucket name
   * @param {string} key - Object name
   * @returns {Promise<Object>} Result of the delete operation
   */
  async deleteObject(bucket, key) {
    try {
      await this.storage.bucket(bucket).file(key).delete();
      return { success: true };
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }

  /**
   * Delete multiple objects, reporting per-object outcomes.
   * @param {string} bucket - Bucket name
   * @param {Array<string>} keys - Object names
   * @returns {Promise<Object>} `{ success, deleted, errors }`
   */
  async deleteObjects(bucket, keys) {
    const bucketRef = this.storage.bucket(bucket);
    const deleted = [];
    const errors = [];

    // The JSON API has no batch delete, so issue them individually and keep
    // going on failure — matching the Azure client's behaviour.
    for (const key of keys) {
      try {
        await bucketRef.file(key).delete();
        deleted.push({ Key: key });
      } catch (error) {
        errors.push({
          Key: key,
          Code: error.code || error.status || 'Error',
          Message: error.message
        });
      }
    }

    return { success: errors.length === 0, deleted, errors };
  }

  /**
   * Create a folder placeholder (empty object with a trailing slash)
   * @param {string} bucket - Bucket name
   * @param {string} folderPath - Folder path
   * @returns {Promise<Object>} Result of the folder creation
   */
  async createFolder(bucket, folderPath) {
    const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    try {
      await this.storage.bucket(bucket).file(normalizedPath).save('', {
        resumable: false,
        contentType: 'application/x-directory'
      });
      return { success: true };
    } catch (error) {
      throw enhanceGcsError(error, this.originalConfig);
    }
  }
}

module.exports = GCSClient;
module.exports.guessContentType = guessContentType;
module.exports.enhanceGcsError = enhanceGcsError;
