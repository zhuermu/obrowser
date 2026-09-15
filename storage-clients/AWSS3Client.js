/**
 * AWS S3 Client Implementation
 */

const { 
  S3Client, 
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  GetBucketLocationCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const { fromIni } = require('@aws-sdk/credential-providers');
const StorageClientInterface = require('./StorageClientInterface');
const { downloadContentDisposition } = require('../content-disposition');

/**
 * Detect if an endpoint URL is a standard AWS S3 endpoint. Standard endpoints
 * (e.g. s3.amazonaws.com, s3.us-east-1.amazonaws.com, s3-accelerate.amazonaws.com)
 * should NOT be set explicitly on the SDK client — doing so pins every request
 * to one regional URL, which breaks:
 *   - `BucketRegion` filtering on ListBuckets (must hit regional endpoint)
 *   - `followRegionRedirects` (SDK needs to swap the host on 307 redirects)
 *
 * Only truly custom endpoints (MinIO, third-party S3-compatible storage, VPC
 * endpoints) should be passed through.
 */
function isStandardAwsEndpoint(endpoint) {
  if (!endpoint) return false;
  let host;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch (e) {
    return false;
  }
  // amazonaws.com (commercial), amazonaws.com.cn (China), sc2s.sgov.gov (IC),
  // c2s.ic.gov (IC), amazonaws-us-gov.com (GovCloud).
  return /(^|\.)s3([.-][a-z0-9-]+)?\.(amazonaws\.com(\.cn)?|amazonaws-us-gov\.com|c2s\.ic\.gov|sc2s\.sgov\.gov)$/i.test(host);
}

/**
 * Process-wide cache of bucket -> home region. Bucket regions are immutable
 * for the lifetime of a bucket, and `main.js` builds a brand new client for
 * every IPC call, so caching at module scope avoids repeating the HeadBucket
 * probe on every listing / download.
 */
const bucketRegionCache = new Map();

/**
 * Read the `x-amz-bucket-region` hint S3 attaches to both successful and
 * failed (301 / 400) bucket requests. Works for SDK responses and for
 * ServiceExceptions, whose $metadata carries the same headers.
 */
function readBucketRegionHeader(source) {
  if (!source) return undefined;
  const headers =
    (source.$metadata && source.$metadata.httpHeaders) ||
    (source.$response && source.$response.headers) ||
    null;
  if (!headers) return undefined;
  return headers['x-amz-bucket-region'] || headers['X-Amz-Bucket-Region'];
}

/**
 * Normalize a GetBucketLocation `LocationConstraint` into a real region id.
 * S3 returns an empty/null constraint for us-east-1 and the legacy alias "EU"
 * for eu-west-1.
 */
function normalizeLocationConstraint(location) {
  if (!location || location === 'null') return 'us-east-1';
  if (location === 'EU') return 'eu-west-1';
  return location;
}

/**
 * Build a credentials provider (or static credentials object) based on the
 * configured auth method. Supports:
 *
 *   - 'access-key' (default, backward compatible): long-term or STS temporary
 *     credentials. Optional `sessionToken` enables STS (up to 36h via
 *     `aws sts get-session-token`).
 *   - 'profile': reads a named profile from the shared AWS config/credentials
 *     files (`~/.aws/credentials`, `~/.aws/config`). Automatically handles
 *     SSO, AssumeRole chains (source_profile + role_arn), credential_process,
 *     MFA, etc. The SDK transparently refreshes temporary credentials before
 *     they expire, so the user does not need to "re-login" until the
 *     underlying source (e.g. SSO token) expires.
 *
 * @param {Object} config
 * @returns {Object|Function} credentials provider or static credentials
 */
function buildCredentials(config) {
  const method = config.authMethod || 'access-key';

  if (method === 'profile') {
    if (!config.profile) {
      throw new Error('AWS profile name is required when authMethod is "profile"');
    }
    // fromIni resolves credentials from ~/.aws/credentials and ~/.aws/config.
    // It supports SSO, AssumeRole chains, credential_process, MFA, and will
    // auto-refresh temporary credentials before they expire.
    return fromIni({ profile: config.profile });
  }

  // Default: static access key credentials (optionally with session token).
  if (!config.accessKey || !config.secretKey) {
    throw new Error('Access key and secret key are required for access-key authentication');
  }
  const creds = {
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey
  };
  if (config.sessionToken) {
    creds.sessionToken = config.sessionToken;
  }
  return creds;
}

/**
 * Translate credential-related errors into actionable user-facing messages.
 * Returns the original error if it's not credential-related.
 */
function enhanceCredentialError(error, config) {
  const method = config.authMethod || 'access-key';
  const name = error && (error.name || error.Code);
  const msg = error && error.message ? error.message : '';

  // SSO token expired or missing
  if (
    name === 'SSOTokenProviderFailure' ||
    /sso.*session.*(expired|invalid|not\s*found)/i.test(msg) ||
    /token.*(expired|invalid).*sso/i.test(msg)
  ) {
    const profile = config.profile || '<profile>';
    return new Error(
      `AWS SSO session expired or not found. Run \`aws sso login --profile ${profile}\` in a terminal, then retry.`
    );
  }

  // Profile not found / no credential source in profile / shared config invalid
  if (
    name === 'CredentialsProviderError' ||
    /could not resolve credentials using profile/i.test(msg) ||
    /profile.*(could not be found|not found)/i.test(msg) ||
    /shared credentials file/i.test(msg)
  ) {
    const profile = config.profile || '<profile>';
    // Distinguish "can't resolve" (profile exists but no credential source)
    // from "not found" (no such profile at all) — the remediation differs.
    if (/could not resolve credentials using profile/i.test(msg)) {
      return new Error(
        `AWS profile "${profile}" exists but has no usable credential source. ` +
        `Add one of: an SSO section (\`sso_session\` + \`sso_account_id\` + \`sso_role_name\`), ` +
        `a \`source_profile\` + \`role_arn\` for AssumeRole, or \`aws_access_key_id\` + \`aws_secret_access_key\` in ~/.aws/credentials. ` +
        `For SSO profiles also run \`aws sso login --profile ${profile}\`.`
      );
    }
    return new Error(
      `Could not load AWS profile "${profile}". Check ~/.aws/credentials and ~/.aws/config, or run \`aws configure --profile ${profile}\`.`
    );
  }

  // Expired temporary credentials (session token / assumed role)
  if (
    name === 'ExpiredToken' ||
    name === 'ExpiredTokenException' ||
    /token.*expired/i.test(msg)
  ) {
    if (method === 'profile') {
      return new Error(
        `Temporary credentials expired. If using SSO, run \`aws sso login --profile ${config.profile}\`. Otherwise check your profile's source credentials.`
      );
    }
    return new Error(
      'Temporary credentials (session token) have expired. Obtain new ones via `aws sts get-session-token` or re-run your credential issuing command.'
    );
  }

  // Generic invalid / missing credentials
  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return new Error(`AWS rejected the credentials (${name}). Please verify the access key and secret key.`);
  }

  return error;
}

