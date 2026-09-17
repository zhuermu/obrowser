const { ipcRenderer } = require('electron');

let currentConnection = null;
let currentBucket = null;
let currentPrefix = '';
let selectedFiles = new Set();
let isEditing = false;
let listingInProgress = false;
let previewDownloadTarget = null;

// Loading indicators
function showLoading(message = 'Loading...') {
  document.getElementById('loadingOverlay').style.display = 'flex';
  document.getElementById('loadingOverlay').querySelector('.loading-text').textContent = message;
}

function hideLoading() {
  if (listingInProgress) return;
  document.getElementById('loadingOverlay').style.display = 'none';
}

function showButtonLoading(buttonId) {
  const button = document.getElementById(buttonId);
  button.disabled = true;
  button.querySelector('.button-spinner').style.display = 'block';
}

function hideButtonLoading(buttonId) {
  const button = document.getElementById(buttonId);
  button.disabled = false;
  button.querySelector('.button-spinner').style.display = 'none';
}

// Single source of truth for the short provider labels shown on connection
// badges, aligned on the AWS "S3" style: S3 / ABS / OSS / GCS. Previously each
// render site carried its own ternary chain, and a type missing from one of them
// silently fell through to "S3" — which is how GCS connections ended up
// labelled "S3".
const STORAGE_TYPE_LABELS = {
  'aws-s3': 'S3',
  'azure-blob': 'ABS',
  'aliyun-oss': 'OSS',
  'gcs': 'GCS'
};

/**
 * Short badge label for a storage type.
 * @param {string} type - Connection type id
 * @returns {string} Label such as 'S3' or 'GCS'
 */
function storageTypeLabel(type) {
  const key = type || 'aws-s3';
  // Fall back to the raw id rather than to another provider's name, so a new
  // unlabelled type is obvious instead of silently mislabelled.
  return STORAGE_TYPE_LABELS[key] || key;
}
window.storageTypeLabel = storageTypeLabel;

// URI scheme each provider's own CLI uses, for the "Copy path" action. Copying
// an s3:// path for a GCS or OSS object is simply wrong.
const STORAGE_PATH_SCHEMES = {
  'aws-s3': 's3',
  'azure-blob': 'abs',
  'aliyun-oss': 'oss',
  'gcs': 'gs'
};

/**
 * Build the provider-native URI for an object, e.g. gs://bucket/key.
 * @param {string} type - Connection type id
 * @param {string} bucket - Bucket/container name
 * @param {string} key - Object key
 * @returns {string} Provider-native URI
 */
function storageObjectUri(type, bucket, key) {
  const scheme = STORAGE_PATH_SCHEMES[type || 'aws-s3'] || 's3';
  return `${scheme}://${bucket}/${key}`;
}
window.storageObjectUri = storageObjectUri;

/**
 * Paint a credential status line.
 * @param {string} elementId - Target element id
 * @param {string} text - Message to show
 * @param {string} tone - 'ok' | 'warn' | 'error' | 'neutral'
 */
function setCredentialStatus(elementId, text, tone = 'neutral') {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = text;
  el.className = 'credential-status' + (tone === 'neutral' ? '' : ` status-${tone}`);
}

// Profiles discovered from ~/.aws, kept so the SSO button can validate against
// them and so editing a connection can re-select the saved one.
let discoveredAwsProfiles = [];

/**
 * Populate the AWS profile dropdown from the local shared config files and
 * report whether the selected one currently works.
 * @param {string} [preferred] - Profile to select if present
 */
