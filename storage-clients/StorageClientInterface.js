/**
 * Storage Client Interface Definition
 * This interface defines the common methods that all storage client implementations must provide.
 */

class StorageClientInterface {
  /**
   * List all buckets/containers available in the account
   * @returns {Promise<Array>} List of buckets/containers
   */
  async listBuckets() {
    throw new Error('Method not implemented');
  }

  /**
   * List objects within a bucket/container with optional prefix
   * @param {string} bucket - Bucket/container name
   * @param {string} prefix - Optional prefix for listing objects (folder path)
   * @returns {Promise<Object>} Object containing folders and files
   */
  async listObjects(bucket, prefix = '') {
    throw new Error('Method not implemented');
  }

  /**
   * Upload an object to the storage
   * @param {string} bucket - Bucket/container name
   * @param {string} key - Object key/path
   * @param {Buffer|Readable} body - Object content
   * @returns {Promise<Object>} Result of the upload operation
   */
  async uploadObject(bucket, key, body) {
    throw new Error('Method not implemented');
  }

  /**
   * Download an object from the storage
   * @param {string} bucket - Bucket/container name
   * @param {string} key - Object key/path
   * @returns {Promise<Object>} Object containing the content and metadata
   */
  async getObject(bucket, key) {
    throw new Error('Method not implemented');
  }

  /**
   * Generate a signed URL for temporary access to an object
   * @param {string} bucket - Bucket/container name
   * @param {string} key - Object key/path
   * @param {number} expiresIn - URL expiration time in seconds
   * @returns {Promise<string>} Signed URL
   */
  async getSignedUrl(bucket, key, expiresIn = 3600) {
    throw new Error('Method not implemented');
  }

  /**
   * Delete an object from the storage
   * @param {string} bucket - Bucket/container name
   * @param {string} key - Object key/path
   * @returns {Promise<Object>} Result of the delete operation
   */
  async deleteObject(bucket, key) {
    throw new Error('Method not implemented');
  }

  /**
   * Delete multiple objects from the storage
   * @param {string} bucket - Bucket/container name
   * @param {Array<string>} keys - Array of object keys/paths
   * @returns {Promise<Object>} Result of the batch delete operation
   */
  async deleteObjects(bucket, keys) {
    throw new Error('Method not implemented');
  }

  /**
   * Create a folder in the storage (usually by creating an empty object with trailing slash)
   * @param {string} bucket - Bucket/container name
   * @param {string} folderPath - Folder path to create
   * @returns {Promise<Object>} Result of the folder creation
   */
  async createFolder(bucket, folderPath) {
    throw new Error('Method not implemented');
  }

  /**
   * Initialize the client with connection details
   * @param {Object} config - Configuration object containing connection details
   * @returns {Object} Initialized client
   */
  initialize(config) {
    throw new Error('Method not implemented');
  }
}

module.exports = StorageClientInterface; 