class AWSS3Client extends StorageClientInterface {
  constructor() {
    super();
    this.client = null;
    // Signing region of `this.client`.
    this.baseRegion = null;
    // Shared credential provider instance — reused by per-region clients so
    // SSO / AssumeRole tokens are resolved (and refreshed) only once.
    this.credentials = null;
    // Set when the connection points at a non-AWS S3-compatible host, in which
    // case there is no per-bucket region to discover.
    this.usesCustomEndpoint = false;
    // region -> S3Client, lazily created by `getClientForBucket`.
    this.regionClients = new Map();
  }

  /**
   * Initialize the S3 client with connection details.
   * Supports multiple auth methods (see `buildCredentials`).
   * @param {Object} config - S3 connection configuration
   * @returns {AWSS3Client} This instance
   */
  async initialize(config) {
    const credentials = buildCredentials(config);
    this.credentials = credentials;

    // Region handling:
    //   - If user provided a region, use it.
    //   - For profile mode, fromIni auto-resolves region from ~/.aws/config;
    //     if still empty, fall back to us-east-1 for ListBuckets (a global API).
    //   - followRegionRedirects lets S3 transparently redirect per-bucket
    //     requests to the bucket's home region, so the initial region is
    //     effectively just the signing region for ListBuckets.
    const clientConfig = {
      region: config.region || 'us-east-1',
      credentials,
      followRegionRedirects: true
    };
    // Only pass an explicit endpoint when it's a non-AWS (custom / S3-compatible)
    // host. Standard AWS endpoints are omitted so the SDK can resolve the right
    // regional URL per request — required for BucketRegion filtering and for
    // cross-region bucket redirects to work.
    this.usesCustomEndpoint = !!(config.endpoint && !isStandardAwsEndpoint(config.endpoint));
    if (this.usesCustomEndpoint) {
      clientConfig.endpoint = config.endpoint;
    }

    this.client = new S3Client(clientConfig);
    this.baseRegion = clientConfig.region;
    this.regionClients.clear();
    
    // Store original config for potential reconnection and error diagnostics
    this.originalConfig = { ...config };
    
    // If a bucket is specified, try a test call to validate region
    if (config.bucket) {
      try {
        // Make a low-cost call to validate region (1 item limit)
        const command = new ListObjectsV2Command({
          Bucket: config.bucket,
          MaxKeys: 1
        });
        await this.client.send(command);
        console.log(`Successfully validated S3 client configuration with region: ${config.region}`);
      } catch (error) {
        // A region mismatch is no longer fatal: record the bucket's real region
        // so object operations and presigned URLs sign against it.
        if (error.Code === 'AuthorizationHeaderMalformed' && error.Region) {
          console.log(`Bucket "${config.bucket}" lives in ${error.Region} (signing region ${clientConfig.region}); using it for object operations.`);
          bucketRegionCache.set(config.bucket, error.Region);
        } else {
          // Surface credential/auth issues early with a friendly message, but
          // don't block initialization for unrelated errors.
          const enhanced = enhanceCredentialError(error, config);
          if (enhanced !== error) {
            throw enhanced;
          }
          console.warn(`Warning during S3 client initialization: ${error.message}`);
        }
      }
    }
    
    return this;
  }

