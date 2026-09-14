const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const SimpleStore = require('./simple-store');
const fs = require('fs');
const { spawn } = require('child_process');
const { fromIni } = require('@aws-sdk/credential-providers');
const { verifyDownloadUrl } = require('./download-verifier');
const { parseResolvedProxy, chooseProxy, applyNetworkConfig } = require('./network-config');
const {
  listAwsProfiles,
  findExecutable,
  describeAdcCredential,
  isKnownProfileName
} = require('./credential-discovery');

// Import storage client factory
const StorageClientFactory = require('./storage-clients/StorageClientFactory');

const store = new SimpleStore();

// Per-connection region override applied in-memory for the current session.
// Set via the `set-region-override` IPC so the user can switch regions from
// the UI without mutating the saved connection config. Cleared when the
// connection is deselected or when the app restarts.
const regionOverrides = new Map();

// Handle uncaught exceptions to prevent EPIPE errors from crashing the app
process.on('uncaughtException', (error) => {
  // Ignore EPIPE errors which occur when stdout/stderr is closed
  if (error.code === 'EPIPE' || error.errno === 'EPIPE') {
    return;
  }
  // Log other errors
  console.error('Uncaught Exception:', error);
});

// Set application ID for Windows
if (process.platform === 'win32') {
  app.setAppUserModelId('com.obrowser.app');
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#fcfcfb',
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
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => mainWindow.webContents.send('select-all-items') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh Storage', accelerator: 'CmdOrCtrl+R', click: () => mainWindow.webContents.send('refresh-files') },
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

  // Log errors - with error handling to prevent EPIPE errors
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    // Use setImmediate to defer logging and avoid EPIPE errors
    setImmediate(() => {
      try {
        if (!mainWindow.isDestroyed() && process.stdout && process.stdout.writable) {
          const levels = ['debug', 'info', 'warning', 'error'];
          process.stdout.write(`[${levels[level] || 'info'}] ${message}\n`);
        }
      } catch (error) {
        // Silently ignore write errors when stdout is closed
      }
    });
  });
}

/**
 * Make the Node-side cloud SDKs usable on networks that require a proxy.
 *
 * Launched from Finder an app inherits no shell environment, so HTTPS_PROXY is
 * unset and SDK requests go out directly — which times out where the provider is
 * only reachable through a proxy. Chromium already knows the system proxy, so we
 * ask it and publish the result for the SDKs. See network-config.js for the
 * accompanying TLS note.
 */
async function configureNetworking() {
  let systemProxy = null;
  try {
    const { session } = require('electron');
    // Resolve against a real provider host: PAC scripts can answer per-URL.
    const resolved = await session.defaultSession.resolveProxy('https://storage.googleapis.com');
    systemProxy = parseResolvedProxy(resolved);
    console.log(`System proxy resolution: ${resolved} -> ${systemProxy || 'direct'}`);
  } catch (error) {
    console.warn(`Could not resolve the system proxy: ${error.message}`);
  }

  const { proxyUrl, source } = chooseProxy(process.env, systemProxy);
  const applied = applyNetworkConfig({ proxyUrl });
  if (applied.proxy) {
    console.log(`Using proxy ${applied.proxy} (from ${source}); TLS capped at ${applied.tlsMaxVersion}`);
  } else {
    console.log('No proxy configured; connecting directly.');
  }
}

