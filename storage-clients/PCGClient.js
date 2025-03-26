/**
 * PCG (ParallelCluster) Storage Client Implementation
 * PCG typically uses S3 compatible storage interfaces
 */

const AWSS3Client = require('./AWSS3Client');

class PCGClient extends AWSS3Client {
  constructor() {
    super();
    this.type = 'pcg';
  }

  /**
   * Initialize the PCG client with connection details
   * @param {Object} config - PCG connection configuration
   * @returns {PCGClient} This instance
   */
  initialize(config) {
    // PCG typically uses S3 compatible endpoints, but may have specific configurations
    this.client = super.initialize({
      endpoint: config.endpoint,
      region: config.region || 'us-east-1',
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      // Add any PCG-specific configs here
      // For example, PCG may have specialized endpoints or authentication
    }).client;
    
    return this;
  }

  /**
   * List all buckets in the PCG account
   * PCG may have specific bucket listing behavior or additional metadata
   * @returns {Promise<Array>} List of buckets
   */
  async listBuckets() {
    try {
      const buckets = await super.listBuckets();
      
      // Add PCG specific metadata to each bucket
      return buckets.map(bucket => ({
        ...bucket,
        // Add PCG specific properties if needed
        IsPCGBucket: true
      }));
    } catch (error) {
      console.error('Error listing PCG buckets:', error);
      throw error;
    }
  }

  /**
   * PCG may have different folder structure or object listing behavior
   * This method can be overridden if necessary
   */
  async listObjects(bucket, prefix = '') {
    try {
      const result = await super.listObjects(bucket, prefix);
      
      // Add any PCG-specific processing here if needed
      
      return result;
    } catch (error) {
      console.error('Error listing PCG objects:', error);
      throw error;
    }
  }
  
  /**
   * PCG may have different object metadata or storage classes
   * This utility method helps map PCG-specific storage classes to display names
   * @private
   * @param {string} storageClass - Storage class from PCG/S3
   * @returns {string} Human-readable storage class name
   */
  _mapStorageClass(storageClass) {
    // Map PCG storage classes to display names
    const storageClassMap = {
      'STANDARD': 'Standard',
      'REDUCED_REDUNDANCY': 'Reduced Redundancy',
      'STANDARD_IA': 'Infrequent Access',
      'ONEZONE_IA': 'One Zone-IA',
      'INTELLIGENT_TIERING': 'Intelligent-Tiering',
      'GLACIER': 'Glacier',
      'DEEP_ARCHIVE': 'Deep Archive',
      // Add PCG-specific storage classes here
      'PCG_ARCHIVE': 'PCG Archive',
      'PCG_STANDARD': 'PCG Standard'
    };
    
    return storageClassMap[storageClass] || storageClass;
  }
}

module.exports = PCGClient; 