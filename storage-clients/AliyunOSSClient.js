/**
 * Aliyun OSS Client Implementation
 */

const OSS = require('ali-oss');
const StorageClientInterface = require('./StorageClientInterface');

class AliyunOSSClient extends StorageClientInterface {
  constructor() {
    super();
    this.client = null;
  }

  /**
   * Initialize the Aliyun OSS client with connection details
   * @param {Object} config - Aliyun OSS connection configuration
   * @returns {AliyunOSSClient} This instance
   */
  initialize(config) {
    const clientConfig = {
      accessKeyId: config.accessKey,
      accessKeySecret: config.secretKey,
      bucket: config.bucket || null,
      secure: true, // Always use HTTPS
      timeout: config.timeout || 60000
    };

    // If endpoint is provided, use it directly (region not required)
    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    } else if (config.region) {
      // Fallback to using region if endpoint is not provided
      clientConfig.region = config.region;
    }
    // At least one of endpoint or region must be provided
    
    this.client = new OSS(clientConfig);
    
    return this;
  }

  /**
   * List all buckets in the account
   * @returns {Promise<Array>} List of buckets
   */
  async listBuckets() {
    try {
      const result = await this.client.listBuckets();
      
      return result.buckets.map(bucket => ({
        Name: bucket.name,
        CreationDate: bucket.creationDate,
        Location: bucket.region,
        StorageClass: bucket.storageClass,
        // Adding property to identify as Aliyun OSS bucket
        IsAliyunOSS: true
      }));
    } catch (error) {
      console.error('Error listing buckets:', error);
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
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      const normalizedPrefix = prefix;
      const delimiter = '/';
      
      const result = await this.client.list({
        prefix: normalizedPrefix,
        delimiter,
        'max-keys': 1000
      });
      
      const folders = [];
      const files = [];
      
      // Process folders (commonPrefixes)
      if (result.prefixes) {
        result.prefixes.forEach(prefixPath => {
          folders.push({
            Key: prefixPath,
            isFolder: true,
            LastModified: null,
            Size: 0
          });
        });
      }
      
      // Process files
      if (result.objects) {
        result.objects.forEach(object => {
          // Skip if this is the prefix marker itself or folder marker
          if (object.name === normalizedPrefix) return;
          
          // Check if this is a folder marker (empty object with trailing slash)
          if (object.name.endsWith('/')) {
            folders.push({
              Key: object.name,
              isFolder: true,
              LastModified: object.lastModified,
              Size: 0
            });
          } else {
            files.push({
              Key: object.name,
              isFolder: false,
              LastModified: object.lastModified,
              Size: object.size,
              ETag: object.etag,
              StorageClass: object.storageClass,
              ContentType: this._getContentType(object.name),
              Type: object.type
            });
          }
        });
      }
      
      return {
        type: 'objects',
        data: [...folders, ...files]
      };
    } catch (error) {
      console.error('Error listing objects:', error);
      throw error;
    }
  }

  /**
   * Upload an object to Aliyun OSS
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {Buffer|Readable} body - Object content
   * @returns {Promise<Object>} Result of the upload operation
   */
  async uploadObject(bucket, key, body) {
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      const options = {
        mime: this._getContentType(key)
      };
      
      const result = await this.client.put(key, body, options);
      
      return {
        success: true,
        etag: result.etag,
        url: result.url,
        name: result.name
      };
    } catch (error) {
      console.error('Error uploading object:', error);
      throw error;
    }
  }

  /**
   * Download an object from Aliyun OSS
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @returns {Promise<Object>} Object containing the content and metadata
   */
  async getObject(bucket, key) {
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      const result = await this.client.get(key);
      
      return {
        Body: result.content,
        ContentType: result.res.headers['content-type'],
        ContentLength: result.res.headers['content-length'],
        ETag: result.res.headers.etag,
        LastModified: result.res.headers['last-modified']
      };
    } catch (error) {
      console.error('Error downloading object:', error);
      throw error;
    }
  }

  /**
   * Generate a signed URL for temporary access to an object
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {number} expiresIn - URL expiration time in seconds
   * @returns {Promise<string>} Signed URL
   */
  async getSignedUrl(bucket, key, expiresIn = 3600) {
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      // Aliyun OSS library expects expiration in seconds
      const url = this.client.signatureUrl(key, {
        expires: expiresIn,
        method: 'GET'
      });
      
      return url;
    } catch (error) {
      console.error('Error generating signed URL:', error);
      throw error;
    }
  }

  /**
   * Generate a URL for a specific operation (download/view) on an object
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @param {string} operation - Operation type ('download' or 'view')
   * @returns {Promise<string>} URL for the specified operation
   */
  async getObjectUrl(bucket, key, operation = 'download') {
    console.log(`Aliyun OSS getObjectUrl - Bucket: ${bucket}, Key: ${key}, Operation: ${operation}`);
    
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      // For download operations, set the appropriate response headers
      const options = {
        expires: 3600,
        method: 'GET'
      };
      
      if (operation === 'download') {
        // Set Content-Disposition header for download
        const filename = key.split('/').pop();
        options.response = {
          'content-disposition': `attachment; filename="${filename}"`
        };
      } else if (operation === 'view') {
        // For view operations, explicitly do not set content-disposition
        // This ensures the content is displayed in the browser rather than downloaded
        options.response = {
          // No content-disposition header, allowing browser to determine how to handle
        };
      }
      
      const url = this.client.signatureUrl(key, options);
      console.log(`Generated Aliyun OSS signed URL with ${operation} disposition`);
      return url;
    } catch (error) {
      console.error('Error generating object URL:', error);
      throw error;
    }
  }

  /**
   * Delete an object from Aliyun OSS
   * @param {string} bucket - Bucket name
   * @param {string} key - Object key
   * @returns {Promise<Object>} Result of the delete operation
   */
  async deleteObject(bucket, key) {
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      const result = await this.client.delete(key);
      
      return {
        success: true,
        res: {
          status: result.res.status,
          statusCode: result.res.statusCode
        }
      };
    } catch (error) {
      console.error('Error deleting object:', error);
      throw error;
    }
  }

  /**
   * Delete multiple objects from Aliyun OSS
   * @param {string} bucket - Bucket name
   * @param {Array<string>} keys - Array of object keys
   * @returns {Promise<Object>} Result of the batch delete operation
   */
  async deleteObjects(bucket, keys) {
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      const result = await this.client.deleteMulti(keys);
      
      return {
        success: true,
        deleted: result.deleted,
        errors: [] // Aliyun OSS client throws error if any deletion fails
      };
    } catch (error) {
      console.error('Error deleting multiple objects:', error);
      throw error;
    }
  }

  /**
   * Create a folder in Aliyun OSS (empty object with trailing slash)
   * @param {string} bucket - Bucket name
   * @param {string} folderPath - Folder path to create
   * @returns {Promise<Object>} Result of the folder creation
   */
  async createFolder(bucket, folderPath) {
    try {
      // Update the client bucket if needed
      if (bucket !== this.client.options.bucket) {
        this.client.useBucket(bucket);
      }
      
      // Ensure the folder path ends with a slash
      const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
      
      const result = await this.client.put(normalizedPath, Buffer.from(''), {
        mime: 'application/x-directory'
      });
      
      return {
        success: true,
        etag: result.etag,
        name: result.name
      };
    } catch (error) {
      console.error('Error creating folder:', error);
      throw error;
    }
  }

  /**
   * Determine content type based on file extension
   * @private
   * @param {string} filename - The filename to check
   * @returns {string} Content type
   */
  _getContentType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const contentTypes = {
      'txt': 'text/plain',
      'html': 'text/html',
      'htm': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'zip': 'application/zip',
      'mp3': 'audio/mpeg',
      'mp4': 'video/mp4'
    };
    
    return contentTypes[ext] || 'application/octet-stream';
  }
}

module.exports = AliyunOSSClient; 