app.whenReady().then(async () => {
  await configureNetworking();
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
  
  // Apply any in-memory region override (set by the region switcher UI).
  const override = regionOverrides.get(connectionId);
  const effectiveConnection = override
    ? { ...connection, region: override }
    : { ...connection };

  // Log connection details for debugging
  console.log(`Creating storage client for connection ID: ${connectionId}`);
  console.log(`Connection type: ${storageType}`);
  console.log(`Connection endpoint: ${effectiveConnection.endpoint}`);
  console.log(`Connection region: ${effectiveConnection.region}${override ? ' (overridden)' : ''}`);
  
  // Always create a new client instance to avoid caching issues
  return await StorageClientFactory.createClient(storageType, effectiveConnection);
}

// Allow the renderer to set/clear an in-memory region override without
// persisting it to the saved connection. Useful for quick region switching.
ipcMain.handle('set-region-override', async (event, connectionId, region) => {
  if (!connectionId) return false;
  if (region && typeof region === 'string' && region.trim()) {
    regionOverrides.set(connectionId, region.trim());
  } else {
    regionOverrides.delete(connectionId);
  }
  return true;
});

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

// Pick a credentials file (currently the GCS service account JSON key). Only the
// path is returned and stored; the key material stays in the file on disk.
ipcMain.handle('select-credentials-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Select service account JSON key file',
    properties: ['openFile'],
    filters: [
      { name: 'JSON key file', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) return null;
  return result.filePaths[0];
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

// Verify that a signed URL actually serves the object before the renderer hands
// it to Chromium's downloader. Chromium saves whatever body it receives, so a
// failed request (region redirect, expired signature, deleted object) would end
// up on disk as an XML error document named like the real file. Runs in the main
// process because a renderer `fetch` from a file:// page is blocked by CORS.
ipcMain.handle('verify-object-url', async (event, url) => {
  const result = await verifyDownloadUrl(url);
  if (!result.ok) {
    console.error(`Download URL verification failed: ${result.message}`);
  }
  return result;
});

// ---------------------------------------------------------------------------
// Local credential discovery / sign-in helpers
//
// AWS SSO profiles and Google ADC already exist on the machine, so the dialog
// offers what is there, reports whether it is still valid, and can launch the
// browser sign-in when it has expired.
// ---------------------------------------------------------------------------

/** Read a text file, returning '' when it does not exist. */
function readTextIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    return '';
  }
}

/** Absolute paths of the shared AWS config files, honouring the CLI's env vars. */
function awsConfigPaths() {
  const home = app.getPath('home');
  return {
    config: process.env.AWS_CONFIG_FILE || path.join(home, '.aws', 'config'),
    credentials: process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, '.aws', 'credentials')
  };
}

function isExecutablePath(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch (error) {
    return false;
  }
}

/** Locate a CLI and build an env with its directory on PATH for child processes. */
function resolveCli(name) {
  const binary = findExecutable(name, isExecutablePath, {
    ...process.env,
    HOME: app.getPath('home')
  });
  if (!binary) return null;
  const env = {
    ...process.env,
    HOME: app.getPath('home'),
    PATH: `${path.dirname(binary)}:${process.env.PATH || '/usr/bin:/bin'}`
  };
  return { binary, env };
}

/**
 * Run a CLI sign-in command that opens a browser, without a shell.
 * Arguments are passed as an array so nothing is word-split or interpolated.
 */