  /**
   * Discover the home region of a bucket.
   *
   * `followRegionRedirects` only helps requests the SDK itself sends. A
   * presigned URL is consumed by the browser, which cannot follow S3's
   * `301 PermanentRedirect` — it just saves the XML error body. So whenever we
   * sign a URL (or touch an object) we must use a client whose signing region
   * matches the bucket.
   *
   * Resolution order: HeadBucket (cheap, needs the same permission as
   * listing) → the `x-amz-bucket-region` header on the failure →
   * GetBucketLocation. Returns `null` when the region cannot be determined or
   * when a custom S3-compatible endpoint is in use.
   *
   * @param {string} bucket - Bucket name
   * @returns {Promise<string|null>} Bucket region, or null if unknown
   */
  async resolveBucketRegion(bucket) {
    if (!bucket || this.usesCustomEndpoint) return null;
    if (bucketRegionCache.has(bucket)) return bucketRegionCache.get(bucket);

    let region = null;
    try {
      const response = await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      region = response.BucketRegion || readBucketRegionHeader(response) || null;
    } catch (error) {
      // A wrong-region HeadBucket still tells us where the bucket lives, via
      // `error.Region` (AuthorizationHeaderMalformed) or the region header
      // (301 PermanentRedirect / 400).
      region = error.Region || readBucketRegionHeader(error) || null;
    }

    if (!region) {
      // Last resort: the legacy location API. Some buckets/permissions allow
      // this when HeadBucket is denied (403 hides the region header).
      try {
        const response = await this.client.send(new GetBucketLocationCommand({ Bucket: bucket }));
        region = normalizeLocationConstraint(response.LocationConstraint);
      } catch (error) {
        console.warn(`Could not determine region for bucket "${bucket}": ${error.message}`);
      }
    }

    if (region) {
      bucketRegionCache.set(bucket, region);
      console.log(`Resolved region for bucket "${bucket}": ${region}`);
    }
    return region;
  }

  /**
   * Return an S3 client whose signing region matches the bucket's home region.
   * Falls back to the base client when the region is unknown, already correct,
   * or irrelevant (custom endpoint).
   * @param {string} bucket - Bucket name
   * @returns {Promise<S3Client>} Region-correct client
   */
  async getClientForBucket(bucket) {
    if (!bucket || this.usesCustomEndpoint) return this.client;

    let region = null;
    try {
      region = await this.resolveBucketRegion(bucket);
    } catch (error) {
      console.warn(`Bucket region lookup failed for "${bucket}": ${error.message}`);
    }
    if (!region || region === this.baseRegion) return this.client;

    if (!this.regionClients.has(region)) {
      this.regionClients.set(region, new S3Client({
        region,
        credentials: this.credentials,
        followRegionRedirects: true
      }));
    }
    return this.regionClients.get(region);
  }

