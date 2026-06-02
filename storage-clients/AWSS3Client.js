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
  DeleteObjectsCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { fromIni } = require('@aws-sdk/credential-providers');
const StorageClientInterface = require('./StorageClientInterface');

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
  }

  /**
   * Initialize the S3 client with connection details.
   * Supports multiple auth methods (see `buildCredentials`).
   * @param {Object} config - S3 connection configuration
   * @returns {AWSS3Client} This instance
   */
  async initialize(config) {
    const credentials = buildCredentials(config);

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
    if (config.endpoint && !isStandardAwsEndpoint(config.endpoint)) {
      clientConfig.endpoint = config.endpoint;
    }

    this.client = new S3Client(clientConfig);
    
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
        // Check if this is a region mismatch error
        if (error.Code === 'AuthorizationHeaderMalformed' && error.Region) {
          console.log(`Region mismatch detected during initialization. User specified: ${config.region}, S3 expects: ${error.Region}`);
          console.log('Not auto-switching regions as per application settings');
          
          // We'll continue with the user's specified region, even though we know it might cause issues
          // This is what the user requested - to not auto-switch regions
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
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/'
      });

      const response = await this.client.send(command);
      
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
        console.log(`Region mismatch detected. User specified: ${this.client.config.region}, S3 expects: ${error.Region}`);
        console.log('Not auto-switching regions as per application settings');
        
        // Return empty results instead of switching regions
        return { 
          type: 'objects', 
          data: [] 
        };
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
  async uploadObject(bucket, key, body) {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body
    });

    const response = await this.client.send(command);
    return { success: true, response };
  }

  /**
   * Download an object from S3
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @returns {Promise<Object>} Object containing the content and metadata
   */
  async getObject(bucket, key) {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    return await this.client.send(command);
  }

  /**
   * Generate a signed URL for temporary access to an object
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {number} expiresIn - URL expiration time in seconds
   * @returns {Promise<string>} Signed URL
   */
  async getSignedUrl(bucket, key, expiresIn = 3600) {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });

    return await getSignedUrl(this.client, command, { expiresIn });
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
    console.log(`Using credentials for region: ${this.client.config.region}`);
    
    const fileExtension = key.split('.').pop().toLowerCase();
    const isPdf = fileExtension === 'pdf';

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // For 'view' operations, don't set ContentDisposition
      // For 'download', set it to attachment with the filename
      ...(operation === 'download' ? {
        ResponseContentDisposition: `attachment; filename="${key.split('/').pop()}"`
      } : 
      // For PDFs specifically in view mode, set Content-Type to application/pdf
      (isPdf && operation === 'view') ? {
        ResponseContentType: 'application/pdf'
      } : {})
    });

    const signedUrl = await getSignedUrl(this.client, command, { expiresIn: 3600 });
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
    const command = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key
    });

    const response = await this.client.send(command);
    return { success: true, response };
  }

  /**
   * Delete multiple objects from S3
   * @param {string} bucket - Bucket name
   * @param {Array<string>} keys - Array of object keys
   * @returns {Promise<Object>} Result of the batch delete operation
   */
  async deleteObjects(bucket, keys) {
    const command = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: keys.map(key => ({ Key: key })),
        Quiet: false
      }
    });

    const response = await this.client.send(command);
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
    
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: normalizedPath,
      Body: ''
    });

    const response = await this.client.send(command);
    return { success: true, response };
  }
}

module.exports = AWSS3Client; 