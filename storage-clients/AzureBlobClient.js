/**
 * Azure Blob Storage Client Implementation
 */

const { 
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions
} = require('@azure/storage-blob');
const StorageClientInterface = require('./StorageClientInterface');

class AzureBlobClient extends StorageClientInterface {
  constructor() {
    super();
    this.client = null;
    this.accountName = '';
    this.accountKey = '';
    this.sharedKeyCredential = null;
  }

  /**
   * Initialize the Azure Blob client with connection details
   * @param {Object} config - Azure connection configuration
   * @returns {AzureBlobClient} This instance
   */
  initialize(config) {
    this.accountName = config.accountName;
    this.accountKey = config.accountKey;
    
    this.sharedKeyCredential = new StorageSharedKeyCredential(
      this.accountName,
      this.accountKey
    );
    
    const endpoint = config.endpoint || `https://${this.accountName}.blob.core.windows.net`;
    
    this.client = new BlobServiceClient(
      endpoint,
      this.sharedKeyCredential
    );
    
    return this;
  }

  /**
   * List all containers in the account (equivalent to S3 buckets)
   * @returns {Promise<Array>} List of containers
   */
  async listBuckets() {
    const containers = [];
    
    // Azure uses async iterators for listing
    for await (const container of this.client.listContainers()) {
      containers.push({
        Name: container.name,
        CreationDate: container.properties.lastModified,
        // Adding properties to match S3 format
        IsAzureContainer: true
      });
    }
    
    return containers;
  }

  /**
   * List blobs in a container with optional prefix
   * @param {string} container - Container name
   * @param {string} prefix - Optional prefix (folder path)
   * @returns {Promise<Object>} Object containing folders and files
   */
  async listObjects(container, prefix = '') {
    const containerClient = this.client.getContainerClient(container);
    const folders = new Map();
    const files = [];
    
    // Normalize prefix to ensure consistent handling
    const normalizedPrefix = prefix ? (prefix.endsWith('/') ? prefix : `${prefix}/`) : '';
    
    // Azure doesn't have built-in hierarchy, so we simulate it
    const options = {
      prefix: normalizedPrefix
    };
    
    // Use async iterator to get all blobs
    for await (const blob of containerClient.listBlobsFlat(options)) {
      const blobName = blob.name;
      
      // Skip the exact prefix itself
      if (blobName === normalizedPrefix) continue;
      
      // Check if this is a "folder" (Azure doesn't have real folders)
      if (blobName.endsWith('/')) {
        // This is a placeholder blob representing a folder
        const folderName = blobName.substring(normalizedPrefix.length);
        if (!folderName) continue; // Skip if this is the current folder
        
        folders.set(blobName, {
          Key: blobName,
          isFolder: true,
          LastModified: blob.properties.lastModified,
          Size: 0
        });
      } else {
        // Extract folder path from the blob name
        const blobPath = blobName.substring(normalizedPrefix.length);
        const pathParts = blobPath.split('/');
        
        if (pathParts.length > 1) {
          // This blob is inside a subfolder
          const folderPath = normalizedPrefix + pathParts.slice(0, -1).join('/') + '/';
          
          // Only add the immediate child folder
          if (!folders.has(folderPath) && pathParts.length === 2) {
            folders.set(folderPath, {
              Key: folderPath,
              isFolder: true,
              LastModified: null,
              Size: 0
            });
          }
        } else {
          // This is a regular blob in the current folder
          files.push({
            Key: blobName,
            isFolder: false,
            LastModified: blob.properties.lastModified,
            Size: blob.properties.contentLength,
            ContentType: blob.properties.contentType || 'application/octet-stream',
            StorageClass: 'Standard',
            ETag: blob.properties.etag
          });
        }
      }
    }
    
    return {
      type: 'objects',
      data: [...folders.values(), ...files]
    };
  }

  /**
   * Upload a blob to Azure Storage
   * @param {string} container - Container name
   * @param {string} blobName - Blob name
   * @param {Buffer|Readable} content - Blob content
   * @returns {Promise<Object>} Result of the upload operation
   */
  async uploadObject(container, blobName, content) {
    const containerClient = this.client.getContainerClient(container);
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    
    const uploadOptions = {
      blobHTTPHeaders: {
        blobContentType: this._getContentType(blobName)
      }
    };
    
    const result = await blockBlobClient.upload(content, content.length, uploadOptions);
    
    return {
      success: true,
      etag: result.etag,
      lastModified: result.lastModified
    };
  }