async function refreshAwsProfiles(preferred) {
  const select = document.getElementById('awsProfile');
  if (!select) return;
  const wanted = preferred || select.value || '';

  try {
    const result = await ipcRenderer.invoke('list-aws-profiles');
    discoveredAwsProfiles = result.profiles || [];
    select.innerHTML = '';

    if (discoveredAwsProfiles.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(no profiles found)';
      select.appendChild(opt);
      setCredentialStatus('awsProfileStatus',
        `No profiles found in ${result.configPath}. Run "aws configure sso" or "aws configure" first.`, 'warn');
      return;
    }

    discoveredAwsProfiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.name} — ${p.sourceLabel}${p.region ? ` (${p.region})` : ''}`;
      select.appendChild(opt);
    });

    // Keep a profile saved by an earlier session selectable even if it has since
    // been removed from ~/.aws, so editing a connection never silently rewrites it.
    if (wanted && !discoveredAwsProfiles.some(p => p.name === wanted)) {
      const opt = document.createElement('option');
      opt.value = wanted;
      opt.textContent = `${wanted} — not found in ~/.aws`;
      select.appendChild(opt);
    }
    select.value = wanted || discoveredAwsProfiles[0].name;

    await checkAwsProfileStatus();
  } catch (error) {
    console.error('Error listing AWS profiles:', error);
    setCredentialStatus('awsProfileStatus', `Could not read ~/.aws: ${error.message}`, 'error');
  }
}
window.refreshAwsProfiles = refreshAwsProfiles;

/** Ask the main process whether the selected profile can resolve credentials. */
async function checkAwsProfileStatus() {
  const select = document.getElementById('awsProfile');
  const loginButton = document.getElementById('awsSsoLoginButton');
  if (!select || !select.value) return;

  setCredentialStatus('awsProfileStatus', `Checking "${select.value}"…`);
  try {
    const status = await ipcRenderer.invoke('check-aws-profile', select.value);
    setCredentialStatus('awsProfileStatus', status.message,
      status.ok ? 'ok' : status.status === 'expired' ? 'warn' : 'error');
    // Only an SSO profile can be fixed by a browser sign-in.
    if (loginButton) {
      loginButton.style.display = status.source === 'sso' ? 'inline-block' : 'none';
    }
  } catch (error) {
    setCredentialStatus('awsProfileStatus', `Check failed: ${error.message}`, 'error');
  }
}
window.checkAwsProfileStatus = checkAwsProfileStatus;

/** Run `aws sso login` for the selected profile; this opens the browser. */
async function awsSsoLogin() {
  const select = document.getElementById('awsProfile');
  const button = document.getElementById('awsSsoLoginButton');
  if (!select || !select.value) return;

  if (button) button.disabled = true;
  setCredentialStatus('awsProfileStatus',
    'Browser opened — approve the sign-in, then this will refresh automatically…', 'warn');
  try {
    const result = await ipcRenderer.invoke('aws-sso-login', select.value);
    if (result.ok) {
      await checkAwsProfileStatus();
    } else {
      setCredentialStatus('awsProfileStatus', result.message, 'error');
    }
  } catch (error) {
    setCredentialStatus('awsProfileStatus', `Sign-in failed: ${error.message}`, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}
window.awsSsoLogin = awsSsoLogin;

/** Report the local Google ADC state, including whether it can sign URLs. */
async function refreshGcloudAdcStatus() {
  const loginButton = document.getElementById('gcsAdcLoginButton');
  setCredentialStatus('gcsAdcStatus', 'Checking local gcloud credentials…');
  try {
    const status = await ipcRenderer.invoke('check-gcloud-adc');
    let tone = 'error';
    if (status.live) tone = status.canSignUrls ? 'ok' : 'warn';
    else if (status.present) tone = 'warn';

    let message = status.message;
    if (status.live && !status.canSignUrls) {
      message += ' — browsing and upload work, but preview/download cannot sign URLs.';
    }
    if (!status.hasCli) {
      message += ' (gcloud CLI not found on this machine.)';
    }
    setCredentialStatus('gcsAdcStatus', message, tone);
    if (loginButton) loginButton.disabled = !status.hasCli;
  } catch (error) {
    setCredentialStatus('gcsAdcStatus', `Check failed: ${error.message}`, 'error');
  }
}
window.refreshGcloudAdcStatus = refreshGcloudAdcStatus;

/** Run `gcloud auth application-default login`; this opens the browser. */
async function gcloudAdcLogin() {
  const button = document.getElementById('gcsAdcLoginButton');
  if (button) button.disabled = true;
  setCredentialStatus('gcsAdcStatus',
    'Browser opened — approve every permission checkbox, then this will refresh automatically…', 'warn');
  try {
    const result = await ipcRenderer.invoke('gcloud-adc-login');
    if (result.ok) {
      await refreshGcloudAdcStatus();
    } else {
      setCredentialStatus('gcsAdcStatus', result.message, 'error');
    }
  } catch (error) {
    setCredentialStatus('gcsAdcStatus', `Sign-in failed: ${error.message}`, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}
window.gcloudAdcLogin = gcloudAdcLogin;

// Toggle AWS S3 auth-method sub-fields (Access Key vs AWS Profile). Must be
// called whenever the storage type becomes 'aws-s3' or the auth method dropdown
// value changes.
function updateAwsAuthFields() {
  const authSelect = document.getElementById('awsAuthMethod');
  if (!authSelect) return;
  const method = authSelect.value || 'access-key';

  const showAccessKey = method === 'access-key';
  const showProfile = method === 'profile';

  document.querySelectorAll('#connectionForm .aws-auth-accesskey').forEach(el => {
    el.style.display = showAccessKey ? 'block' : 'none';
  });
  document.querySelectorAll('#connectionForm .aws-auth-profile').forEach(el => {
    el.style.display = showProfile ? 'block' : 'none';
  });

  // Populate the profile list (and check its status) the first time Profile mode
  // becomes visible, so the user picks from what exists instead of typing it.
  if (showProfile) {
    const select = document.getElementById('awsProfile');
    if (select && select.options.length === 0) {
      refreshAwsProfiles();
    }
  }

  // In AWS Profile mode, Endpoint and Region come from the profile itself
  // (~/.aws/config) or are resolved per bucket — hide them to avoid confusion.
  // Only applies when the storage type is aws-s3; Azure/Aliyun/GCS continue
  // to manage Endpoint/Region via their own rules.
  const storageTypeSel = document.getElementById('storageType');
  const storageType = storageTypeSel ? storageTypeSel.value : null;
  if (storageType === 'aws-s3') {
    const endpointField = document.getElementById('endpointField');
    const regionField = document.getElementById('regionField');
    if (endpointField) endpointField.style.display = showProfile ? 'none' : 'block';
    if (regionField) regionField.style.display = showProfile ? 'none' : 'block';
  }
}
window.updateAwsAuthFields = updateAwsAuthFields;

// Toggle GCS auth-method sub-fields. GCS's primary credential is a single
// service account JSON key file; ADC ("gcloud auth application-default login")
// stores nothing in the connection profile at all.
function updateGcsAuthFields() {
  const authSelect = document.getElementById('gcsAuthMethod');
  if (!authSelect) return;
  const useKeyFile = (authSelect.value || 'service-account') === 'service-account';

  document.querySelectorAll('#connectionForm .gcs-auth-sa').forEach(el => {
    el.style.display = useKeyFile ? 'block' : 'none';
  });
  // The ADC block carries the sign-in status and button instead of any input.
  document.querySelectorAll('#connectionForm .gcs-auth-adc').forEach(el => {
    el.style.display = useKeyFile ? 'none' : 'block';
  });

  if (!useKeyFile) {
    refreshGcloudAdcStatus();
  }
}
window.updateGcsAuthFields = updateGcsAuthFields;

// Open a native file picker for the GCS service account key.
async function browseGcsKeyFile() {
  const input = document.getElementById('gcsKeyFilename');
  if (!input) return;
  try {
    const filePath = await ipcRenderer.invoke('select-credentials-file');
    if (filePath) input.value = filePath;
  } catch (error) {
    console.error('Error selecting key file:', error);
    showNotification(`Could not open the file picker: ${error.message}`, 'error');
  }
}
window.browseGcsKeyFile = browseGcsKeyFile;

// Add new function for cloud storage type handling
function updateFormFields() {
  const storageType = document.getElementById('storageType').value;
  console.log('Updating form fields for storage type:', storageType);
  
  // Hide all form groups first
  document.querySelectorAll('.form-group').forEach(group => {
    // Keep common fields visible (those without storage type classes)
    if (!group.classList.contains('aws-s3') && 
        !group.classList.contains('azure-blob') && 
        !group.classList.contains('aliyun-oss') && 
        !group.classList.contains('gcs') && 
        !group.classList.contains('conditional-field')) {
      group.style.display = 'block';
    } else {
      group.style.display = 'none';
    }
  });
  
  // Show fields specific to the selected storage type
  document.querySelectorAll(`.form-group.${storageType}`).forEach(group => {
    group.style.display = 'block';
  });
  
  // Special handling for endpointField which has different input fields for different storage types
  const endpointField = document.getElementById('endpointField');
  if (endpointField) {
    endpointField.style.display = 'block';
    
    // Hide all divs inside endpoint field
    endpointField.querySelectorAll('div').forEach(div => {
      div.style.display = 'none';
    });
    
    // Show the right div for the current storage type
    if (storageType === 'aliyun-oss') {
      endpointField.querySelectorAll('div.aliyun-oss').forEach(div => {
        div.style.display = 'block';
      });
    } else {
      // AWS S3, Azure Blob and GCS each use their own endpoint input
      endpointField.querySelectorAll(`div.${storageType}`).forEach(div => {
        div.style.display = 'block';
      });
    }
    
    // Set default endpoint based on storage type
    const endpoint = document.getElementById('endpoint');
    if (endpoint && endpoint.style.display !== 'none' && (!endpoint.value || endpoint.value.trim() === '')) {
      switch(storageType) {
        // aws-s3: intentionally no default — endpoint is optional and the
        // SDK resolves the correct regional URL on its own. Forcing a value
        // like https://s3.amazonaws.com breaks cross-region operations.
        case 'azure-blob':
          endpoint.value = 'https://<account-name>.blob.core.windows.net';
          break;
      }
    }
  }

  // For AWS S3, apply auth-method sub-visibility rules on top of the generic
  // storage-type visibility handling above.
  if (storageType === 'aws-s3') {
    updateAwsAuthFields();
  }
  if (storageType === 'gcs') {
    updateGcsAuthFields();
  }
  
  // Special handling for regionField
  const regionField = document.getElementById('regionField');
  if (regionField) {
    // Only show region field for AWS S3 and Aliyun OSS
    if (['aws-s3', 'aliyun-oss'].includes(storageType)) {
      regionField.style.display = 'block';
      
      // Hide all divs inside region field
      regionField.querySelectorAll('div').forEach(div => {
        div.style.display = 'none';
      });
      
      // Show the appropriate div
      if (storageType === 'aliyun-oss') {
        regionField.querySelectorAll('div.aliyun-oss').forEach(div => {
          div.style.display = 'block';
        });
      } else {
        regionField.querySelectorAll(`div.${storageType}`).forEach(div => {
          div.style.display = 'block';
        });
      }
    } else {
      regionField.style.display = 'none';
    }
    
    console.log(`regionField has been set to ${regionField.style.display === 'block' ? 'visible' : 'hidden'}`);
  }
  
  // Handle label visibility
  document.querySelectorAll('label').forEach(label => {
    // Hide all labels first
    label.style.display = 'none';
    
    // Show common labels
    if (!label.classList.contains('aws-s3') && 
        !label.classList.contains('azure-blob') && 
        !label.classList.contains('aliyun-oss') && 
        !label.classList.contains('gcs') && 
        !label.classList.contains('conditional-field')) {
      label.style.display = 'block';
    }
    
    // Show labels for current storage type
    if (label.classList.contains(storageType)) {
      label.style.display = 'block';
    }
    
    // Show conditional labels for Aliyun OSS if relevant
    if (storageType === 'aliyun-oss' && label.classList.contains('aliyun-oss') && label.classList.contains('conditional-field')) {
      label.style.display = 'block';
    }
  });
  
  console.log('Form fields updated for storage type:', storageType);
  // Optional fields stay out of the way, except OSS needs an endpoint or region.
  const advanced = document.getElementById('advancedConnectionOptions');
  if (advanced && storageType === 'aliyun-oss') advanced.open = true;
  if (storageType === 'aws-s3') updateAwsAuthFields();
}

// Add file size formatting function
function formatSize(bytes) {
  if (bytes === undefined || bytes === null) return '—';
  if (Number(bytes) === 0) return '0 B';
  
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  if (i === 0) return bytes + ' ' + sizes[i];
  
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

// Connection Management
async function loadConnections() {
  try {
    let connections = await ipcRenderer.invoke('get-connections');
    if (!Array.isArray(connections)) connections = [];
    let needsUpdate = false;
    connections = connections.map(conn => {
      if (!conn.type) { conn.type = 'aws-s3'; needsUpdate = true; }
      if (conn.type === 'pcg') {
        conn.type = 'aws-s3';
        conn.authMethod = conn.authMethod || 'access-key';
        needsUpdate = true;
      }
      if (!conn.id) { conn.id = crypto.randomUUID(); needsUpdate = true; }
      if (conn.type === 'aliyun-oss' && conn.secure === undefined) { conn.secure = true; needsUpdate = true; }
      return conn;
    });
    if (needsUpdate) await ipcRenderer.invoke('save-connections', connections);
    workspaceConnections = connections;
    const list = document.getElementById('connectionList');
    list.replaceChildren(...connections.map(renderConnectionItem));
    if (!connections.length) list.innerHTML = '<div class="connection-empty">Your connected clouds will<br>appear here.</div>';
    document.title = currentConnection ? `OBrowser — ${currentConnection.name}` : 'OBrowser';
    updateWorkspace();
  } catch (error) {
    document.getElementById('connectionList').innerHTML = '<div class="connection-empty">Connections could not be loaded.<br><button class="text-action-button" onclick="loadConnections()">Try again</button></div>';
    showNotification(`Could not load connections: ${error.message}`, 'error');
  }
}

function showNewConnectionModal() {
  isEditing = false;
  document.getElementById('connectionModalTitle').textContent = 'New Connection';
  const form = document.getElementById('connectionForm');
  
  // Reset form
  form.reset();
  const advanced = document.getElementById('advancedConnectionOptions');
  if (advanced) advanced.open = false;
  
  // Set default AWS S3 storage type
  const storageTypeSelect = form.elements.type;
  storageTypeSelect.value = 'aws-s3';
  
  // Leave endpoint empty by default — standard AWS S3 is resolved
  // automatically by the SDK. User can fill it only for MinIO or other
  // S3-compatible / custom endpoints.
  const endpoint = document.getElementById('endpoint');
  if (endpoint) endpoint.value = '';
  
  // Ensure proper initialization of form fields
  updateFormFields();
  
  // Manually trigger the change event to ensure other fields are updated
  storageTypeSelect.dispatchEvent(new Event('change'));
  
  // Show the modal
  openDialog('connectionModal');
  document.getElementById('connectionName').focus();
}

function hideConnectionModal() {
  closeDialog('connectionModal');
  document.getElementById('connectionForm').reset();
}

function editConnection(connection) {
  if (typeof connection === 'string') {
    // If it's an ID, get the connection object
    console.log('Editing connection by ID:', connection);
    ipcRenderer.invoke('get-connections')
      .then(connections => {
        // Ensure connections is an array
        if (!Array.isArray(connections)) {
          console.error('Invalid connections data received:', connections);
          showNotification('Error retrieving connections', 'error');
          return;
        }
        
        const conn = connections.find(c => c.id === connection);
        if (conn) {
          console.log('Found connection with ID:', connection);
          window.renderer_editConnection(conn);
        } else {
          console.error(`Connection with ID ${connection} not found`);
          console.log('Available connections:', connections.map(c => ({ id: c.id, name: c.name, type: c.type })));
          showNotification('Connection not found', 'error');
        }
      })
      .catch(err => {
        console.error('Failed to get connections:', err);
        showNotification('Failed to load connection for editing', 'error');
      });
  } else if (typeof connection === 'object' && connection !== null) {
    // If it's already an object, use it directly
    if (!connection.id) {
      // Generate an ID if missing
      connection.id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
      console.log('Generated new ID for connection:', connection.id);
    }
    console.log('Editing connection object directly with ID:', connection.id);
    window.renderer_editConnection(connection);
  } else {
    console.error('Invalid parameter type:', typeof connection);
    showNotification('Invalid connection parameter', 'error');
  }
}

// Ensure the editConnection function is available in the global scope
window.editConnection = editConnection;

// Actual implementation of the edit connection function
window.renderer_editConnection = function(connection) {
  isEditing = true;
  document.getElementById('connectionModalTitle').textContent = 'Edit Connection';
  const form = document.getElementById('connectionForm');
  
  // Reset form first
  form.reset();
  
  const advanced = document.getElementById('advancedConnectionOptions');
  if (advanced) advanced.open = Boolean(connection.endpoint || connection.region || connection.bucket || connection.prefix);
  
  // Ensure connection has a valid ID
  if (!connection.id) {
    console.error('Connection missing ID, generating one now');
    connection.id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  }
  
  // Set basic fields - important to set the ID so we know which connection we're editing
  form.elements.id.value = connection.id;
  form.elements.name.value = connection.name;
  
  // Set storage type (default to aws-s3 for backward compatibility)
  const storageType = connection.type || 'aws-s3';
  form.elements.type.value = storageType;
  
  // First update form fields to ensure correct fields are visible and required
  updateFormFields();
  
  // Log connection details for debugging
  console.log('Editing connection with ID:', connection.id);
  console.log('Connection data:', JSON.stringify(connection, null, 2));
  
  // Use delay to ensure DOM is updated before setting field values
  setTimeout(() => {
    // First, enable all input fields to ensure we can set values
    document.querySelectorAll('#connectionForm input, #connectionForm select').forEach(input => {
      input.disabled = false;
    });
    
    // For Aliyun OSS, set aliyun specific fields
    if (storageType === 'aliyun-oss') {
      const aliyunEndpoint = document.getElementById('aliyun_endpoint');
      const aliyunRegion = document.getElementById('aliyun_region');
      const aliyunAccessKey = document.getElementById('aliyun_accessKey');
      const aliyunSecretKey = document.getElementById('aliyun_secretKey');
      
      if (aliyunEndpoint) {
        aliyunEndpoint.value = connection.endpoint || '';
        console.log('Setting Aliyun endpoint field:', connection.endpoint);
      }
      if (aliyunRegion) {
        aliyunRegion.value = connection.region || '';
        console.log('Setting Aliyun region field:', connection.region);
      }
      if (aliyunAccessKey) aliyunAccessKey.value = connection.accessKey || '';
      if (aliyunSecretKey) aliyunSecretKey.value = connection.secretKey || '';
    } else if (storageType === 'azure-blob') {
      // For Azure Blob Storage
      const endpoint = document.getElementById('endpoint');
      const accountName = document.getElementById('azureAccountName');
      const accountKey = document.getElementById('azureAccountKey');
      
      if (endpoint) {
        endpoint.value = connection.endpoint || 'https://<account-name>.blob.core.windows.net';
        console.log('Setting Azure endpoint field:', connection.endpoint);
        endpoint.style.display = 'block';
      }
      if (accountName) accountName.value = connection.accountName || '';
      if (accountKey) accountKey.value = connection.accountKey || '';
    } else if (storageType === 'gcs') {
      // Google Cloud Storage: a single service account JSON key file (or ADC).
      const gcsEndpoint = document.getElementById('gcs_endpoint');
      const gcsAuthMethodSel = document.getElementById('gcsAuthMethod');
      const gcsKeyFile = document.getElementById('gcsKeyFilename');
      const gcsProjectId = document.getElementById('gcsProjectId');

      if (gcsEndpoint) gcsEndpoint.value = connection.endpoint || '';
      if (gcsAuthMethodSel) {
        gcsAuthMethodSel.value = connection.authMethod
          || (connection.keyFilename ? 'service-account' : 'adc');
        updateGcsAuthFields();
      }
      if (gcsKeyFile) gcsKeyFile.value = connection.keyFilename || '';
      if (gcsProjectId) gcsProjectId.value = connection.projectId || '';
    } else {
      // AWS S3
      const endpoint = document.getElementById('endpoint');
      const region = document.getElementById('region');
      const accessKey = document.getElementById('accessKey');
      const secretKey = document.getElementById('secretKey');
      const sessionToken = document.getElementById('sessionToken');
      const authMethodEl = document.getElementById('awsAuthMethod');
      const profileEl = document.getElementById('awsProfile');

      // Default to 'access-key' for legacy connections that predate authMethod.
      const method = connection.authMethod || 'access-key';
      if (authMethodEl) authMethodEl.value = method;
      // The profile field is a dropdown of locally discovered profiles now, so
      // fill the list before selecting the saved value.
      if (method === 'profile') {
        refreshAwsProfiles(connection.profile || '');
      }

      if (endpoint) {
        // For profile mode we don't force a default endpoint: letting the SDK
        // pick the regional endpoint avoids region mismatches.
        if (method === 'profile') {
          endpoint.value = connection.endpoint || '';
        } else {
          endpoint.value = connection.endpoint || 'https://s3.amazonaws.com';
        }
        console.log('Setting AWS endpoint field:', connection.endpoint);
        endpoint.style.display = 'block';
      }
      if (region) {
        // Region is optional — leave blank to let the client use us-east-1
        // for ListBuckets (global API) and rely on followRegionRedirects for
        // per-bucket ops.
        region.value = connection.region || '';
        console.log('Setting AWS region field:', connection.region);
        region.style.display = 'block';
      }
      // profileEl is a <select> populated asynchronously by refreshAwsProfiles
      // above, which also selects `connection.profile`; assigning .value here
      // would be a no-op before the options exist.
      if (accessKey) accessKey.value = connection.accessKey || '';
      if (secretKey) secretKey.value = connection.secretKey || '';
      if (sessionToken) sessionToken.value = connection.sessionToken || '';

      // Apply auth-method field visibility now that values are populated.
      if (typeof updateAwsAuthFields === 'function') {
        updateAwsAuthFields();
      }
    }
    
    // Set common fields
    const bucketField = form.elements.bucket;
    const prefixField = form.elements.prefix;
    
    if (bucketField) bucketField.value = connection.bucket || '';
    if (prefixField) prefixField.value = connection.prefix || '';
    
    // Ensure fields in modal are correctly displayed
    const modalContent = document.querySelector('.modal-content');
    if (modalContent) {
      // Make sure fields for current storage type are visible
      modalContent.querySelectorAll('.form-group').forEach(field => {
        // Display common fields
        if (!field.classList.contains('aws-s3') && 
            !field.classList.contains('azure-blob') && 
            !field.classList.contains('aliyun-oss') && 
            !field.classList.contains('gcs') && 
            !field.classList.contains('conditional-field')) {
          field.style.display = 'block';
        }
        // Display fields for current storage type — but never auth-method
        // subgroups, whose visibility depends on the selected auth method and is
        // applied further down. Showing them here is what left the GCS service
        // account key file visible while Auth Method was set to ADC.
        else if (field.classList.contains(storageType)
                 && !field.classList.contains('aws-auth-accesskey')
                 && !field.classList.contains('aws-auth-profile')
                 && !field.classList.contains('gcs-auth-sa')
                 && !field.classList.contains('gcs-auth-adc')) {
          field.style.display = 'block';
        }
      });
      
      // For AWS S3, always show endpoint and region fields
      if (storageType === 'aws-s3') {
        const endpointField = document.getElementById('endpointField');
        const regionField = document.getElementById('regionField');
        
        if (endpointField) {
          endpointField.style.display = 'block';
          endpointField.querySelectorAll(`div.${storageType}, div.aws-s3`).forEach(div => {
            div.style.display = 'block';
          });
        }
        
        if (regionField) {
          regionField.style.display = 'block';
          regionField.querySelectorAll(`div.${storageType}, div.aws-s3`).forEach(div => {
            div.style.display = 'block';
          });
        }
      }
      
      // Ensure all input elements within visible form groups are also visible
      modalContent.querySelectorAll('.form-group[style*="display: block"] input, .form-group[style*="display: block"] select').forEach(input => {
        input.style.display = 'block';
      });

      // Re-apply auth-method visibility last so the sub-fields match the
      // selected method even after the generic storage-type loop above ran.
      // AWS: Profile mode hides Access Key/Secret/Session Token (and
      // Endpoint/Region). GCS: ADC mode hides the service account key file.
      if (storageType === 'aws-s3' && typeof updateAwsAuthFields === 'function') {
        updateAwsAuthFields();
      }
      if (storageType === 'gcs' && typeof updateGcsAuthFields === 'function') {
        updateGcsAuthFields();
      }
    }
    
    console.log('Editing connection complete, form values set with ID:', connection.id);
  }, 200); // Increased delay to ensure DOM is fully updated
  
  // Show the modal
  openDialog('connectionModal');
  document.getElementById('connectionName').focus();
}

// File search functionality
function filterFiles(query) {
  filterWorkspaceFiles(query);
}

document.getElementById('connectionForm').onsubmit = async (e) => {
  e.preventDefault();
  showButtonLoading('saveConnectionButton');
  
  try {
    const formData = new FormData(e.target);
    const storageType = formData.get('type');
    const connectionName = formData.get('name');
    
    // Validate form data, but no longer check visibility - just check the fields exist and have values
    let formIsValid = true;
    let errorMessage = '';
    
    if (!connectionName) {
      formIsValid = false;
      errorMessage = 'Please enter connection name';
    } else {
      switch(storageType) {
        case 'azure-blob':
          // Get required elements
          const azureEndpoint = document.getElementById('endpoint');
          const azureAccountName = document.getElementById('azureAccountName');
          const azureAccountKey = document.getElementById('azureAccountKey');
          
          // Validate regardless of visibility
          if (azureEndpoint && !azureEndpoint.value) {
            formIsValid = false;
            errorMessage = 'Please enter Endpoint';
          } else if (azureAccountName && !azureAccountName.value) {
            formIsValid = false;
            errorMessage = 'Please enter Account Name';
          } else if (azureAccountKey && !azureAccountKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter Account Key';
          }
          break;
        
        case 'aws-s3':
          // Get required elements
          const awsEndpoint = document.getElementById('endpoint');
          const awsAuthMethodEl = document.getElementById('awsAuthMethod');
          const awsAuthMethod = awsAuthMethodEl ? awsAuthMethodEl.value : 'access-key';

          // Standard S3 resolves endpoints for both keys and profiles. Only
          // S3-compatible/custom services need the advanced endpoint override.
          if (awsAuthMethod === 'profile') {
            const profileInput = document.getElementById('awsProfile');
            if (!profileInput || !profileInput.value.trim()) {
              formIsValid = false;
              errorMessage = 'Please enter AWS Profile name';
            }
          } else {
            const awsAccessKey = document.getElementById('accessKey');
            const awsSecretKey = document.getElementById('secretKey');
            if (awsAccessKey && !awsAccessKey.value) {
              formIsValid = false;
              errorMessage = 'Please enter Access Key';
            } else if (awsSecretKey && !awsSecretKey.value) {
              formIsValid = false;
              errorMessage = 'Please enter Secret Key';
            }
          }
          break;
        
        case 'gcs':
          // The key file is required only for the service-account method; the
          // ADC method deliberately takes no credential input at all. Without
          // this branch the field carried a "required" marker that nothing
          // enforced, so an empty service-account connection could be saved and
          // then failed later at connect time.
          const gcsAuthEl = document.getElementById('gcsAuthMethod');
          const gcsAuthValue = gcsAuthEl ? gcsAuthEl.value : 'service-account';
          if (gcsAuthValue === 'service-account') {
            const gcsKeyEl = document.getElementById('gcsKeyFilename');
            if (!gcsKeyEl || !gcsKeyEl.value.trim()) {
              formIsValid = false;
              errorMessage = 'Please select the service account JSON key file, or switch Auth Method to Application Default Credentials';
            }
          }
          break;

        case 'aliyun-oss':
          // Get required elements
          const aliyunEndpoint = document.getElementById('aliyun_endpoint');
          const aliyunRegion = document.getElementById('aliyun_region');
          const aliyunAccessKey = document.getElementById('aliyun_accessKey');
          const aliyunSecretKey = document.getElementById('aliyun_secretKey');
          
          // For Aliyun OSS, endpoint or region at least needs one, but not necessarily both
          const hasEndpoint = aliyunEndpoint && aliyunEndpoint.value;
          const hasRegion = aliyunRegion && aliyunRegion.value;
          
          if (!hasEndpoint && !hasRegion) {
            formIsValid = false;
            errorMessage = 'Please enter either Endpoint or Region';
          } else if (aliyunAccessKey && !aliyunAccessKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter AccessKeyID';
          } else if (aliyunSecretKey && !aliyunSecretKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter AccessKeySecret';
          }
          break;
        
      }
    }
    
    if (!formIsValid) {
      showNotification(errorMessage, 'error');
      hideButtonLoading('saveConnectionButton');
      return;
    }
    
    // Create a new connection object
    let connection = {};
    const connectionId = formData.get('id');
    
    // If editing, get the existing connection first
    if (isEditing && connectionId) {
      try {
        const connections = await ipcRenderer.invoke('get-connections');
        const existingConnection = connections.find(conn => conn.id === connectionId);
        if (existingConnection) {
          // Start with the existing connection properties
          connection = { ...existingConnection };
        } else {
          console.warn('Connection ID not found:', connectionId);
        }
      } catch (error) {
        console.warn('Could not retrieve existing connection:', error);
      }
    }
    
    // Generate a new ID if not editing or if connection ID is missing
    if (!isEditing || !connectionId) {
      connection.id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
    } else {
      connection.id = connectionId;
    }
    
    // Always update basic fields
    connection.name = connectionName;
    connection.type = storageType;
    
    console.log('Saving connection with ID:', connection.id, 'Type:', storageType);
    
    // When editing, we SHOULD NOT create a brand new object as it would lose other properties
    // Instead, just update the fields that the form is meant to update
    if (!isEditing) {
      // For new connections, create a fresh object
      connection = {
        id: connection.id,
        name: connectionName,
        type: storageType
      };
    }
    
    // Set storage-type specific fields
    switch (storageType) {
      case 'azure-blob':
        const azureEndpoint = document.getElementById('endpoint');
        const azureRegion = document.getElementById('region');
        const azureAccountName = document.getElementById('azureAccountName');
        const azureAccountKey = document.getElementById('azureAccountKey');
        
        // Ensure Azure has a proper endpoint
        if (azureEndpoint) {
          const endpointValue = azureEndpoint.value;
          // If endpoint is the default template, try to replace <account-name> with actual account name
          if (endpointValue.includes('<account-name>') && azureAccountName && azureAccountName.value) {
            connection.endpoint = endpointValue.replace('<account-name>', azureAccountName.value);
          } else {
            connection.endpoint = endpointValue;
          }
        }
        
        if (azureRegion) connection.region = azureRegion.value || '';  
        if (azureAccountName) connection.accountName = azureAccountName.value;
        if (azureAccountKey) connection.accountKey = azureAccountKey.value;
        break;
        
      case 'aliyun-oss':
        const aliyunEndpoint = document.getElementById('aliyun_endpoint');
        const aliyunRegion = document.getElementById('aliyun_region');
        const aliyunAccessKey = document.getElementById('aliyun_accessKey');
        const aliyunSecretKey = document.getElementById('aliyun_secretKey');
        
        if (aliyunEndpoint) connection.endpoint = aliyunEndpoint.value || null;
        if (aliyunRegion) connection.region = aliyunRegion.value || null;
        if (aliyunAccessKey) connection.accessKey = aliyunAccessKey.value;
        if (aliyunSecretKey) connection.secretKey = aliyunSecretKey.value;
        connection.secure = true;  // Always use HTTPS for Aliyun OSS
        break;
        
      case 'aws-s3':
        const awsEndpointEl = document.getElementById('endpoint');
        const awsRegionEl = document.getElementById('region');
        const awsAuthMethodSel = document.getElementById('awsAuthMethod');
        const awsMethod = awsAuthMethodSel ? awsAuthMethodSel.value : 'access-key';

        connection.authMethod = awsMethod;

        if (awsMethod === 'profile') {
          // Profile mode: endpoint and region come from the profile itself
          // (or are resolved per-bucket at runtime). Don't persist defaults
          // that would conflict with the profile's own config.
          connection.endpoint = '';
          connection.region = '';
          const profileEl = document.getElementById('awsProfile');
          connection.profile = profileEl ? profileEl.value.trim() : '';
          // Clear any previously persisted static credentials so they don't
          // linger in the store after switching auth methods.
          connection.accessKey = '';
          connection.secretKey = '';
          connection.sessionToken = '';
        } else {
          if (awsEndpointEl) connection.endpoint = awsEndpointEl.value || '';
          if (awsRegionEl) connection.region = awsRegionEl.value || '';
          const awsAccessKeyEl = document.getElementById('accessKey');
          const awsSecretKeyEl = document.getElementById('secretKey');
          const awsSessionTokenEl = document.getElementById('sessionToken');
          if (awsAccessKeyEl) connection.accessKey = awsAccessKeyEl.value;
          if (awsSecretKeyEl) connection.secretKey = awsSecretKeyEl.value;
          connection.sessionToken = awsSessionTokenEl && awsSessionTokenEl.value
            ? awsSessionTokenEl.value
            : '';
          connection.profile = '';
        }
        break;
        
      case 'gcs':
        const gcsEndpoint = document.getElementById('gcs_endpoint');
        const gcsAuthMethodSel = document.getElementById('gcsAuthMethod');
        const gcsKeyFileEl = document.getElementById('gcsKeyFilename');
        const gcsProjectIdEl = document.getElementById('gcsProjectId');
        const gcsMethod = gcsAuthMethodSel ? gcsAuthMethodSel.value : 'service-account';

        connection.authMethod = gcsMethod;
        connection.endpoint = gcsEndpoint ? (gcsEndpoint.value.trim() || '') : '';
        connection.projectId = gcsProjectIdEl ? gcsProjectIdEl.value.trim() : '';
        // Persist only the path to the key file; the private key itself stays
        // on disk instead of being copied into the connections config.
        connection.keyFilename = gcsMethod === 'service-account' && gcsKeyFileEl
          ? gcsKeyFileEl.value.trim()
          : '';
        // GCS addresses buckets globally — no region needed.
        connection.region = '';
        break;

    }
    
    // Update bucket and prefix
    const bucketField = e.target.elements.bucket;
    const prefixField = e.target.elements.prefix;
    
    if (bucketField) connection.bucket = bucketField.value || null;
    if (prefixField) connection.prefix = prefixField.value || '';
    
    // Do not log credentials contained in the connection profile.
    
    // Save the connection
    if (isEditing) {
      const connections = await ipcRenderer.invoke('get-connections');
      
      // Create a deep copy of each connection to avoid reference issues
      const updatedConnections = connections.map(conn => {
        // If this is the connection being edited, return our updated connection
        if (conn.id === connection.id) {
          console.log(`Updating connection with ID ${connection.id}, region: ${connection.region}`);
          return { ...connection };
        }
        // Otherwise return a copy of the original connection
        return { ...conn };
      });
      
      await ipcRenderer.invoke('save-connections', updatedConnections);
      showNotification(`Connection "${connectionName}" successfully updated`, 'success');
    } else {
      await ipcRenderer.invoke('save-connection', { ...connection });
      showNotification(`Connection "${connectionName}" successfully added`, 'success');
    }
    
    hideConnectionModal();
    loadConnections();
  } catch (error) {
    console.error('Error saving connection:', error);
    showNotification(`Failed to save connection: ${error.message}`, 'error');
  } finally {
    hideButtonLoading('saveConnectionButton');
  }
};

// File Management
async function selectConnection(connection) {
  if (!connection) {
    console.error('selectConnection called with invalid connection:', connection);
    return;
  }
  
  if (!connection.id) {
    console.error('Connection has no ID:', connection);
    return;
  }
  
  try {
    console.log('Selecting connection:', connection.name, 'ID:', connection.id, 'Region:', connection.region);
    showLoading('Connecting to storage...');
    
    // Make a deep copy of the connection to avoid reference issues
    currentConnection = JSON.parse(JSON.stringify(connection));
    
    console.log('Using connection with region:', currentConnection.region);
    
    currentBucket = currentConnection.bucket;
    currentPrefix = currentConnection.prefix || '';
    
    // Update connection item visual state, highlight current selected connection
    if (currentConnection && currentConnection.id) {
      console.log('Updating active connection with ID:', currentConnection.id);
      updateActiveConnection(currentConnection.id);
      
      // Update connection status display
      const connectionStatus = document.getElementById('connectionStatus');
      if (connectionStatus) {
        connectionStatus.style.display = 'flex';
        connectionStatus.dataset.ownedBySelect = '1';
        // Based on different storage types, display different messages
        const storageTypeName = storageTypeLabel(currentConnection.type);
        connectionStatus.innerHTML = `<i class="fa-solid fa-database"></i> <strong>${escapeHtml(currentConnection.name)}</strong> <span class="connection-type-badge connection-type-${currentConnection.type || 'aws-s3'}">${storageTypeName}</span>`;

        // For AWS S3, append a region switcher so the user can change region
        // without editing the saved connection. Region is persisted as an
        // in-memory override in the main process.
        if (currentConnection.type === 'aws-s3') {
          const regionContainer = document.createElement('span');
          regionContainer.style.marginLeft = 'auto';
          regionContainer.style.display = 'inline-flex';
          regionContainer.style.alignItems = 'center';
          regionContainer.style.gap = '0.4rem';

          const regionLabel = document.createElement('span');
          regionLabel.style.fontSize = '0.85rem';
          regionLabel.style.color = '#6c757d';
          regionLabel.textContent = 'Region:';

          const regionSelect = document.createElement('select');
          regionSelect.id = 'regionSwitcher';
          regionSelect.style.padding = '0.3rem 0.5rem';
          regionSelect.style.border = '1px solid #d2d2d7';
          regionSelect.style.borderRadius = '6px';
          regionSelect.style.fontSize = '0.85rem';
          regionSelect.style.background = 'white';

          // Common S3 regions. "(auto)" means "let the SDK pick us-east-1
          // for ListBuckets and follow region redirects per bucket".
          const regions = [
            { value: '', label: '(auto-detect)' },
            { value: 'us-east-1', label: 'us-east-1 (N. Virginia)' },
            { value: 'us-east-2', label: 'us-east-2 (Ohio)' },
            { value: 'us-west-1', label: 'us-west-1 (N. California)' },
            { value: 'us-west-2', label: 'us-west-2 (Oregon)' },
            { value: 'eu-west-1', label: 'eu-west-1 (Ireland)' },
            { value: 'eu-central-1', label: 'eu-central-1 (Frankfurt)' },
            { value: 'ap-northeast-1', label: 'ap-northeast-1 (Tokyo)' },
            { value: 'ap-southeast-1', label: 'ap-southeast-1 (Singapore)' },
            { value: 'ap-southeast-2', label: 'ap-southeast-2 (Sydney)' },
            { value: 'ap-south-1', label: 'ap-south-1 (Mumbai)' },
            { value: 'ca-central-1', label: 'ca-central-1 (Canada)' },
            { value: 'sa-east-1', label: 'sa-east-1 (São Paulo)' }
          ];
          const saved = currentConnection.region || '';
          // Ensure the saved region is selectable even if not in the preset list.
          if (saved && !regions.some(r => r.value === saved)) {
            regions.push({ value: saved, label: saved });
          }
          regions.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.value;
            opt.textContent = r.label;
            if (r.value === saved) opt.selected = true;
            regionSelect.appendChild(opt);
          });

          regionSelect.onchange = async () => {
            const chosen = regionSelect.value;
            try {
              showLoading(`Switching region to ${chosen || 'auto'}...`);
              await ipcRenderer.invoke('set-region-override', currentConnection.id, chosen);
              // Reset bucket/prefix because they may not exist in the new region.
              currentBucket = null;
              currentPrefix = '';
              updateBreadcrumb();
              await loadFiles();
              // Check whether the new region actually has any buckets so the
              // user isn't confused by an empty list after switching.
              const fileList = document.getElementById('fileList');
              const hasItems = fileList && fileList.querySelector('.file-item');
              if (chosen && !hasItems) {
                showNotification(
                  `No buckets found in ${chosen}. The account may not have any buckets in this region.`,
                  'info'
                );
              } else {
                showNotification(
                  chosen ? `Showing buckets in ${chosen}` : 'Showing all buckets (auto-detect)',
                  'info'
                );
              }
            } catch (err) {
              console.error('Region switch failed:', err);
              showNotification(`Failed to switch region: ${err.message}`, 'error');
            } finally {
              hideLoading();
            }
          };

          regionContainer.appendChild(regionLabel);
          regionContainer.appendChild(regionSelect);
          connectionStatus.appendChild(regionContainer);
        }
      }
      
      // Update document title
      document.title = `OBrowser - ${currentConnection.name}`;
    }
    
    updateBreadcrumb();
    
    try {
      const loaded = await loadFiles();
      if (!loaded) return;
      // Based on different storage types, display different messages
      const storageTypeName = storageTypeLabel(currentConnection.type);
      showNotification(`Connected to "${currentConnection.name}" (${storageTypeName})`, 'info');
    } catch (error) {
      console.error('Error loading files:', error);
      showNotification(`Connected successfully, but failed to load files: ${error.message}`, 'error');
      // Clear file list to indicate an error
      document.getElementById('fileList').innerHTML = `
        <div class="file-item" style="justify-content: center; color: #dc3545;">
          <div style="text-align: center;">
            <div style="font-weight: bold; margin-bottom: 5px;">Failed to load files</div>
            <div>${error.message || 'Unknown error'}</div>
          </div>
        </div>
      `;
    }
  } catch (error) {
    console.error('Error selecting connection:', error);
    showNotification(`Failed to connect to "${connection.name}": ${error.message}`, 'error');
    // Clear file list to indicate an error
    document.getElementById('fileList').innerHTML = '';
  } finally {
    hideLoading();
  }
}
// Expose selectConnection to window scope
window.selectConnection = selectConnection;

// Add update active connection status function
function updateActiveConnection(connectionId) {
  document.querySelectorAll('.connection-item').forEach(item => {
    const active = item.dataset.connectionId === connectionId;
    item.classList.toggle('active', active);
    item.querySelector('.connection-name')?.setAttribute('aria-pressed', String(active));
  });
}

function updateBreadcrumb() {
  const breadcrumb = document.getElementById('pathBreadcrumb');
  breadcrumb.replaceChildren();
  const addCrumb = (label, action, current = false) => {
    if (breadcrumb.childNodes.length) {
      const separator = document.createElement('i');
      separator.className = 'fa-solid fa-chevron-right';
      breadcrumb.appendChild(separator);
    }
    const button = document.createElement('button');
    button.className = 'path-segment' + (current ? ' current' : '');
    button.textContent = label;
    button.onclick = action;
    if (current) button.setAttribute('aria-current', 'location');
    breadcrumb.appendChild(button);
  };
  if (!currentConnection) { updateWorkspace(); return; }
  if (!currentConnection.bucket) {
    addCrumb(currentConnection.name, () => {
      currentBucket = null; currentPrefix = ''; updateBreadcrumb(); loadFiles();
    }, !currentBucket);
  }
  if (currentBucket) addCrumb(currentBucket, () => navigateTo(''), !currentPrefix);
  let prefix = '';
  const parts = currentPrefix.split('/').filter(Boolean);
  parts.forEach((part, index) => {
    prefix += part + '/';
    const target = prefix;
    addCrumb(part, () => navigateTo(target), index === parts.length - 1);
  });
  document.getElementById('searchInput').value = '';
  clearSelection();
  updateWorkspace();
}

/**
 * Navigate one level up from the current location:
 *   - inside a folder  → pop the last prefix segment
 *   - at bucket root   → go back to the bucket list (unless the connection
 *                        is pinned to a specific bucket)
 *   - at bucket list   → nothing to do
 */
async function navigateUp() {
  if (!currentConnection) return;

  // Case 1: we're inside a prefix — pop the trailing segment.
  if (currentPrefix && currentPrefix !== '') {
    const trimmed = currentPrefix.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    const parentPrefix = idx >= 0 ? trimmed.slice(0, idx + 1) : '';
    await navigateTo(parentPrefix);
    return;
  }

  // Case 2: at bucket root. If the connection isn't pinned to a specific
  // bucket, going "up" means back to the bucket list.
  if (currentBucket) {
    // Respect a connection-level bucket lock: if the user saved the
    // connection with a specific bucket, don't escape out of it.
    const pinned = currentConnection.bucket && currentConnection.bucket === currentBucket;
    if (!pinned) {
      currentBucket = null;
      currentPrefix = '';
      updateBreadcrumb();
      await loadFiles();
      return;
    }
  }

  // Case 3: already at the top (bucket list or pinned bucket root).
  showNotification('Already at the top level', 'info');
}
window.navigateUp = navigateUp;

async function navigateTo(prefix) {
  showLoading('Loading...');
  try {
    // If prefix is empty, we're going to root
    if (prefix === '') {
      currentPrefix = '';
    } else {
      // Ensure prefix ends with '/'
      currentPrefix = prefix.endsWith('/') ? prefix : prefix + '/';
    }
    console.log('Navigating to:', currentPrefix);
    updateBreadcrumb();
    await loadFiles();
  } catch (error) {
    console.error('Error navigating:', error);
    alert('Failed to navigate to folder: ' + error.message);
  } finally {
    hideLoading();
  }
}

function getFileIcon(item) {
  if (!item) return '<i class="fa-solid fa-file"></i>'; // Prevent item from being null or undefined
  if (item.isFolder) return '<i class="fa-solid fa-folder"></i>';
  
  // Ensure Key exists and is a string
  const key = item.Key || '';
  if (!key || typeof key !== 'string') return '<i class="fa-solid fa-file"></i>';
  
  const ext = key.split('.').pop().toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
    case 'png':
    case 'gif':
      return '<i class="fa-solid fa-file-image"></i>';
    case 'pdf':
      return '<i class="fa-solid fa-file-pdf"></i>';
    case 'txt':
    case 'md':
    case 'json':
      return '<i class="fa-solid fa-file-lines"></i>';
    case 'mp3':
    case 'wav':
      return '<i class="fa-solid fa-file-audio"></i>';
    case 'mp4':
    case 'mov':
      return '<i class="fa-solid fa-file-video"></i>';
    default:
      return '<i class="fa-solid fa-file"></i>';
  }
}

// 全局变量，用于存储当前排序状态
let currentSortField = 'name'; // 默认按名称排序
let currentSortDirection = 'asc'; // 默认升序排序

let fileLoadGeneration = 0;
let loadedListing = null;

function formatFileDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function createRowAction(container, title, icon, action) {
  const button = document.createElement('button');
  button.className = 'action-button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
  button.onclick = event => { event.stopPropagation(); action(); };
  container.appendChild(button);
}

function sortObjects(items) {
  return [...items].filter(item => item && typeof item.Key === 'string').sort((a, b) => {
    if (Boolean(a.isFolder) !== Boolean(b.isFolder)) return a.isFolder ? -1 : 1;
    const values = item => ({
      name: item.Key.replace(/\/+$/, '').split('/').pop(),
      size: item.isFolder ? 0 : Number(item.Size || 0),
      modified: new Date(item.LastModified || 0).getTime() || 0,
      type: item.isFolder ? 'Folder' : item.ContentType || '',
      storageClass: item.StorageClass || ''
    });
    const left = values(a)[currentSortField], right = values(b)[currentSortField];
    const comparison = typeof left === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
    return currentSortDirection === 'asc' ? comparison : -comparison;
  });
}

async function loadFiles(refresh = true) {
  if (!currentConnection) return;
  const generation = ++fileLoadGeneration;
  listingInProgress = true;
  const connection = { ...currentConnection };
  const bucket = currentBucket, prefix = currentPrefix;
  const location = JSON.stringify([connection.id, bucket, prefix]);
  if (refresh) showLoading('Loading storage…');
  if (refresh) clearSelection();
  try {
    const result = !refresh && loadedListing?.location === location ? loadedListing.result :
      await ipcRenderer.invoke('list-objects', connection.id, bucket, prefix);
    if (generation !== fileLoadGeneration) return false;
    if (!result || !Array.isArray(result.data) || !['buckets', 'objects'].includes(result.type)) throw new Error('The storage provider returned an unexpected response.');
    loadedListing = { location, result };
    const fileList = document.getElementById('fileList');
    fileList.replaceChildren();
    const header = document.querySelector('.column-header');
    if (result.type === 'buckets') {
      header.innerHTML = '<div></div><div></div><div>Bucket name</div><div>Provider</div><div>Created</div><div>Region</div><div>Access</div><div>Open</div>';
      for (const item of result.data) {
        if (!item || typeof item.Name !== 'string') continue;
        const row = document.createElement('div');
        row.className = 'file-item bucket-item';
        row.dataset.key = item.Name;
        row.dataset.search = item.Name.toLowerCase();
        row.tabIndex = 0;
        row.setAttribute('role', 'row');
        row.setAttribute('aria-label', `Open bucket ${item.Name}`);
        row.innerHTML = `<div></div><div class="file-icon"><i class="fa-solid fa-database"></i></div><div class="file-details"><span class="file-name" title="${escapeHtml(item.Name)}">${escapeHtml(item.Name)}</span><span>${escapeHtml(storageTypeLabel(connection.type))}</span><span>${formatFileDate(item.CreationDate)}</span><span>${escapeHtml(item.Location || item.Region || '—')}</span><span>${item.PublicAccess ? 'Public' : 'Private'}</span><div class="bucket-actions"></div></div>`;
        const open = () => { currentBucket = item.Name; currentPrefix = ''; updateBreadcrumb(); loadFiles(); };
        createRowAction(row.querySelector('.bucket-actions'), 'Open bucket', 'chevron-right', open);
        row.ondblclick = event => { if (!event.target.closest('button')) open(); };
        row.onkeydown = event => {
          if (event.target !== row) return;
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            const rows = [...fileList.querySelectorAll('.bucket-item')].filter(item => !item.hidden);
            rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
          }
        };
        row.onclick = () => row.focus();
        fileList.appendChild(row);
      }
      if (!fileList.childElementCount) renderEmptyState('No buckets to show', 'Check the account permissions or choose a different region. You can also specify a bucket in your connection.', 'database', { label: 'Edit connection', run: () => editConnection(connection) });
    } else {
      header.innerHTML = '<div><input type="checkbox" id="selectAll" aria-label="Select all visible items"></div><div></div>' +
        [['name', 'Name'], ['size', 'Size'], ['modified', 'Modified'], ['type', 'Type'], ['storageClass', 'Storage class']].map(([field, label]) =>
          `<button class="sortable-column" data-sort="${field}" aria-label="Sort by ${label}">${label}<i class="fa-solid fa-sort"></i></button>`).join('') + '<div>Actions</div>';
      document.getElementById('selectAll').onchange = event => selectVisibleFiles(event.target.checked);
      header.querySelectorAll('.sortable-column').forEach(column => {
        column.onclick = () => {
          const field = column.dataset.sort;
          if (field === currentSortField) currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
          else { currentSortField = field; currentSortDirection = 'asc'; }
          loadFiles(false);
        };
      });
      for (const item of sortObjects(result.data)) {
        const name = item.Key.replace(/\/+$/, '').split('/').pop() || item.Key;
        const row = document.createElement('div');
        row.className = 'file-item' + (item.isFolder ? ' folder' : '');
        const type = item.isFolder ? 'Folder' : item.ContentType || 'File';
        row.innerHTML = `<div class="checkbox-container"><input type="checkbox" class="file-checkbox"></div><div class="file-icon">${getFileIcon(item)}</div><div class="file-details"><span class="file-name" title="${escapeHtml(item.Key)}">${escapeHtml(name)}</span><span>${item.isFolder ? '—' : formatSize(item.Size)}</span><span title="${escapeHtml(item.LastModified || '')}">${formatFileDate(item.LastModified)}</span><span title="${escapeHtml(type)}">${escapeHtml(type)}</span><span>${escapeHtml(item.StorageClass || '—')}</span><div class="file-actions"></div></div>`;
        row.querySelector('input').onclick = event => { event.stopPropagation(); toggleFileSelection(item.Key, item.isFolder); };
        const actions = row.querySelector('.file-actions');
        const open = () => item.isFolder ? navigateTo(item.Key) : previewFile(item);
        createRowAction(actions, item.isFolder ? 'Open folder' : 'Preview', item.isFolder ? 'folder-open' : 'eye', open);
        createRowAction(actions, 'Copy path', 'copy', async () => {
          try {
            await navigator.clipboard.writeText(storageObjectUri(connection.type, bucket, item.Key));
            showNotification('Object path copied.');
          } catch (error) { showNotification(`Could not copy path: ${error.message}`, 'error'); }
        });
        if (!item.isFolder) createRowAction(actions, 'Download', 'download', () => enqueueDownloads([item], {
          connectionId: connection.id, connectionName: connection.name,
          type: connection.type, bucket, prefix
        }));
        createRowAction(actions, item.isFolder ? 'Delete folder' : 'Delete file', 'trash', async () => {
          if (!confirm(`Permanently delete "${name}"${item.isFolder ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
          try {
            showLoading('Deleting…');
            await ipcRenderer.invoke('delete-object', connection.id, item.Key, bucket, Boolean(item.isFolder));
            showNotification(`Deleted "${name}".`);
            if (currentConnection?.id === connection.id && currentBucket === bucket && currentPrefix === prefix) await loadFiles();
          } catch (error) { showNotification(`Delete failed: ${error.message}`, 'error'); }
          finally { hideLoading(); }
        });
        attachRowInteraction(row, item, open);
        fileList.appendChild(row);
      }
      if (!fileList.childElementCount) renderEmptyState('A little room for your next idea.', 'This folder is empty. Upload a file or create a folder to get started.', 'folder', { label: 'Upload files', run: uploadFile });
    }
    header.querySelectorAll(':scope > *').forEach(cell => cell.setAttribute('role', 'columnheader'));
    fileList.querySelectorAll('.file-item').forEach(row => {
      row.querySelector('.file-details')?.setAttribute('role', 'presentation');
      row.querySelectorAll(':scope > div:not(.file-details), .file-details > *').forEach(cell => cell.setAttribute('role', 'gridcell'));
    });
    updateColumnSortIcons();
    filterFiles(document.getElementById('searchInput').value);
    return true;
  } catch (error) {
    if (generation !== fileLoadGeneration) return false;
    loadedListing = null;
    document.querySelector('.column-header').replaceChildren();
    renderEmptyState('Couldn’t load this location', error.message || 'Check your connection and try again.', 'triangle-exclamation', { label: 'Try again', run: () => loadFiles() });
    updateWorkspace();
    return false;
  } finally {
    if (generation === fileLoadGeneration) { listingInProgress = false; hideLoading(); }
  }
}

