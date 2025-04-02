const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');
const fs = require('fs');

// Import storage client factory
const StorageClientFactory = require('./storage-clients/StorageClientFactory');

const store = new Store();

// Set application ID for Windows
if (process.platform === 'win32') {
  app.setAppUserModelId('com.obrowser.app');
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.resolve(__dirname, process.platform === 'darwin' ? 'obrowser.icns' : process.platform === 'win32' ? 'obrowser.ico' : 'obrowser.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      devTools: true // Allow DevTools but don't open by default
    }
  });

  mainWindow.loadFile('index.html');

  // Create the application menu
  const template = [
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: 'CmdOrCtrl+R' },
        { role: 'forceReload', accelerator: 'CmdOrCtrl+Shift+R' },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'CmdOrCtrl+Shift+I' }
      ]
    }
  ];

  // Add macOS specific menu items
  if (process.platform === 'darwin') {
    template.unshift({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Log errors
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['debug', 'info', 'warning', 'error'];
    console.log(`[${levels[level] || 'info'}] ${message}`);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Get storage client for a connection
async function getStorageClient(connectionId) {
  const connections = store.get('connections', []);
  const connection = connections.find(conn => conn.id === connectionId);
  
  if (!connection) {
    console.error(`Connection not found with ID: ${connectionId}`);
    console.log('Available connections:', connections.map(c => ({ id: c.id, name: c.name })));
    throw new Error(`Connection not found: ${connectionId}`);
  }

  // Map storage type from connection type
  // Default to 'aws-s3' for backward compatibility with existing connections
  const storageType = connection.type || 'aws-s3';
  
  // Log connection details for debugging
  console.log(`Creating storage client for connection ID: ${connectionId}`);
  console.log(`Connection type: ${storageType}`);
  console.log(`Connection endpoint: ${connection.endpoint}`);
  console.log(`Connection region: ${connection.region}`);
  
  // Always create a new client instance to avoid caching issues
  return await StorageClientFactory.createClient(storageType, {...connection});
}

// Get supported client types
ipcMain.handle('get-supported-client-types', async () => {
  return StorageClientFactory.getSupportedClientTypes();
});

// S3 Connection Management
// Connection Management
ipcMain.handle('save-connection', async (event, connection) => {
  const connections = store.get('connections', []);
  connections.push(connection);
  store.set('connections', connections);
  return connections;
});

ipcMain.handle('save-connections', async (event, connections) => {
  store.set('connections', connections);
  return connections;
});

ipcMain.handle('get-connections', async () => {
  return store.get('connections', []);
});

ipcMain.handle('delete-connection', async (event, id) => {
  const connections = store.get('connections', []);
  const updatedConnections = connections.filter(conn => conn.id !== id);
  store.set('connections', updatedConnections);
  return updatedConnections;
});

// File Dialog Operations
ipcMain.handle('show-save-dialog', async () => {
  const result = await dialog.showSaveDialog({
    properties: ['createDirectory']
  });
  return result.filePath;
});

ipcMain.handle('show-open-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections']
  });
  return result.filePaths;
});

// Storage Operations
ipcMain.handle('list-buckets', async (event, connectionId) => {
  try {
    const connections = store.get('connections', []);
    const connection = connections.find(conn => conn.id === connectionId);
    
    if (!connection) {
      console.error(`Connection not found with ID: ${connectionId}`);
      throw new Error('Connection not found');
    }
    
    console.log(`Listing buckets for connection: ${connection.name} (ID: ${connectionId})`);
    console.log(`Connection type: ${connection.type}, Region: ${connection.region}, Endpoint: ${connection.endpoint}`);
    
    const client = await getStorageClient(connectionId);
    const buckets = await client.listBuckets();
    console.log(`Retrieved ${buckets.length} buckets`);
    return buckets;
  } catch (error) {
    console.error('Error listing buckets:', error);
    throw error;
  }
});