  /**
   * Download a blob from Azure Storage
   * @param {string} container - Container name
   * @param {string} blobName - Blob name
   * @returns {Promise<Object>} Object containing the content and metadata
   */
  async getObject(container, blobName) {
    const containerClient = this.client.getContainerClient(container);
    const blobClient = containerClient.getBlobClient(blobName);
    
    const downloadResponse = await blobClient.download();
    
    return {
      Body: downloadResponse.readableStreamBody,
      ContentType: downloadResponse.contentType,
      ContentLength: downloadResponse.contentLength,
      LastModified: downloadResponse.lastModified,
      Metadata: downloadResponse.metadata
    };
  }

  /**
   * Generate a signed URL for temporary access to a blob
   * @param {string} container - Container name
   * @param {string} blobName - Blob name
   * @param {number} expiresIn - URL expiration time in seconds
   * @returns {Promise<string>} Signed URL
   */
  async getSignedUrl(container, blobName, expiresIn = 3600) {
    const containerClient = this.client.getContainerClient(container);
    const blobClient = containerClient.getBlobClient(blobName);
    
    // Create SAS token with read permission
    const sasOptions = {
      containerName: container,
      blobName: blobName,
      permissions: BlobSASPermissions.parse("r"), // Read permission
      startsOn: new Date(),
      expiresOn: new Date(new Date().valueOf() + expiresIn * 1000)
    };
    
    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      this.sharedKeyCredential
    ).toString();
    
    // Return full URL with SAS token
    return `${blobClient.url}?${sasToken}`;
  }

  /**
   * Generate a URL for an object with different operations
   * @param {string} container - Container name
   * @param {string} blobName - Blob name
   * @param {string} operation - Operation type ('download' or 'view')
   * @returns {Promise<string>} URL for the specified operation
   */
  async getObjectUrl(container, blobName, operation = 'download') {
    console.log(`Azure getObjectUrl - Container: ${container}, Blob: ${blobName}, Operation: ${operation}`);
    
    const containerClient = this.client.getContainerClient(container);
    const blobClient = containerClient.getBlobClient(blobName);
    
    // Create SAS token with read permission
    const sasOptions = {
      containerName: container,
      blobName: blobName,
      permissions: BlobSASPermissions.parse("r"), // Read permission
      startsOn: new Date(),
      expiresOn: new Date(new Date().valueOf() + 3600 * 1000)
    };
    
    // For download operations, set content disposition
    if (operation === 'download') {
      sasOptions.contentDisposition = `attachment; filename="${blobName.split('/').pop()}"`;
    }
    
    const sasToken = generateBlobSASQueryParameters(
      sasOptions,
      this.sharedKeyCredential
    ).toString();
    
    // Return full URL with SAS token
    const url = `${blobClient.url}?${sasToken}`;
    console.log(`Generated Azure URL with ${operation} disposition`);
    return url;
  }

  /**
   * Delete a blob from Azure Storage
   * @param {string} container - Container name
   * @param {string} blobName - Blob name
   * @returns {Promise<Object>} Result of the delete operation
   */
  async deleteObject(container, blobName) {
    const containerClient = this.client.getContainerClient(container);
    const blobClient = containerClient.getBlobClient(blobName);
    
    await blobClient.delete();
    
    return { success: true };
  }

  /**
   * Delete multiple blobs from Azure Storage
   * @param {string} container - Container name
   * @param {Array<string>} blobNames - Array of blob names
   * @returns {Promise<Object>} Result of the batch delete operation
   */
  async deleteObjects(container, blobNames) {
    const containerClient = this.client.getContainerClient(container);
    const deleted = [];
    const errors = [];
    
    // Azure doesn't have a batch delete, so we need to delete each blob individually
    for (const blobName of blobNames) {
      try {
        const blobClient = containerClient.getBlobClient(blobName);
        await blobClient.delete();
        deleted.push({ Key: blobName });
      } catch (err) {
        errors.push({
          Key: blobName,
          Code: err.statusCode || 'Error',
          Message: err.message
        });
      }
    }
    
    return {
      success: errors.length === 0,
      deleted,
      errors
    };
  }

  /**
   * Create a folder in Azure Storage (empty blob with trailing slash)
   * @param {string} container - Container name
   * @param {string} folderPath - Folder path to create
   * @returns {Promise<Object>} Result of the folder creation
   */
  async createFolder(container, folderPath) {
    // Ensure the folder path ends with a slash
    const normalizedPath = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
    
    const containerClient = this.client.getContainerClient(container);
    const blockBlobClient = containerClient.getBlockBlobClient(normalizedPath);
    
    // Upload empty content to represent a folder
    const result = await blockBlobClient.upload('', 0, {
      blobHTTPHeaders: {
        blobContentType: 'application/directory'
      }
    });
    
    return { success: true, etag: result.etag };
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

module.exports = AzureBlobClient; 