  /**
   * List all buckets in the account
   * @returns {Promise<Array>} List of buckets
   */
  async listBuckets() {
    // If the user picked a specific region (via the saved connection or the
    // in-memory region switcher), filter server-side so the result reflects
    // only buckets physically in that region. Otherwise ("auto-detect") we
    // fall back to the account-wide listing.
    const filterRegion = this.originalConfig && this.originalConfig.region
      ? this.originalConfig.region
      : '';

    // Internal helper: paginate ListBuckets with the given params against the
    // given client. ListBuckets returns up to 10000 buckets per page, but the
    // BucketRegion filter introduces pagination we must follow ourselves.
    const paginate = async (client, baseParams) => {
      const all = [];
      let token;
      do {
        const resp = await client.send(new ListBucketsCommand({
          ...baseParams,
          ...(token ? { ContinuationToken: token } : {})
        }));
        if (resp.Buckets) all.push(...resp.Buckets);
        token = resp.ContinuationToken;
      } while (token);
      return all;
    };

    const params = filterRegion ? { BucketRegion: filterRegion } : {};

    try {
      return await paginate(this.client, params);
    } catch (error) {
      // ListBuckets is a global S3 API. If S3 rejects our signature because
      // the account's "home" region differs from our signing region, re-sign
      // against the home region once instead of failing. We still honour the
      // BucketRegion filter on the retry so the user sees only the buckets
      // in their chosen region.
      if (error.Code === 'AuthorizationHeaderMalformed' && error.Region) {
        console.log(
          `ListBuckets signature rejected; retrying with home region ${error.Region}` +
          (filterRegion ? ` (filter BucketRegion=${filterRegion})` : '')
        );
        try {
          const retryClient = new S3Client({
            ...(this.originalConfig
              && this.originalConfig.endpoint
              && !isStandardAwsEndpoint(this.originalConfig.endpoint)
              ? { endpoint: this.originalConfig.endpoint }
              : {}),
            region: error.Region,
            credentials: buildCredentials(this.originalConfig || {}),
            followRegionRedirects: true
          });
          return await paginate(retryClient, params);
        } catch (retryErr) {
          throw enhanceCredentialError(retryErr, this.originalConfig || {});
        }
      }

      // Re-throw other errors (with credential-aware messages when applicable)
      throw enhanceCredentialError(error, this.originalConfig || {});
    }
  }

  /**
   * List objects in a bucket with optional prefix
   * @param {string} bucket - Bucket name
   * @param {string} prefix - Optional prefix (folder path)
   * @returns {Promise<Object>} Object containing folders and files
   */
  async listObjects(bucket, prefix = '') {
    try {
      const client = await this.getClientForBucket(bucket);
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/'
      });

      const response = await client.send(command);
      
      // Process folders (CommonPrefixes)
      const folders = (response.CommonPrefixes || []).map(prefix => ({
        Key: prefix.Prefix,
        isFolder: true,
        LastModified: null,
        Size: 0
      }));

      // Process files with additional metadata
      const files = (response.Contents || []).map(obj => ({
        ...obj,
        isFolder: false,
        ContentType: obj.Key.split('.').pop() || 'unknown',
        StorageClass: obj.StorageClass || 'STANDARD'
      }));

