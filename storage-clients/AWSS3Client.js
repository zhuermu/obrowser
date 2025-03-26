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
const StorageClientInterface = require('./StorageClientInterface');

class AWSS3Client extends StorageClientInterface {
  constructor() {
    super();
    this.client = null;
  }

  /**
   * Initialize the S3 client with connection details
   * @param {Object} config - S3 connection configuration
   * @returns {AWSS3Client} This instance
   */
  async initialize(config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey
      }
    });
    
    // Store original config for potential reconnection
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
          // Log non-fatal errors but don't block initialization
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
    try {
      const response = await this.client.send(new ListBucketsCommand({}));
      return response.Buckets || [];
    } catch (error) {
      // Check if this is a region mismatch error but don't auto-switch
      if (error.Code === 'AuthorizationHeaderMalformed' && error.Region) {
        console.log(`Region mismatch detected. User specified: ${this.client.config.region}, S3 expects: ${error.Region}`);
        console.log('Not auto-switching regions as per application settings');
        
        // Return an empty array instead of switching regions
        return [];
      }
      
      // Re-throw other errors
      throw error;
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
      
      // Re-throw other errors
      throw error;
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