ipcMain.handle('list-objects', async (event, connectionId, bucket = null, prefix = '') => {
  try {
    const connections = store.get('connections', []);
    const connection = connections.find(conn => conn.id === connectionId);
    
    if (!connection) {
      console.error(`Connection not found with ID: ${connectionId}`);
      throw new Error('Connection not found');
    }
    
    console.log(`Listing objects for connection: ${connection.name} (ID: ${connectionId})`);
    console.log(`Connection type: ${connection.type}, Region: ${connection.region}, Endpoint: ${connection.endpoint}`);
    console.log(`Target bucket: ${bucket || connection.bucket || 'None specified'}`);
    console.log(`Prefix: ${prefix || 'root'}`);

    // Create a fresh storage client for this operation
    const client = await getStorageClient(connectionId);

    // If no bucket is specified, use the connection's default bucket if available
    const targetBucket = bucket || connection.bucket;
    if (!targetBucket) {
      console.log('No bucket specified, listing available buckets');
      const buckets = await client.listBuckets();
      return { type: 'buckets', data: buckets };
    }

    console.log(`Listing objects in bucket: ${targetBucket} with prefix: ${prefix}`);
    const response = await client.listObjects(targetBucket, prefix);
    console.log(`Received ${response.data ? response.data.length : 0} objects/folders`);
    return response;
  } catch (error) {
    console.error('Error listing objects:', error);
    
    // Enhanced error handling for region mismatch
    if (error.Code === 'AuthorizationHeaderMalformed' && error.Region) {
      const expectedRegion = error.Region;
      const connections = store.get('connections', []);
      const connection = connections.find(conn => conn.id === connectionId);
      const configuredRegion = connection ? connection.region : 'unknown';
      
      // Create a more user-friendly error message
      const enhancedError = new Error(
        `Region mismatch: You configured the connection to use '${configuredRegion}' but the bucket is in '${expectedRegion}'. ` +
        `Please update your connection settings to use the correct region.`
      );
      
      // Preserve original error properties
      enhancedError.originalError = error;
      enhancedError.Code = error.Code;
      enhancedError.Region = error.Region;
      
      throw enhancedError;
    }
    
    throw error;
  }
});

ipcMain.handle('get-object-url', async (event, connectionId, bucket, key, operation) => {
  try {
    const connections = store.get('connections', []);
    const connection = connections.find(conn => conn.id === connectionId);
    
    if (!connection) {
      console.error(`Connection not found with ID: ${connectionId}`);
      throw new Error('Connection not found');
    }
    
    console.log(`Getting ${operation} URL for object: ${key}`);
    console.log(`Connection: ${connection.name} (ID: ${connectionId})`);
    console.log(`Bucket: ${bucket}, Connection type: ${connection.type}, Region: ${connection.region}`);
    
    const client = await getStorageClient(connectionId);
    const url = await client.getObjectUrl(bucket, key, operation);
    console.log(`Generated URL for ${operation}: ${url.substring(0, 100)}...`);
    return url;
  } catch (error) {
    console.error(`Error getting ${operation} URL:`, error);
    throw error;
  }
});

ipcMain.handle('upload-object', async (event, connectionId, bucket, key, filePath) => {
  try {
    const connections = store.get('connections', []);
    const connection = connections.find(conn => conn.id === connectionId);
    
    if (!connection) {
      console.error(`Connection not found with ID: ${connectionId}`);
      throw new Error('Connection not found');
    }
    
    console.log(`Uploading file to: ${bucket}/${key}`);
    console.log(`Connection: ${connection.name} (ID: ${connectionId})`);
    console.log(`Connection type: ${connection.type}, Region: ${connection.region}`);
    console.log(`File path: ${filePath}`);
    
    // Read the file content
    const fileContent = fs.readFileSync(filePath);
    
    const client = await getStorageClient(connectionId);
    await client.uploadObject(bucket, key, fileContent);
    console.log('Upload completed successfully');
    return { success: true };
  } catch (error) {
    console.error('Error uploading object:', error);
    throw error;
  }
});