      return { 
        type: 'objects', 
        data: [...folders, ...files].filter(item => item.Key !== prefix) // Remove current prefix from list
      };
    } catch (error) {
      // Check if this is a region mismatch error but don't auto-switch
      if (error.Code === 'AuthorizationHeaderMalformed' && error.Region) {
        console.log(`Region mismatch detected. Signing region: ${this.baseRegion}, S3 expects: ${error.Region}`);
        // Remember the correct region so subsequent operations (including
        // presigned downloads) sign against it, then retry once.
        bucketRegionCache.set(bucket, error.Region);
        try {
          const client = await this.getClientForBucket(bucket);
          const retry = await client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/'
          }));
          const folders = (retry.CommonPrefixes || []).map(p => ({
            Key: p.Prefix,
            isFolder: true,
            LastModified: null,
            Size: 0
          }));
          const files = (retry.Contents || []).map(obj => ({
            ...obj,
            isFolder: false,
            ContentType: obj.Key.split('.').pop() || 'unknown',
            StorageClass: obj.StorageClass || 'STANDARD'
          }));
          return {
            type: 'objects',
            data: [...folders, ...files].filter(item => item.Key !== prefix)
          };
        } catch (retryError) {
          throw enhanceCredentialError(retryError, this.originalConfig || {});
        }
      }
      
      // Re-throw other errors (with credential-aware messages when applicable)
      throw enhanceCredentialError(error, this.originalConfig || {});
    }
  }

  /**
   * Upload an object to S3
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {Buffer|Readable} body - Object content
   * @returns {Promise<Object>} Result of the upload operation
   */
  async uploadObject(bucket, key, body, options = {}) {
    const client = await this.getClientForBucket(bucket);
    const params = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ...(Number.isFinite(options.contentLength) ? { ContentLength: options.contentLength } : {})
    };

    if (options.onProgress || typeof body?.pipe === 'function') {
      const upload = new Upload({
        client,
        params,
        queueSize: 2,
        // Keep memory bounded and stay below S3's 10,000-part limit.
        partSize: Math.max(8 * 1024 * 1024, Math.ceil((options.contentLength || 0) / 10000)),
        leavePartsOnError: false
      });
      upload.on('httpUploadProgress', progress => options.onProgress?.(progress.loaded));
      const response = await upload.done();
      return { success: true, response };
    }

    const response = await client.send(new PutObjectCommand(params));
    return { success: true, response };
  }

  /**
   * Download an object from S3
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @returns {Promise<Object>} Object containing the content and metadata
   */
  async getObject(bucket, key) {
    const client = await this.getClientForBucket(bucket);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    return await client.send(command);
  }

  /**
   * Generate a signed URL for temporary access to an object
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {number} expiresIn - URL expiration time in seconds
   * @returns {Promise<string>} Signed URL
   */
  async getSignedUrl(bucket, key, expiresIn = 3600) {
    // Sign with a region-correct client: the browser consuming this URL cannot
    // follow S3's region redirect.
    const client = await this.getClientForBucket(bucket);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    return await getSignedUrl(client, command, { expiresIn });
  }

  /**
   * Generate a URL for an object with different operations
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {string} operation - Operation type ('download' or 'view')
   * @returns {Promise<string>} URL for the specified operation
   */
  async getObjectUrl(bucket, key, operation = 'download') {
    console.log(`S3 getObjectUrl - Bucket: ${bucket}, Key: ${key}, Operation: ${operation}`);

    // A presigned URL is fetched directly by Chromium, which cannot follow the
    // `301 PermanentRedirect` S3 returns when the signing region does not match
    // the bucket's home region — it would save the XML error body as the file.
    // So always sign with a client pinned to the bucket's real region.
    const client = await this.getClientForBucket(bucket);
    const signingRegion = typeof client.config.region === 'function'
      ? await client.config.region()
      : client.config.region;
    console.log(`Signing ${operation} URL with region: ${signingRegion}`);

    const fileExtension = key.split('.').pop().toLowerCase();
    const isPdf = fileExtension === 'pdf';

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // For 'view' operations, don't set ContentDisposition
      // For 'download', set it to attachment with the filename
      ...(operation === 'download' ? {
        ResponseContentDisposition: downloadContentDisposition(key)
      } : 
      // For PDFs specifically in view mode, set Content-Type to application/pdf
      (isPdf && operation === 'view') ? {
        ResponseContentType: 'application/pdf'
      } : {})
    });

    const signedUrl = await getSignedUrl(client, command, { expiresIn: 3600 });
    console.log(`Generated signed URL with ${operation} disposition`);
    return signedUrl;
  }

  /**
   * Delete an object from S3
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @returns {Promise<Object>} Result of the delete operation
   */
  async deleteObject(bucket, key) {
    const client = await this.getClientForBucket(bucket);
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    });

    const response = await client.send(command);
    return { success: true, response };
  }

  /**
   * Delete multiple objects from S3
   * @param {string} bucket - Bucket name
   * @param {Array<string>} keys - Array of object keys
   * @returns {Promise<Object>} Result of the batch delete operation
   */
  async deleteObjects(bucket, keys) {
    const client = await this.getClientForBucket(bucket);
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keys.map(key => ({ Key: key })),
        Quiet: false
      }
    });

    const response = await client.send(command);
    return {
      success: true,
      deleted: response.Deleted || [],
      errors: response.Errors || []
    };
  }

  /**
   * Create a folder in S3 (empty object with trailing slash)
   * @param {string} bucket - Bucket name
   * @param {string} folderPath - Folder path to create
   * @returns {Promise<Object>} Result of the folder creation
   */
  async createFolder(bucket, folderPath) {
    // Ensure the folder path ends with a slash
    const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;

    const client = await this.getClientForBucket(bucket);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: normalizedPath,
      Body: ''
    });

    const response = await client.send(command);
    return { success: true, response };
  }
}

module.exports = AWSS3Client;
// Exposed for tests and for callers that need to reset the shared cache.
module.exports.bucketRegionCache = bucketRegionCache;
module.exports.isStandardAwsEndpoint = isStandardAwsEndpoint;
module.exports.normalizeLocationConstraint = normalizeLocationConstraint;