function toggleFileSelection(key, isFolder) {
  const selectionKey = isFolder && !key.endsWith('/') ? key + '/' : key;
  selectedFiles.has(selectionKey) ? selectedFiles.delete(selectionKey) : selectedFiles.add(selectionKey);
  selectionAnchor = selectionKey;
  updateSelection();
}

function createFolder() {
  if (!currentConnection || !currentBucket) {
    alert('Please select a connection and bucket first');
    return;
  }
  openDialog('folderModal');
  document.querySelector('#folderForm input').focus();
}

function hideFolderModal() {
  closeDialog('folderModal');
  document.getElementById('folderForm').reset();
}

document.getElementById('folderForm').onsubmit = async (e) => {
  e.preventDefault();
  showButtonLoading('createFolderButton');
  
  try {
    const formData = new FormData(e.target);
    const folderName = formData.get('folderName');
    const folderPath = currentPrefix + folderName + '/';
    
    await ipcRenderer.invoke('create-folder', currentConnection.id, currentBucket, folderPath);
    hideFolderModal();
    loadFiles();
  } catch (error) {
    console.error('Error creating folder:', error);
    alert('Failed to create folder');
  } finally {
    hideButtonLoading('createFolderButton');
  }
};

async function uploadFile() {
  if (!currentConnection) {
    alert('Please select a connection first');
    return;
  }

  if (!currentBucket) {
    alert('Please select a bucket first');
    return;
  }

  // Capture the destination before opening the picker; browsing while a batch
  // is running must never redirect its remaining files to a different folder.
  const target = {
    connectionId: currentConnection.id,
    connectionName: currentConnection.name,
    type: currentConnection.type,
    bucket: currentBucket,
    prefix: currentPrefix
  };
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = event => enqueueUploads(Array.from(event.target.files), target);
  
  input.click();
}