function runLoginCommand(cli, args, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(cli.binary, args, {
      env: cli.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, message: 'Sign-in timed out after 5 minutes.' });
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, message: `Could not start ${path.basename(cli.binary)}: ${err.message}` });
    });
    child.on('close', code => {
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}`.trim();
      resolve(code === 0
        ? { ok: true, message: 'Sign-in completed.' }
        : { ok: false, message: output.split('\n').filter(Boolean).slice(-3).join(' ') || `Exited with code ${code}` });
    });
  });
}

// List the AWS profiles found in the shared config files.
ipcMain.handle('list-aws-profiles', async () => {
  const paths = awsConfigPaths();
  const profiles = listAwsProfiles({
    configText: readTextIfPresent(paths.config),
    credentialsText: readTextIfPresent(paths.credentials)
  });
  return {
    profiles,
    configPath: paths.config,
    hasCli: !!resolveCli('aws')
  };
});

// Resolve a profile's credentials to find out whether it currently works. For an
// SSO profile this is exactly what reports an expired token.
ipcMain.handle('check-aws-profile', async (event, profileName) => {
  const paths = awsConfigPaths();
  const profiles = listAwsProfiles({
    configText: readTextIfPresent(paths.config),
    credentialsText: readTextIfPresent(paths.credentials)
  });
  const profile = profiles.find(p => p.name === profileName);
  if (!profile) {
    return { ok: false, status: 'missing', message: `Profile "${profileName}" is not in ${paths.config}` };
  }

  try {
    const credentials = await fromIni({ profile: profileName })();
    const expiration = credentials.expiration ? new Date(credentials.expiration) : null;
    return {
      ok: true,
      status: 'valid',
      source: profile.source,
      expiresAt: expiration ? expiration.toISOString() : null,
      message: expiration
        ? `Signed in — credentials valid until ${expiration.toLocaleString()}`
        : 'Credentials resolved'
    };
  } catch (error) {
    const name = error && (error.name || error.Code);
    const msg = error && error.message ? error.message : String(error);
    const expired =
      name === 'SSOTokenProviderFailure' ||
      /token.*(expired|invalid|not\s*found)/i.test(msg) ||
      /sso.*(login|session)/i.test(msg);
    return {
      ok: false,
      status: expired ? 'expired' : 'error',
      source: profile.source,
      canSsoLogin: profile.source === 'sso',
      message: expired
        ? 'Session expired — sign in again to refresh it.'
        : msg.split('\n')[0]
    };
  }
});

// `aws sso login` opens the browser and waits for the device-code approval.
ipcMain.handle('aws-sso-login', async (event, profileName) => {
  const paths = awsConfigPaths();
  const profiles = listAwsProfiles({
    configText: readTextIfPresent(paths.config),
    credentialsText: readTextIfPresent(paths.credentials)
  });
  // Only ever pass a name we discovered ourselves, so no extra CLI flags can be
  // smuggled in through the field.
  if (!isKnownProfileName(profileName, profiles)) {
    return { ok: false, message: 'Unknown profile — refresh the list and try again.' };
  }
  const cli = resolveCli('aws');
  if (!cli) {
    return { ok: false, message: 'AWS CLI not found. Install it (brew install awscli) and try again.' };
  }
  return runLoginCommand(cli, ['sso', 'login', '--profile', profileName]);
});

// Report the state of Google Application Default Credentials.
ipcMain.handle('check-gcloud-adc', async () => {
  const adcPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(app.getPath('home'), '.config', 'gcloud', 'application_default_credentials.json');

  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(adcPath, 'utf-8'));
  } catch (error) {
    parsed = null;
  }
  const described = describeAdcCredential(parsed);
  const hasCli = !!resolveCli('gcloud');

  if (!described.present) {
    return { ...described, adcPath, hasCli, live: false, message: 'Not signed in with gcloud.' };
  }

  // A file on disk only proves a refresh token exists; ask for an access token
  // to confirm it still works.
  try {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      keyFile: adcPath,
      scopes: ['https://www.googleapis.com/auth/devstorage.read_write']
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const live = !!(token && token.token);
    return {
      ...described,
      adcPath,
      hasCli,
      live,
      message: live
        ? `Signed in — ${described.description}`
        : 'Credentials found but no access token could be obtained; sign in again.'
    };
  } catch (error) {
    return {
      ...described,
      adcPath,
      hasCli,
      live: false,
      message: `Credentials found but not usable: ${error.message.split('\n')[0]}`
    };
  }
});

// `gcloud auth application-default login` opens the browser.
ipcMain.handle('gcloud-adc-login', async () => {
  const cli = resolveCli('gcloud');
  if (!cli) {
    return {
      ok: false,
      message: 'gcloud not found. Install it (brew install --cask gcloud-cli) and try again.'
    };
  }
  return runLoginCommand(cli, ['auth', 'application-default', 'login', '--quiet']);
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
