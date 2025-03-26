/**
 * Storage Client Factory
 * Creates appropriate storage client instances based on the connection type
 */

const StorageClientInterface = require('./StorageClientInterface');
const AWSS3Client = require('./AWSS3Client');
const AzureBlobClient = require('./AzureBlobClient');
const AliyunOSSClient = require('./AliyunOSSClient');
const PCGClient = require('./PCGClient');

// Map of connection types to client classes
const CLIENT_TYPES = {
  'aws-s3': AWSS3Client,
  'azure-blob': AzureBlobClient,
  'aliyun-oss': AliyunOSSClient,
  'pcg': PCGClient,
  // Add more client types here
};

class StorageClientFactory {
  /**
   * Create a new storage client based on connection type
   * @param {string} type - Connection type (e.g., 'aws-s3', 'azure-blob', etc.)
   * @param {Object} config - Connection configuration
   * @returns {StorageClientInterface} Initialized storage client instance
   */
  static async createClient(type, config) {
    const ClientClass = CLIENT_TYPES[type];
    
    if (!ClientClass) {
      throw new Error(`Unsupported storage client type: ${type}`);
    }
    
    const client = new ClientClass();
    
    // Handle both async and sync initialize methods
    try {
      await client.initialize(config);
    } catch (error) {
      console.error(`Error initializing client of type ${type}:`, error);
      throw error;
    }
    
    return client;
  }

  /**
   * Register a new client type
   * @param {string} type - Connection type identifier
   * @param {class} ClientClass - Client class that implements StorageClientInterface
   */
  static registerClientType(type, ClientClass) {
    // Ensure the class extends StorageClientInterface
    if (!(ClientClass.prototype instanceof StorageClientInterface)) {
      throw new Error('Client class must implement StorageClientInterface');
    }
    
    CLIENT_TYPES[type] = ClientClass;
  }

  /**
   * Get list of supported client types
   * @returns {Array<string>} Array of supported client type identifiers
   */
  static getSupportedClientTypes() {
    return Object.keys(CLIENT_TYPES);
  }
}

module.exports = StorageClientFactory; 