/**
 * Start a browser download for a signed URL, but verify the URL works first.
 *
 * Chromium writes whatever the server returns to disk, so an unverified URL can
 * silently produce an XML error document named "video.mp4". The main process
 * probes the URL (it can bypass CORS) and reports a readable error instead.
 *
 * @param {string} url - Signed URL to download
 * @param {string} downloadId - Transfer task ID used to correlate native events
 */
async function startVerifiedDownload(url, downloadId) {
  const check = await ipcRenderer.invoke('verify-object-url', url);
  if (!check.ok) {
    throw new Error(check.message || 'The download link is not valid.');
  }

  const task = transferTasks.get(downloadId);
  if (task) setTransferState(task, 'starting');
  const result = await ipcRenderer.invoke('start-download', { downloadId, url });
  if (!result?.success) throw new Error(result?.error || 'Could not start the download.');
}

/**
 * Get a signed URL for an object with specific operation type
 * @param {string} connectionId - The ID of the connection
 * @param {string} bucket - The bucket/container name
 * @param {string} key - The object key/path
 * @param {string} operation - The operation type ('download' or 'view')
 * @returns {Promise<string>} - The signed URL
 */
async function getObjectUrl(connectionId, bucket, key, operation = 'download') {
  console.log(`Getting ${operation} URL for object: ${key}`);
  console.log(`Connection ID: ${connectionId}, Bucket: ${bucket}`);
  
  try {
    const url = await ipcRenderer.invoke('get-object-url', connectionId, bucket, key, operation);
    console.log(`Successfully generated ${operation} URL for ${key}`);
    // 只打印URL的前100个字符，避免日志过长
    console.log(`URL (truncated): ${url.substring(0, 100)}...`);
    return url;
  } catch (error) {
    console.error(`Error getting ${operation} URL for ${key}:`, error);
    throw error;
  }
}