ipcMain.handle('create-folder', async (event, connectionId, bucket, folderPath) => {
  try {
    const client = await getStorageClient(connectionId);
    return await client.createFolder(bucket, folderPath);
  } catch (error) {
    console.error('Error creating folder:', error);
    throw error;
  }
});

ipcMain.handle('preview-object', async (event, connectionId, bucket, key) => {
  try {
    const client = await getStorageClient(connectionId);
    const ext = key.split('.').pop()?.toLowerCase();

    // For text files, fetch and return content directly
    if (ext && ext.match(/^(txt|json|js|css|xml|md|markdown|yaml|yml|ini|csv|log)$/)) {
      const response = await client.getObject(bucket, key);
      let text;
      
      if (response.Body.transformToString) {
        // AWS S3 SDK response
        text = await response.Body.transformToString();
      } else if (Buffer.isBuffer(response.Body)) {
        // Buffer directly
        text = response.Body.toString('utf-8');
      } else if (response.Body.read) {
        // Readable stream
        text = await streamToString(response.Body);
      } else {
        // Handle other formats (e.g., Azure Blob)
        text = await streamToString(response.Body);
      }
      
      return { type: 'text', content: text };
    }

    // For all other files, generate a signed URL that expires in 1 hour
    const signedUrl = await client.getSignedUrl(bucket, key, 3600);
    return { type: ext, content: signedUrl };
  } catch (error) {
    console.error('Error previewing object:', error);
    throw error;
  }
});

// Helper function to convert stream to string
function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

ipcMain.handle('download-object', async (event, connectionId, key, bucket) => {
  try {
    const client = await getStorageClient(connectionId);
    const response = await client.getObject(bucket, key);
    
    // Show save dialog with default filename
    const defaultPath = path.basename(key);
    const { filePath } = await dialog.showSaveDialog({
      defaultPath: defaultPath,
      properties: ['createDirectory']
    });

    if (!filePath) return { success: false, cancelled: true };

    const writeStream = fs.createWriteStream(filePath);
    
    if (response.Body.pipe) {
      // Handle stream response
      await new Promise((resolve, reject) => {
        response.Body.pipe(writeStream)
          .on('finish', resolve)
          .on('error', reject);
      });
    } else if (Buffer.isBuffer(response.Body)) {
      // Handle buffer response
      fs.writeFileSync(filePath, response.Body);
    } else {
      // Handle other types of response
      throw new Error('Unsupported response type');
    }

    return { success: true, path: filePath };
  } catch (error) {
    console.error('Error downloading object:', error);
    throw error;
  }
});

ipcMain.handle('delete-object', async (event, connectionId, key, bucket, isFolder = false) => {
  try {
    const client = await getStorageClient(connectionId);
    
    if (isFolder) {
      let count = 0;
      
      // Ensure the folder key ends with '/'
      const folderKey = key.endsWith('/') ? key : key + '/';
      console.log('Deleting folder:', folderKey);

      // List all objects in the folder
      const result = await client.listObjects(bucket, folderKey);
      const objectsToDelete = result.data.map(item => item.Key);
      
      if (objectsToDelete.length > 0) {
        // Delete all objects in batch
        const deleteResult = await client.deleteObjects(bucket, objectsToDelete);
        count = deleteResult.deleted ? deleteResult.deleted.length : objectsToDelete.length;
      }

      // Delete the folder marker itself
      await client.deleteObject(bucket, folderKey);
      console.log(`Deleted folder marker ${folderKey}`);

      return { success: true, message: `${count} files and folder deleted.` };
    } else {
      await client.deleteObject(bucket, key);
      return { success: true, message: 'File deleted.' };
    }
  } catch (error) {
    console.error('Error deleting object:', error);
    throw error;
  }
});