// 修改downloadSelected函数来使用新的getObjectUrl辅助函数
async function downloadSelected() {
  if (!currentConnection || !currentBucket) return;
  const target = {
    connectionId: currentConnection.id, connectionName: currentConnection.name,
    type: currentConnection.type, bucket: currentBucket, prefix: currentPrefix
  };
  const selectedItems = [...selectedFiles].filter(key => !key.endsWith('/')).map(Key => ({ Key }));
  
  if (selectedItems.length === 0) {
    alert('Please select files to download');
    return;
  }
  
  showButtonLoading('downloadButton');
  
  try {
    await enqueueDownloads(selectedItems, target);
  } finally {
    hideButtonLoading('downloadButton');
  }
}

async function deleteSelected() {
  if (!currentBucket) {
    alert('Please select a bucket first');
    return;
  }

  if (selectedFiles.size === 0) {
    alert('Please select files or folders to delete');
    return;
  }

  // Snapshot the user's selection and its location before any asynchronous work.
  const keys = [...selectedFiles];
  const connectionId = currentConnection.id;
  const bucket = currentBucket;
  const prefix = currentPrefix;
  const stillHere = () => currentConnection?.id === connectionId && currentBucket === bucket && currentPrefix === prefix;

  // Check if any folders are selected
  const hasFolder = Array.from(selectedFiles).some(key => key.endsWith('/'));
  const selectedCount = selectedFiles.size;

  if (hasFolder) {
    // Create and show folder deletion confirmation modal
    const folderConfirmModal = document.createElement('div');
    folderConfirmModal.className = 'modal';
    folderConfirmModal.setAttribute('role', 'dialog');
    folderConfirmModal.setAttribute('aria-modal', 'true');
    folderConfirmModal.setAttribute('aria-labelledby', 'deleteDialogTitle');
    folderConfirmModal.style.display = 'flex';
    folderConfirmModal.innerHTML = `
      <div class="modal-content">
        <h2 id="deleteDialogTitle">Delete these items?</h2>
        <p>You are about to delete ${selectedCount} item(s) including folders. This action cannot be undone.</p>
        <p>To confirm deletion, please type "DELETE" below:</p>
        <input type="text" id="folderDeleteConfirm" aria-label="Type DELETE to confirm" placeholder="Type DELETE here" autofocus>
        <div class="modal-buttons">
          <button id="cancelFolderDelete">Cancel</button>
          <button id="confirmFolderDelete" disabled>Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(folderConfirmModal);

    // Add input validation
    const input = folderConfirmModal.querySelector('#folderDeleteConfirm');
    const confirmButton = folderConfirmModal.querySelector('#confirmFolderDelete');
    const cancelButton = folderConfirmModal.querySelector('#cancelFolderDelete');
    
    // Focus the input field after a short delay to ensure it's ready
    setTimeout(() => {
      input.focus();
    }, 100);

    input.addEventListener('input', () => {
      confirmButton.disabled = input.value !== 'DELETE';
    });

    // Handle confirmation
    try {
      await new Promise((resolve, reject) => {
        confirmButton.onclick = async () => {
          try {
            showButtonLoading('deleteButton');
            let deleteCount = 0;
            let errorCount = 0;
            
            for (const key of keys) {
              try {
                const isFolder = key.endsWith('/');
                const result = await ipcRenderer.invoke('delete-object', connectionId, key, bucket, isFolder);
                deleteCount++;
                if (result.message) {
                  console.log(result.message);
                }
              } catch (error) {
                console.error('Error deleting item:', error);
                errorCount++;
              }
            }
            
            // Show appropriate notification
            if (errorCount === 0) {
              showNotification(`Successfully deleted ${deleteCount} item(s)`, 'success');
            } else if (deleteCount === 0) {
              showNotification(`Failed to delete all ${errorCount} item(s)`, 'error');
            } else {
              showNotification(`Deleted ${deleteCount} item(s), failed to delete ${errorCount} item(s)`, 'info');
            }
            
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            folderConfirmModal.remove();
            hideButtonLoading('deleteButton');
          }
        };

        // Handle cancel
        cancelButton.onclick = () => {
          folderConfirmModal.remove();
          resolve();
        };
      });
    } finally {
      if (stillHere()) await loadFiles();
    }
  } else {
    // Regular file deletion confirmation
    const confirmed = confirm('Are you sure you want to delete the selected files?');
    if (!confirmed) return;

    showButtonLoading('deleteButton');
    try {
      let deleteCount = 0;
      let errorCount = 0;
      
      for (const key of keys) {
        try {
          await ipcRenderer.invoke('delete-object', connectionId, key, bucket, false);
          deleteCount++;
        } catch (error) {
          console.error('Error deleting file:', error);
          errorCount++;
        }
      }
      
      // Show appropriate notification
      if (errorCount === 0) {
        showNotification(`Successfully deleted ${deleteCount} file(s)`, 'success');
      } else if (deleteCount === 0) {
        showNotification(`Failed to delete all ${errorCount} file(s)`, 'error');
      } else {
        showNotification(`Deleted ${deleteCount} file(s), failed to delete ${errorCount} file(s)`, 'info');
      }
      
      if (stillHere()) loadFiles();
    } finally {
      hideButtonLoading('deleteButton');
    }
  }
}

// Handle drag events
document.addEventListener('dragstart', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
});

// Notification system
let notificationTimer;
function showNotification(message, type = 'success') {
  clearTimeout(notificationTimer);
  const notification = document.getElementById('notification');
  document.getElementById('notificationMessage').textContent = message;
  notification.dataset.tone = type;
  document.getElementById('notificationIcon').className = `fa-solid fa-${type === 'error' ? 'triangle-exclamation' : type === 'info' ? 'circle-info' : 'check-circle'}`;
  notification.style.display = 'flex';
  notificationTimer = setTimeout(hideNotification, type === 'error' ? 8000 : 4500);
}
function hideNotification() {
  clearTimeout(notificationTimer);
  document.getElementById('notification').style.display = 'none';
}

async function previewFile(file) {
  const downloadTarget = {
    connectionId: currentConnection.id, connectionName: currentConnection.name,
    type: currentConnection.type, bucket: currentBucket, prefix: currentPrefix
  };
  showLoading('Loading preview...');
  try {
    // 获取文件扩展名
    const fileExtension = file.Key.split('.').pop().toLowerCase();
    
    // 对于文本文件和特殊格式，继续使用preview-object
    if (['txt', 'json', 'js', 'css', 'xml', 'md', 'markdown', 'yaml', 'yml', 'ini', 'csv', 'log'].includes(fileExtension)) {
      const result = await ipcRenderer.invoke('preview-object', currentConnection.id, currentBucket, file.Key);
      renderPreview(file, result, downloadTarget);
      return;
    }
    
    // 对于PDF和其他媒体文件，使用getObjectUrl获取URL
    console.log(`Using getObjectUrl for ${fileExtension} preview`);
    
    try {
      // 获取查看链接
      const contentUrl = await getObjectUrl(currentConnection.id, currentBucket, file.Key, 'view');
      
      // 构造与preview-object相同格式的结果对象
      const result = {
        type: fileExtension,
        content: contentUrl
      };
      
      renderPreview(file, result, downloadTarget);
    } catch (viewUrlError) {
      console.error('Error getting view URL, falling back to preview-object:', viewUrlError);
      // 如果获取链接失败，回退到原来的方法
      const result = await ipcRenderer.invoke('preview-object', currentConnection.id, currentBucket, file.Key);
      renderPreview(file, result, downloadTarget);
    }
  } catch (error) {
    console.error('Error previewing file:', error);
    hideLoading();
    showNotification(`Failed to preview file: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// 渲染预览内容（分离自previewFile函数，保持原有预览逻辑）
async function renderPreview(file, result, downloadTarget) {
  previewDownloadTarget = downloadTarget;
  const previewModal = document.getElementById('previewModal');
  const previewContent = document.getElementById('previewContent');
  
  // Clear preview content
  previewContent.innerHTML = '';
  
  // Get file extension for better handling
  const fileExtension = file.Key.split('.').pop().toLowerCase();
  
  if (result.type === 'text') {
    const pre = document.createElement('pre');
    pre.className = 'preview-text';
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;padding:24px;margin:0;font:12px/1.8 ui-monospace,monospace;min-height:100%';
    pre.textContent = result.content;
    previewContent.appendChild(pre);
  } else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'avif'].includes(fileExtension)) {
    // Image preview
    previewContent.innerHTML = `
      <div style="height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #f8f9fa;">
        <div style="max-width: 100%; max-height: 100%; overflow: auto; padding: 20px;">
          <img src="${result.content}" style="max-width: 100%; max-height: 100%; object-fit: contain;" alt="${file.Key}">
        </div>
        <div style="background: #f8f9fa; padding: 10px; border-top: 1px solid #dee2e6; width: 100%; text-align: center;">
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; padding: 8px 15px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-download"></i> Download Image
            </a>
            <a href="${result.content}" target="_blank" class="button" style="display: inline-block; padding: 8px 15px; background: #28a745; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-external-link-alt"></i> Open in New Window
            </a>
          </div>
        </div>
      </div>
    `;
  } else if (['mp4', 'mov', 'webm'].includes(fileExtension)) {
    // Video preview
    previewContent.innerHTML = `
      <div style="height: 100%; display: flex; flex-direction: column; background: #000;">
        <div style="flex: 1; position: relative; min-height: 0; overflow: hidden; display: flex; align-items: center; justify-content: center;">
          <video 
            src="${result.content}" 
            controls 
            style="max-width: 100%; max-height: 100%;"
            playsinline
          ></video>
        </div>
        <div style="background: #f8f9fa; padding: 10px; border-top: 1px solid #dee2e6;">
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; padding: 8px 15px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-download"></i> Download Video
            </a>
            <a href="${result.content}" target="_blank" class="button" style="display: inline-block; padding: 8px 15px; background: #28a745; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-external-link-alt"></i> Open in New Window
            </a>
          </div>
        </div>
      </div>
    `;
  } else if (['html', 'htm'].includes(fileExtension)) {
    // HTML files - no preview, just download and open options
    previewContent.innerHTML = `
      <div style="text-align: center; height: 100%; display: flex; align-items: center; justify-content: center;">
        <div style="background: #f8f9fa; padding: 40px; border-radius: 8px; box-shadow: 0 0 20px rgba(0,0,0,0.1); max-width: 80%;">
          <div style="font-size: 64px; color: #6c757d; margin-bottom: 20px;">
            <i class="fa-solid fa-file-code"></i>
          </div>
          <h3 style="margin-bottom: 20px; word-break: break-all;">${file.Key.split('/').pop()}</h3>
          <p>HTML files cannot be previewed directly in the application.</p>
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 20px;">
            <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; padding: 12px 24px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 16px;">
              <i class="fa-solid fa-download"></i> Download HTML File
            </a>
            <a href="${result.content}" target="_blank" class="button" style="display: inline-block; padding: 12px 24px; background: #28a745; color: white; border-radius: 4px; text-decoration: none; font-size: 16px;">
              <i class="fa-solid fa-external-link-alt"></i> Open in New Window
            </a>
          </div>
        </div>
      </div>
    `;
  } else if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(fileExtension)) {
    // Office files preview using Microsoft Office Online Viewer
    const officeViewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(result.content)}`;
    previewContent.innerHTML = `
      <div style="height: 100%; display: flex; flex-direction: column;">
        <div style="flex: 1; position: relative; min-height: 0; overflow: hidden; background: white;">
          <iframe 
            src="${officeViewerUrl}" 
            style="width: 100%; height: 100%; border: none;" 
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="fullscreen"
            onerror="this.onerror=null; this.src='data:text/html,<div style=\'padding:20px;text-align:center;color:#dc3545;\'><h3>Error Loading Office Document</h3><p>Failed to load the document. This might be due to:</p><ul style=\'text-align:left;display:inline-block;\'><li>Cross-origin restrictions</li><li>Invalid document format</li><li>Security policies</li></ul><p>Try opening in a new window instead.</p></div>'"
          ></iframe>
        </div>
        <div style="background: #f8f9fa; padding: 10px; border-top: 1px solid #dee2e6;">
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; padding: 8px 15px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-download"></i> Download Office File
            </a>
            <a href="${result.content}" target="_blank" class="button" style="display: inline-block; padding: 8px 15px; background: #28a745; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-external-link-alt"></i> Open in New Window
            </a>
          </div>
        </div>
      </div>
    `;
  } else if (fileExtension === 'pdf') {
    // PDF file preview - using iframe instead of object tag to fix automatic download issue
    previewContent.innerHTML = `
      <div style="text-align: center; height: 100%; display: flex; flex-direction: column;">
        <div style="flex: 1; position: relative; min-height: 0; overflow: hidden; background: white;">
          <iframe 
            src="${result.content}" 
            type="application/pdf" 
            style="width: 100%; height: 100%; border: none;"
            frameborder="0"
          ></iframe>
        </div>
        
        <!-- Control panel for PDF files -->
        <div style="background: #f8f9fa; padding: 10px; border-top: 1px solid #dee2e6;">
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; padding: 8px 15px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-download"></i> Download PDF
            </a>
            <a href="${result.content}" target="_blank" class="button" style="display: inline-block; padding: 8px 15px; background: #28a745; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-external-link-alt"></i> Open in New Window
            </a>
          </div>
        </div>
      </div>
    `;
  } else {
    // For other types, provide a download panel
    previewContent.innerHTML = `
      <div style="text-align: center; height: 100%; display: flex; align-items: center; justify-content: center;">
        <div style="background: #f8f9fa; padding: 40px; border-radius: 8px; box-shadow: 0 0 20px rgba(0,0,0,0.1); max-width: 80%;">
          <div style="font-size: 64px; color: #6c757d; margin-bottom: 20px;">
            <i class="fa-solid fa-file"></i>
          </div>
          <h3 style="margin-bottom: 20px; word-break: break-all;">${file.Key.split('/').pop()}</h3>
          <p>This file type cannot be previewed directly.</p>
          <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 16px;">
            <i class="fa-solid fa-download"></i> Download File
          </a>
        </div>
      </div>
    `;
  }
  
  // Show preview modal
  document.getElementById('previewTitle').textContent = file.Key;
  openDialog('previewModal');
  hideLoading();
}

// Helper function to get appropriate icon for file extension
function getFileIconForExtension(extension) {
  switch(extension) {
    case 'pdf':
      return '<i class="fa-solid fa-file-pdf"></i>';
    case 'doc':
    case 'docx':
    case 'odt':
    case 'rtf':
      return '<i class="fa-solid fa-file-word"></i>';
    case 'xls':
    case 'xlsx':
    case 'ods':
      return '<i class="fa-solid fa-file-excel"></i>';
    case 'ppt':
    case 'pptx':
    case 'odp':
      return '<i class="fa-solid fa-file-powerpoint"></i>';
    case 'zip':
    case 'rar':
    case 'tar':
    case 'gz':
    case '7z':
      return '<i class="fa-solid fa-file-zipper"></i>';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'flac':
      return '<i class="fa-solid fa-file-audio"></i>';
    case 'mp4':
    case 'mov':
    case 'avi':
    case 'mkv':
    case 'webm':
      return '<i class="fa-solid fa-file-video"></i>';
    case 'html':
    case 'htm':
    case 'css':
    case 'js':
    case 'json':
    case 'xml':
    case 'py':
    case 'java':
    case 'cpp':
    case 'cs':
    case 'rb':
      return '<i class="fa-solid fa-file-code"></i>';
    case 'txt':
    case 'md':
      return '<i class="fa-solid fa-file-lines"></i>';
    default:
      return '<i class="fa-solid fa-file"></i>';
  }
}

// Add hide preview function
function hidePreview() {
  closeDialog('previewModal');
  document.getElementById('previewContent').replaceChildren();
  previewDownloadTarget = null;
}

// Helper function to download a file with the correct content-disposition
async function downloadFile(encodedKey) {
  const target = previewDownloadTarget || (currentConnection && {
    connectionId: currentConnection.id, connectionName: currentConnection.name,
    type: currentConnection.type, bucket: currentBucket, prefix: currentPrefix
  });
  if (!target) return;
  const key = decodeURIComponent(encodedKey);
  hidePreview();
  return enqueueDownloads([{ Key: key }], target);
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  updateFormFields(); // Initialize form fields
  loadConnections(); // Load the connections when the page loads

  // Keyboard shortcut: Alt+ArrowLeft goes up one level, mirroring Finder.
  // Ignored while typing in inputs / textareas / contenteditable regions.
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const typing = target && (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    );
    if (typing || [...document.querySelectorAll('.modal, .preview-modal')].some(el => getComputedStyle(el).display !== 'none')) return;
    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateUp();
    }
  });
});

// Add this function at the end of the file
// Function to initialize direct event listeners
function initializeDirectEventListeners() {
  console.log('Initializing direct event listeners');
  
  // Add direct event listener to storage type dropdown
  const storageTypeSelect = document.getElementById('storageType');
  if (storageTypeSelect) {
    storageTypeSelect.addEventListener('change', function() {
      const selectedType = this.value;
      console.log('Storage type changed directly to:', selectedType);
      
      // Get the endpoint input element
      const endpointInput = document.getElementById('endpoint');
      
      // Only set default if endpoint is empty or has a default value from another type
      if (endpointInput) {
        const currentValue = endpointInput.value || '';
        const isDefault = 
          currentValue === 'https://s3.amazonaws.com' || 
          currentValue === 'https://<account-name>.blob.core.windows.net' || 
          currentValue === 'https://storage.googleapis.com' ||
          currentValue === '';
        
        if (isDefault) {
          // Set appropriate default based on storage type
          switch(selectedType) {
            case 'aws-s3':
              // Intentionally left blank — standard AWS S3 endpoints are
              // auto-resolved by the SDK. Setting a default URL breaks
              // cross-region operations.
              endpointInput.value = '';
              console.log('Direct handler: Cleared endpoint for AWS S3 (SDK auto-resolves)');
              break;
            case 'azure-blob':
              endpointInput.value = 'https://<account-name>.blob.core.windows.net';
              console.log('Direct handler: Set Azure Blob default endpoint');
              break;
          }
        }
      }
    });
  }
}

// Call this function when the page loads
document.addEventListener('DOMContentLoaded', function() {
  console.log('DOM fully loaded, setting up direct event listeners');
  initializeDirectEventListeners();
});

// 排序相关函数
function changeSortField(field) {
  if (field !== currentSortField) {
    currentSortField = field;
    // 当切换排序字段时，默认使用降序排序（对于修改时间和大小）或升序排序（对于名称和类型）
    if (field === 'modified' || field === 'size') {
      currentSortDirection = 'desc';
    } else {
      currentSortDirection = 'asc';
    }
    loadFiles();
  }
}

function toggleSortDirection() {
  currentSortDirection = currentSortDirection === 'asc' ? 'desc' : 'asc';
  loadFiles();
}

// 更新列标题排序图标
function updateColumnSortIcons() {
  const sortableColumns = document.querySelectorAll('.sortable-column');
  sortableColumns.forEach(col => {
    const icon = col.querySelector('i');
    if (col.getAttribute('data-sort') === currentSortField) {
      icon.className = currentSortDirection === 'asc' ? 
        'fa-solid fa-sort-up' : 'fa-solid fa-sort-down';
    } else {
      icon.className = 'fa-solid fa-sort';
    }
  });
}

// Also call this function directly to ensure it's applied immediately
initializeDirectEventListeners();

// Make functions available globally
window.downloadFile = downloadFile;
window.changeSortField = changeSortField;
window.toggleSortDirection = toggleSortDirection;
