const { ipcRenderer } = require('electron');

let currentConnection = null;
let currentBucket = null;
let currentPrefix = '';
let selectedFiles = new Set();
let isEditing = false;

// Loading indicators
function showLoading(message = 'Loading...') {
  document.getElementById('loadingOverlay').style.display = 'flex';
  document.getElementById('loadingOverlay').querySelector('.loading-text').textContent = message;
}

function hideLoading() {
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
        !group.classList.contains('pcg') && 
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
      // AWS S3, PCG and Azure Blob all use the standard endpoint field
      endpointField.querySelectorAll(`div.${storageType}`).forEach(div => {
        div.style.display = 'block';
      });
    }
    
    // Set default endpoint based on storage type
    const endpoint = document.getElementById('endpoint');
    if (endpoint && endpoint.style.display !== 'none' && (!endpoint.value || endpoint.value.trim() === '')) {
      switch(storageType) {
        case 'aws-s3':
          endpoint.value = 'https://s3.amazonaws.com';
          break;
        case 'azure-blob':
          endpoint.value = 'https://<account-name>.blob.core.windows.net';
          break;
        case 'pcg':
          endpoint.value = 'https://storage.googleapis.com';
          break;
      }
    }
  }
  
  // Special handling for regionField
  const regionField = document.getElementById('regionField');
  if (regionField) {
    // Only show region field for AWS S3, PCG and Aliyun OSS
    if (['aws-s3', 'pcg', 'aliyun-oss'].includes(storageType)) {
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
        !label.classList.contains('pcg') && 
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
}

// Add file size formatting function
function formatSize(bytes) {
  if (bytes === 0 || bytes === undefined || bytes === null) return '-';
  
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  
  if (i === 0) return bytes + ' ' + sizes[i];
  
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

// Connection Management
async function loadConnections() {
  showLoading('Loading connections...');
  try {
    let connections = await ipcRenderer.invoke('get-connections');
    const connectionList = document.getElementById('connectionList');
    connectionList.innerHTML = '';
    
    // Check and fix potential configuration issues
    if (Array.isArray(connections)) {
      // Check compatibility and fix
      let needsUpdate = false;
      connections = connections.map(conn => {
        // Ensure all connections have a type
        if (!conn.type) {
          conn.type = 'aws-s3'; // Default to AWS S3
          needsUpdate = true;
        }
        
        // Ensure connections have an ID
        if (!conn.id) {
          conn.id = Date.now().toString() + Math.random().toString(36).substring(2, 9);
          needsUpdate = true;
        }
        
        // Ensure Aliyun OSS connections have secure property
        if (conn.type === 'aliyun-oss' && conn.secure === undefined) {
          conn.secure = true;
          needsUpdate = true;
        }
        
        return conn;
      });
      
      // If any connections were fixed, save the updated list
      if (needsUpdate) {
        console.log('Fixed connection configurations, saving updates');
        await ipcRenderer.invoke('save-connections', connections);
      }
      
      if (connections.length > 0) {
        connections.forEach(conn => {
          // Use render function to generate connection items
          if (typeof renderConnectionItem === 'function') {
            // If renderConnectionItem function exists, use it
            const connectionItem = renderConnectionItem(conn);
            // Rebind click events (because innerHTML doesn't preserve events)
            const nameDiv = connectionItem.querySelector('.connection-name');
            if (nameDiv) {
              nameDiv.onclick = () => {
                console.log('Selecting connection with ID:', conn.id);
                selectConnection(conn);
              };
            }
            // Add events for edit and delete buttons
            const editButton = connectionItem.querySelector('.connection-actions button:first-child');
            if (editButton) {
              editButton.onclick = (e) => {
                e.stopPropagation();
                console.log('Editing connection with ID:', conn.id);
                editConnection(conn);
              };
            }
            const deleteButton = connectionItem.querySelector('.connection-actions button:last-child');
            if (deleteButton) {
              deleteButton.onclick = async (e) => {
                e.stopPropagation();
                if (confirm('Are you sure you want to delete this connection?')) {
                  try {
                    await ipcRenderer.invoke('delete-connection', conn.id);
                    showNotification(`Connection "${conn.name}" successfully deleted`, 'success');
                    loadConnections();
                  } catch (error) {
                    console.error('Error deleting connection:', error);
                    showNotification(`Failed to delete connection: ${error.message}`, 'error');
                  }
                }
              };
            }
            
            // Mark as active if it's the current connection
            if (currentConnection && currentConnection.id === conn.id) {
              connectionItem.classList.add('active');
              // Add active indicator
              if (!connectionItem.querySelector('.active-indicator')) {
                const activeIndicator = document.createElement('div');
                activeIndicator.className = 'active-indicator';
                activeIndicator.innerHTML = '<i class="fa-solid fa-check"></i>';
                const nameElement = connectionItem.querySelector('.connection-name');
                if (nameElement) {
                  nameElement.insertBefore(activeIndicator, nameElement.firstChild);
                }
              }
            }
            
            connectionList.appendChild(connectionItem);
          } else {
            // If renderConnectionItem function doesn't exist, use original implementation
            const div = document.createElement('div');
            div.className = 'connection-item';
            
            const nameDiv = document.createElement('div');
            nameDiv.className = 'connection-name';
            
            // Add connection type badge
            const connType = conn.type || 'aws-s3'; // Default to aws-s3 for backward compatibility
            const typeMap = {
              'aws-s3': 'AWS S3',
              'azure-blob': 'Azure Blob',
              'aliyun-oss': 'Aliyun OSS',
              'pcg': 'PCG'
            };
            
            nameDiv.innerHTML = `${conn.name} <span class="connection-type-badge connection-type-${connType}">${typeMap[connType] || connType}</span>`;
            nameDiv.onclick = () => selectConnection(conn);
            
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'connection-actions';
            
            const editButton = document.createElement('button');
            editButton.className = 'action-button';
            editButton.innerHTML = '<i class="fa-solid fa-edit"></i>';
            editButton.onclick = (e) => {
              e.stopPropagation();
              console.log('Editing connection with ID:', conn.id);
              editConnection(conn);
            };
            
            const deleteButton = document.createElement('button');
            deleteButton.className = 'action-button';
            deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
            deleteButton.onclick = async (e) => {
              e.stopPropagation();
              if (confirm('Are you sure you want to delete this connection?')) {
                try {
                  await ipcRenderer.invoke('delete-connection', conn.id);
                  showNotification(`Connection "${conn.name}" successfully deleted`, 'success');
                  loadConnections();
                } catch (error) {
                  console.error('Error deleting connection:', error);
                  showNotification(`Failed to delete connection: ${error.message}`, 'error');
                }
              }
            };
            
            actionsDiv.appendChild(editButton);
            actionsDiv.appendChild(deleteButton);
            
            div.appendChild(nameDiv);
            div.appendChild(actionsDiv);
            connectionList.appendChild(div);
          }
        });
      } else {
        connectionList.innerHTML = '<div class="connection-item" style="color: #6c757d;">No connections available</div>';
      }
    } else {
      console.log('Connection configuration is not in array format');
      connectionList.innerHTML = '<div class="connection-item" style="color: #6c757d;">No connections available</div>';
    }
  } catch (error) {
    console.error('Error loading connections:', error);
    // Don't show alert to avoid disturbing users at startup
    const connectionList = document.getElementById('connectionList');
    connectionList.innerHTML = '<div class="connection-item" style="color: #dc3545;">Failed to load connections</div>';
  } finally {
    hideLoading();
  }

  // Update connection status area if we have an active connection
  if (currentConnection) {
    const connectionStatus = document.getElementById('connectionStatus');
    if (connectionStatus) {
      connectionStatus.style.display = 'block';
      
      // Based on different storage types, display different messages
      const storageTypeMap = {
        'aws-s3': 'AWS S3',
        'azure-blob': 'Azure Blob',
        'aliyun-oss': 'Aliyun OSS',
        'pcg': 'PCG'
      };
      const storageTypeName = storageTypeMap[currentConnection.type] || currentConnection.type || 'AWS S3';
      
      connectionStatus.innerHTML = `<i class="fa-solid fa-link"></i> Connected to: <strong>${currentConnection.name}</strong> <span class="connection-type-badge connection-type-${currentConnection.type || 'aws-s3'}">${storageTypeName}</span>`;
      
      // Also update document title
      document.title = `OBrowser - ${currentConnection.name}`;
    }
  } else {
    // Hide connection status if no active connection
    const connectionStatus = document.getElementById('connectionStatus');
    if (connectionStatus) {
      connectionStatus.style.display = 'none';
    }
    
    // Reset document title
    document.title = 'OBrowser';
  }
}

function showNewConnectionModal() {
  isEditing = false;
  document.getElementById('connectionModalTitle').textContent = 'New Connection';
  const form = document.getElementById('connectionForm');
  
  // Reset form
  form.reset();
  
  // Set default AWS S3 storage type
  const storageTypeSelect = form.elements.type;
  storageTypeSelect.value = 'aws-s3';
  
  // Set default endpoint for AWS S3
  const endpoint = document.getElementById('endpoint');
  if (endpoint) {
    endpoint.value = 'https://s3.amazonaws.com';
    console.log('Initial AWS S3 endpoint set:', endpoint.value);
  }
  
  // Ensure proper initialization of form fields
  updateFormFields();
  
  // Manually trigger the change event to ensure other fields are updated
  storageTypeSelect.dispatchEvent(new Event('change'));
  
  // Show the modal
  document.getElementById('connectionModal').style.display = 'block';
}

function hideConnectionModal() {
  document.getElementById('connectionModal').style.display = 'none';
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
  
  console.log('Starting to edit connection:', connection);
  
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
    } else if (storageType === 'pcg') {
      // For PCG (Google Cloud Storage)
      const endpoint = document.getElementById('endpoint');
      const region = document.getElementById('region');
      const accessKey = document.getElementById('accessKey');
      const secretKey = document.getElementById('secretKey');
      
      if (endpoint) {
        endpoint.value = connection.endpoint || 'https://storage.googleapis.com';
        console.log('Setting PCG endpoint field:', connection.endpoint);
        endpoint.style.display = 'block';
      }
      if (region) {
        region.value = connection.region || 'us-central1';
        console.log('Setting PCG region field:', connection.region);
        region.style.display = 'block';
      }
      if (accessKey) accessKey.value = connection.accessKey || '';
      if (secretKey) secretKey.value = connection.secretKey || '';
    } else {
      // AWS S3
      const endpoint = document.getElementById('endpoint');
      const region = document.getElementById('region');
      const accessKey = document.getElementById('accessKey');
      const secretKey = document.getElementById('secretKey');
      
      if (endpoint) {
        endpoint.value = connection.endpoint || 'https://s3.amazonaws.com';
        console.log('Setting AWS endpoint field:', connection.endpoint);
        endpoint.style.display = 'block';
      }
      if (region) {
        region.value = connection.region || 'us-east-1';
        console.log('Setting AWS region field:', connection.region);
        region.style.display = 'block';
      }
      if (accessKey) accessKey.value = connection.accessKey || '';
      if (secretKey) secretKey.value = connection.secretKey || '';
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
            !field.classList.contains('pcg') && 
            !field.classList.contains('conditional-field')) {
          field.style.display = 'block';
        }
        // Display fields for current storage type
        else if (field.classList.contains(storageType)) {
          field.style.display = 'block';
        }
      });
      
      // For AWS S3 and PCG, always show endpoint and region fields
      if (storageType === 'aws-s3' || storageType === 'pcg') {
        const endpointField = document.getElementById('endpointField');
        const regionField = document.getElementById('regionField');
        
        if (endpointField) {
          endpointField.style.display = 'block';
          endpointField.querySelectorAll(`div.${storageType}, div.aws-s3, div.pcg`).forEach(div => {
            div.style.display = 'block';
          });
        }
        
        if (regionField) {
          regionField.style.display = 'block';
          regionField.querySelectorAll(`div.${storageType}, div.aws-s3, div.pcg`).forEach(div => {
            div.style.display = 'block';
          });
        }
      }
      
      // Ensure all input elements within visible form groups are also visible
      modalContent.querySelectorAll('.form-group[style*="display: block"] input, .form-group[style*="display: block"] select').forEach(input => {
        input.style.display = 'block';
      });
    }
    
    console.log('Editing connection complete, form values set with ID:', connection.id);
  }, 200); // Increased delay to ensure DOM is fully updated
  
  // Show the modal
  document.getElementById('connectionModal').style.display = 'block';
}

// File search functionality
function filterFiles(query) {
  const fileItems = document.querySelectorAll('.file-item');
  const searchText = query.trim().toLowerCase();
  
  if (!searchText) {
    // If search text is empty, show all items
    fileItems.forEach(item => {
      item.style.display = '';
    });
    return;
  }
  
  fileItems.forEach(item => {
    const fileNameEl = item.querySelector('.file-name');
    const fileName = fileNameEl ? fileNameEl.textContent.toLowerCase() : '';
    
    // If current item is a bucket, only search bucket name
    if (item.classList.contains('bucket-item')) {
      if (fileName.includes(searchText)) {
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
      return;
    }
    
    // For file items, search file name and path
    const filePath = item.querySelector('.file-path');
    const pathText = filePath ? filePath.getAttribute('title').toLowerCase() : '';
    
    // Get type, size, etc. other visible information
    const fileDetails = item.querySelectorAll('.file-details span');
    let otherInfo = '';
    if (fileDetails) {
      fileDetails.forEach(detail => {
        otherInfo += ' ' + detail.textContent.toLowerCase();
      });
    }
    
    // If search text matches file name, path, or other details, show the item
    if (fileName.includes(searchText) || pathText.includes(searchText) || otherInfo.includes(searchText)) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  });
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
          const awsRegion = document.getElementById('region');
          const awsAccessKey = document.getElementById('accessKey');
          const awsSecretKey = document.getElementById('secretKey');
          
          // Validate regardless of visibility
          if (awsEndpoint && !awsEndpoint.value) {
            formIsValid = false;
            errorMessage = 'Please enter Endpoint';
          } else if (awsRegion && !awsRegion.value) {
            formIsValid = false;
            errorMessage = 'Please enter Region';
          } else if (awsAccessKey && !awsAccessKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter Access Key';
          } else if (awsSecretKey && !awsSecretKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter Secret Key';
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
        
        case 'pcg':
          // Get required elements
          const pcgEndpoint = document.getElementById('endpoint');
          const pcgRegion = document.getElementById('region');
          const pcgAccessKey = document.getElementById('accessKey');
          const pcgSecretKey = document.getElementById('secretKey');
          
          // Validate regardless of visibility
          if (pcgEndpoint && !pcgEndpoint.value) {
            formIsValid = false;
            errorMessage = 'Please enter Endpoint';
          } else if (pcgRegion && !pcgRegion.value) {
            formIsValid = false;
            errorMessage = 'Please enter Region';
          } else if (pcgAccessKey && !pcgAccessKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter Access Key';
          } else if (pcgSecretKey && !pcgSecretKey.value) {
            formIsValid = false;
            errorMessage = 'Please enter Secret Key';
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
          console.log('Found existing connection to edit:', existingConnection);
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
        const awsEndpoint = document.getElementById('endpoint');
        const awsRegion = document.getElementById('region');
        const awsAccessKey = document.getElementById('accessKey');
        const awsSecretKey = document.getElementById('secretKey');
        
        // Always save these values regardless of field visibility
        if (awsEndpoint) connection.endpoint = awsEndpoint.value || 'https://s3.amazonaws.com';
        if (awsRegion) connection.region = awsRegion.value || 'us-east-1';
        if (awsAccessKey) connection.accessKey = awsAccessKey.value;
        if (awsSecretKey) connection.secretKey = awsSecretKey.value;
        break;
        
      case 'pcg':
        const pcgEndpoint = document.getElementById('endpoint');
        const pcgRegion = document.getElementById('region');
        const pcgAccessKey = document.getElementById('accessKey');
        const pcgSecretKey = document.getElementById('secretKey');
        
        // Ensure PCG has a proper endpoint
        if (pcgEndpoint) connection.endpoint = pcgEndpoint.value || 'https://storage.googleapis.com';
        if (pcgRegion) connection.region = pcgRegion.value || 'us-central1';
        if (pcgAccessKey) connection.accessKey = pcgAccessKey.value;
        if (pcgSecretKey) connection.secretKey = pcgSecretKey.value;
        break;
    }
    
    // Update bucket and prefix
    const bucketField = e.target.elements.bucket;
    const prefixField = e.target.elements.prefix;
    
    if (bucketField) connection.bucket = bucketField.value || null;
    if (prefixField) connection.prefix = prefixField.value || '';
    
    console.log('Final connection to save:', connection);
    
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
        connectionStatus.style.display = 'block';
        // Based on different storage types, display different messages
        const storageTypeMap = {
          'aws-s3': 'AWS S3',
          'azure-blob': 'Azure Blob',
          'aliyun-oss': 'Aliyun OSS',
          'pcg': 'PCG'
        };
        const storageTypeName = storageTypeMap[currentConnection.type] || currentConnection.type || 'AWS S3';
        connectionStatus.innerHTML = `<i class="fa-solid fa-link"></i> Connected to: <strong>${currentConnection.name}</strong> <span class="connection-type-badge connection-type-${currentConnection.type || 'aws-s3'}">${storageTypeName}</span>`;
        
        // Also show region information for AWS S3
        if (currentConnection.type === 'aws-s3' && currentConnection.region) {
          connectionStatus.innerHTML += ` (Region: ${currentConnection.region})`;
        }
      }
      
      // Update document title
      document.title = `OBrowser - ${currentConnection.name}`;
    }
    
    updateBreadcrumb();
    
    try {
      await loadFiles();
      // Based on different storage types, display different messages
      const storageTypeMap = {
        'aws-s3': 'AWS S3',
        'azure-blob': 'Azure Blob',
        'aliyun-oss': 'Aliyun OSS',
        'pcg': 'PCG'
      };
      const storageTypeName = storageTypeMap[currentConnection.type] || currentConnection.type || 'AWS S3';
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
  if (!connectionId) {
    console.warn('updateActiveConnection called with invalid connectionId:', connectionId);
    return;
  }
  
  console.log('Updating active connection status for ID:', connectionId);
  
  // First remove all active-indicator elements from all connection items
  document.querySelectorAll('.active-indicator').forEach(indicator => {
    indicator.remove();
  });
  
  // Remove all connection item active state
  document.querySelectorAll('.connection-item').forEach(item => {
    item.classList.remove('active');
  });
  
  // Find matching connection item and add active state
  const connectionItems = document.querySelectorAll('.connection-item');
  let found = false;
  
  console.log('Looking for connection item with data-connection-id =', connectionId);
  console.log('Found', connectionItems.length, 'connection items to check');
  
  for (let i = 0; i < connectionItems.length; i++) {
    const item = connectionItems[i];
    console.log('Checking connection item', i, 'data-connection-id =', item.dataset.connectionId);
    
    // Check if the data-connection-id attribute matches
    if (item.dataset.connectionId === connectionId) {
      console.log('FOUND! Adding active state to connection item with ID:', connectionId);
      found = true;
      item.classList.add('active');
      
      // Add active indicator
      const activeIndicator = document.createElement('div');
      activeIndicator.className = 'active-indicator';
      activeIndicator.innerHTML = '<i class="fa-solid fa-check"></i>';
      const nameDiv = item.querySelector('.connection-name');
      if (nameDiv) {
        nameDiv.insertBefore(activeIndicator, nameDiv.firstChild);
      }
      
      // Update document title with connection name
      if (currentConnection && currentConnection.name) {
        document.title = `OBrowser - ${currentConnection.name}`;
      }
      
      // Update connection status area
      const connectionStatus = document.getElementById('connectionStatus');
      if (connectionStatus) {
        connectionStatus.style.display = 'block';
        connectionStatus.innerHTML = `<i class="fa-solid fa-link"></i> Connected to: <strong>${currentConnection.name}</strong>`;
      }
      
      break;
    }
  }
  
  if (!found) {
    console.warn('Could not find connection item with ID:', connectionId);
  }
}

function updateBreadcrumb() {
  const breadcrumb = document.getElementById('pathBreadcrumb');
  const parts = currentPrefix.split('/').filter(p => p);
  
  // Start using first position (bucket or root directory)
  let html = `<span class="path-segment" onclick="navigateTo('')" title="Root directory">
                <i class="fas fa-database"></i><span style="margin-left: 5px;">${currentBucket || 'Buckets'}</span>
              </span>`;
  
  // If there are path parts, add separator and path parts
  if (parts.length > 0) {
    let path = '';
    parts.forEach((part, i) => {
      path += part + '/';
      html += ` <i class="fas fa-chevron-right" style="color: #aaa; font-size: 0.7em; margin: 0 2px;"></i> `;
      
      // Add appropriate icon for each part
      if (i === parts.length - 1) {
        // Current folder use opened folder icon
        html += `<span class="path-segment current" onclick="navigateTo('${path}')" title="${path}">
                  <i class="fas fa-folder-open"></i><span style="margin-left: 5px;">${part}</span>
                </span>`;
      } else {
        // Parent folder use regular folder icon
        html += `<span class="path-segment" onclick="navigateTo('${path}')" title="${path}">
                  <i class="fas fa-folder"></i><span style="margin-left: 5px;">${part}</span>
                </span>`;
      }
    });
  } else if (currentBucket) {
    // If in bucket root directory, show some hint
    html += ` <span style="color: #999; font-style: italic; margin-left: 0.5rem;">(root directory)</span>`;
  }
  
  breadcrumb.innerHTML = html;
}

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

async function loadFiles() {
  if (!currentConnection) return;

  showLoading('Loading files...');
  try {
    console.log('Loading files for connection:', currentConnection.id, 
                'Type:', currentConnection.type, 
                'Region:', currentConnection.region,
                'Endpoint:', currentConnection.endpoint);
                
    const result = await ipcRenderer.invoke('list-objects', 
                                           currentConnection.id, 
                                           currentBucket, 
                                           currentPrefix);
    
    console.log('Received file list result:', result ? result.type : 'No result', 
                result && result.data ? `${result.data.length} items` : 'No data');
                
    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';
    selectedFiles.clear();

    // Based on whether to display bucket list, adjust header
    const columnHeader = document.querySelector('.column-header');
    
    if (result && result.type === 'buckets' && Array.isArray(result.data)) {
      // Modify header to column for bucket applicable, remove Owner field
      if (columnHeader) {
        columnHeader.innerHTML = `
          <div></div>
          <div></div>
          <div>Bucket Name</div>
          <div>Created</div>
          <div>Region</div>
          <div>Storage Type</div>
          <div>Access</div>
          <div>Actions</div>
        `;
      }
      
      if (result.data.length === 0) {
        fileList.innerHTML = '<div class="file-item" style="justify-content: center; color: #6c757d;">No buckets found</div>';
        return;
      }
      
      result.data.forEach(bucket => {
        const div = document.createElement('div');
        div.className = 'file-item bucket-item';
        
        // Add checkbox container (consistent with file items)
        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'checkbox-container';
        checkboxContainer.style.width = '20px';
        checkboxContainer.style.visibility = 'hidden'; // Hide bucket checkbox
        div.appendChild(checkboxContainer);
        
        // Add bucket icon
        const icon = document.createElement('div');
        icon.className = 'file-icon';
        icon.innerHTML = '<i class="fa-solid fa-database"></i>'; // Use database icon to represent bucket
        div.appendChild(icon);
        
        const details = document.createElement('div');
        details.className = 'file-details bucket-details';
        
        // Extract region information (if any)
        const region = bucket.Location || bucket.Region || '-';
        // Extract storage type information
        const storageType = currentConnection ? 
          (currentConnection.type === 'aws-s3' ? 'S3' : 
           currentConnection.type === 'azure-blob' ? 'Azure' : 
           currentConnection.type === 'aliyun-oss' ? 'Aliyun' : 
           currentConnection.type === 'pcg' ? 'PCG' : 'Unknown') : 'Unknown';
        
        details.innerHTML = `
          <span class="file-name">${bucket.Name || 'Unknown'}</span>
          <span>${bucket.CreationDate ? new Date(bucket.CreationDate).toLocaleString() : '-'}</span>
          <span>${region}</span>
          <span>${storageType}</span>
          <span>${bucket.PublicAccess ? 'Public' : 'Private'}</span>
        `;
        
        // Add operation button container
        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'bucket-actions';
        
        // Add open operation
        const openButton = document.createElement('button');
        openButton.className = 'action-button';
        openButton.title = 'Open';
        openButton.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
        openButton.onclick = async (e) => {
          e.stopPropagation();
          try {
            showLoading('Loading bucket contents...');
            currentBucket = bucket.Name;
            currentPrefix = '';
            updateBreadcrumb();
            await loadFiles();
          } catch (error) {
            console.error('Error accessing bucket:', error);
            showNotification('Failed to access bucket: ' + error.message, 'error');
          } finally {
            hideLoading();
          }
        };
        actionsContainer.appendChild(openButton);
        
        details.appendChild(actionsContainer);
        
        const handleBucketClick = async (e) => {
          if (e) e.stopPropagation();
          try {
            showLoading('Loading bucket contents...');
            currentBucket = bucket.Name;
            currentPrefix = '';
            console.log('Selected bucket:', currentBucket);
            updateBreadcrumb();
            await loadFiles();
          } catch (error) {
            console.error('Error accessing bucket:', error);
            showNotification('Failed to access bucket: ' + error.message, 'error');
          } finally {
            hideLoading();
          }
        };

        div.onclick = handleBucketClick;
        details.onclick = handleBucketClick;
        icon.onclick = handleBucketClick;
        
        div.appendChild(details);
        fileList.appendChild(div);
      });
    } else if (result && result.type === 'objects' && Array.isArray(result.data)) {
      // Restore to standard file list header, add path column
      if (columnHeader) {
        columnHeader.innerHTML = `
          <div></div>
          <div></div>
          <div>Name</div>
          <div>Size</div>
          <div>Modified</div>
          <div>Type</div>
          <div>Storage Class</div>
          <div>Actions</div>
        `;
      }
      
      if (result.data.length === 0) {
        fileList.innerHTML = '<div class="file-item" style="justify-content: center; color: #6c757d;">Folder is empty</div>';
        return;
      }
      
      result.data.forEach(item => {
        // Ensure item is valid, check necessary attributes
        if (!item) return;
        
        const div = document.createElement('div');
        div.className = `file-item${item.isFolder ? ' folder' : ''}`;
        
        // Create checkbox container to prevent click propagation
        const checkboxContainer = document.createElement('div');
        checkboxContainer.className = 'checkbox-container';
        checkboxContainer.style.width = '20px';
        checkboxContainer.onclick = (e) => e.stopPropagation();
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'file-checkbox';
        checkbox.onclick = (e) => {
          e.stopPropagation();
          // Ensure Key exists
          if (item.Key) {
            toggleFileSelection(item.Key, item.isFolder);
          }
        };
        checkboxContainer.appendChild(checkbox);
        div.appendChild(checkboxContainer);

        const icon = document.createElement('div');
        icon.className = 'file-icon';
        // Use safer icon get function
        icon.innerHTML = getFileIcon(item);
        div.appendChild(icon);
        
        const details = document.createElement('div');
        details.className = 'file-details';
        
        // Safely get file name and path
        let fileName = '';
        let filePath = '';
        if (item.Key) {
          if (item.isFolder) {
            const parts = item.Key.split('/').filter(p => p);
            fileName = parts.length > 0 ? parts[parts.length - 1] : '';
            filePath = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
          } else {
            const parts = item.Key.split('/');
            fileName = parts.length > 0 ? parts[parts.length - 1] : '';
            filePath = parts.length > 1 ? parts.slice(0, -1).join('/') + '/' : '';
          }
        }
        
        details.innerHTML = `
          <span class="file-name" title="${item.Key || ''}">${fileName || 'Unknown'}</span>
          <span>${item.Size !== undefined ? formatSize(item.Size) : '-'}</span>
          <span>${item.LastModified ? new Date(item.LastModified).toLocaleString() : '-'}</span>
          <span>${item.ContentType || (item.isFolder ? 'Folder' : 'Unknown')}</span>
          <span>${item.StorageClass || '-'}</span>
        `;

        // Add file or folder operation buttons
        const actionsContainer = document.createElement('div');
        actionsContainer.className = 'file-actions';
        
        if (item.isFolder) {
          // Folder operations
          // 1. Open
          const openButton = document.createElement('button');
          openButton.className = 'action-button';
          openButton.title = 'Open folder';
          openButton.innerHTML = '<i class="fa-solid fa-folder-open"></i>';
          openButton.onclick = (e) => {
            e.stopPropagation();
            navigateTo(item.Key);
          };
          actionsContainer.appendChild(openButton);
          
          // 2. Delete
          const deleteButton = document.createElement('button');
          deleteButton.className = 'action-button';
          deleteButton.title = 'Delete folder';
          deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
          deleteButton.onclick = async (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete folder "${fileName}"? This action cannot be undone.`)) {
              showLoading('Deleting folder...');
              try {
                await ipcRenderer.invoke('delete-object', currentConnection.id, item.Key, currentBucket, true);
                showNotification(`Folder "${fileName}" deleted successfully`, 'success');
                loadFiles(); // Reload file list
              } catch (error) {
                console.error('Error deleting folder:', error);
                showNotification(`Failed to delete folder: ${error.message}`, 'error');
              } finally {
                hideLoading();
              }
            }
          };
          actionsContainer.appendChild(deleteButton);
        } else {
          // File operations
          // 1. Preview (if supported)
          const ext = item.Key.split('.').pop()?.toLowerCase();
          const supportedPreview = ext && (
            // Video formats
            ext === 'mp4' || 
            ext === 'mov' ||
            ext === 'webm' ||
            // Image formats
            ext === 'jpg' || 
            ext === 'jpeg' || 
            ext === 'png' || 
            ext === 'gif' || 
            ext === 'webp' ||
            ext === 'svg' ||
            ext === 'bmp' ||
            ext === 'ico' ||
            ext === 'tiff' ||
            ext === 'avif' ||
            // Web formats
            ext === 'html' ||
            ext === 'htm' ||
            // Microsoft Office formats
            ext === 'doc' ||
            ext === 'docx' ||
            ext === 'xls' ||
            ext === 'xlsx' ||
            ext === 'ppt' ||
            ext === 'pptx' ||
            // Document formats
            ext === 'pdf' ||
            // Text formats
            ext === 'txt' ||
            ext === 'md' ||
            ext === 'markdown' ||
            ext === 'json' ||
            ext === 'xml' ||
            ext === 'yaml' ||
            ext === 'yml' ||
            ext === 'ini' ||
            ext === 'csv' ||
            ext === 'log'
          );

          if (supportedPreview) {
            const previewButton = document.createElement('button');
            previewButton.className = 'action-button';
            previewButton.title = 'Preview';
            previewButton.innerHTML = '<i class="fa-solid fa-eye"></i>';
            previewButton.onclick = (e) => {
              e.stopPropagation();
              previewFile(item);
            };
            actionsContainer.appendChild(previewButton);
          }
          
          // 2. Download
          const downloadButton = document.createElement('button');
          downloadButton.className = 'action-button';
          downloadButton.title = 'Download';
          downloadButton.innerHTML = '<i class="fa-solid fa-download"></i>';
          downloadButton.onclick = async (e) => {
            e.stopPropagation(); // Prevent triggering the row click
            try {
              showLoading('Preparing download...');
              
              // 使用getObjectUrl获取下载链接
              const downloadUrl = await getObjectUrl(currentConnection.id, currentBucket, item.Key, 'download');
              
              // 创建一个临时链接元素并触发下载
              const link = document.createElement('a');
              link.href = downloadUrl;
              link.download = item.Key.split('/').pop(); // 设置文件名
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
              
              showNotification(`File "${fileName}" downloaded successfully`, 'success');
            } catch (error) {
              console.error('Error downloading file:', error);
              showNotification(`Failed to download file: ${error.message}`, 'error');
            } finally {
              hideLoading();
            }
          };
          actionsContainer.appendChild(downloadButton);
          
          // 3. Delete
          const deleteButton = document.createElement('button');
          deleteButton.className = 'action-button';
          deleteButton.title = 'Delete';
          deleteButton.innerHTML = '<i class="fa-solid fa-trash"></i>';
          deleteButton.onclick = async (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to delete file "${fileName}"?`)) {
              showLoading('Deleting file...');
              try {
                await ipcRenderer.invoke('delete-object', currentConnection.id, item.Key, currentBucket, false);
                showNotification(`File "${fileName}" deleted successfully`, 'success');
                loadFiles(); // Reload file list
              } catch (error) {
                console.error('Error deleting file:', error);
                showNotification(`Failed to delete file: ${error.message}`, 'error');
              } finally {
                hideLoading();
              }
            }
          };
          actionsContainer.appendChild(deleteButton);
          
          // 4. Rename (left for extension, currently commented out)
          /* Rename functionality needs backend support, not implemented
          const renameButton = document.createElement('button');
          renameButton.className = 'action-button';
          renameButton.title = 'Rename';
          renameButton.innerHTML = '<i class="fa-solid fa-pencil"></i>';
          renameButton.onclick = (e) => {
            e.stopPropagation();
            // Rename logic, needs implementation
          };
          actionsContainer.appendChild(renameButton);
          */
        }
        
        details.appendChild(actionsContainer);

        // Handle folder click for navigation
        if (item.isFolder && item.Key) {
          const handleFolderClick = (e) => {
            // Only navigate if the click is not on the checkbox
            if (!e.target.matches('input[type="checkbox"]')) {
              navigateTo(item.Key);
            }
          };
          div.onclick = handleFolderClick;
          details.onclick = handleFolderClick;
          icon.onclick = handleFolderClick;
        } else if (item.Key) {
          // Add click preview functionality for files
          const ext = item.Key.split('.').pop()?.toLowerCase();
          const supportedPreview = ext && [
            // Video formats
            'mp4', 'mov', 'webm', 
            // Image formats
            'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'avif',
            // Web formats
            'html', 'htm',
            // Document formats
            'pdf', 
            // Text formats
            'txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'ini', 'csv', 'log'
          ].includes(ext);
          
          if (supportedPreview) {
            const handleFileClick = (e) => {
              // Only preview if the click is not on the checkbox or action buttons
              if (!e.target.matches('input[type="checkbox"]') && 
                  !e.target.closest('.action-button') &&
                  !e.target.closest('.file-actions')) {
                previewFile(item);
              }
            };
            div.onclick = handleFileClick;
            div.style.cursor = 'pointer';
            details.onclick = handleFileClick;
            icon.onclick = handleFileClick;
          }
        }
        
        div.appendChild(details);
        fileList.appendChild(div);
      });
    } else {
      // Handle unexpected result format
      fileList.innerHTML = '<div class="file-item" style="justify-content: center; color: #6c757d;">No data available</div>';
    }
  } catch (error) {
    console.error('Error loading files:', error);
    
    // Check if this is a region mismatch error
    if (error.message && error.message.includes('Region mismatch')) {
      // Extract the correct region from the error message if available
      const expectedRegionMatch = error.message.match(/the bucket is in '([^']+)'/);
      const expectedRegion = expectedRegionMatch ? expectedRegionMatch[1] : 'another region';
      
      // Display a more helpful error message with instructions
      document.getElementById('fileList').innerHTML = `
        <div class="file-item" style="justify-content: center; color: #dc3545;">
          <div style="text-align: center; max-width: 600px; margin: 0 auto;">
            <div style="font-weight: bold; margin-bottom: 10px; font-size: 16px;">Region Mismatch Error</div>
            <div style="margin-bottom: 15px;">${error.message}</div>
            <div style="margin-bottom: 15px;">
              The region setting in your connection configuration does not match the actual region where your bucket is located.
            </div>
            <div style="font-weight: bold; color: #17a2b8;">
              To fix this issue:
              <ol style="text-align: left; margin-top: 5px;">
                <li>Click on the connection in the sidebar</li>
                <li>Click the edit (pencil) icon</li>
                <li>Change the region to ${expectedRegion}</li>
                <li>Save your connection</li>
              </ol>
            </div>
          </div>
        </div>
      `;
      
      // Also show a notification
      showNotification(`Region mismatch detected. Please edit your connection to use region: ${expectedRegion}`, 'error');
    } else {
      // Generic error message for other types of errors
      document.getElementById('fileList').innerHTML = `
        <div class="file-item" style="justify-content: center; color: #dc3545;">
          <div style="text-align: center;">
            <div style="font-weight: bold; margin-bottom: 5px;">Error loading files</div>
            <div>${error.message || 'An unknown error occurred'}</div>
          </div>
        </div>
      `;
    }
  } finally {
    hideLoading();
  }
}

function toggleFileSelection(key, isFolder) {
  // Ensure folder keys end with '/'
  const selectionKey = isFolder ? (key.endsWith('/') ? key : key + '/') : key;
  if (selectedFiles.has(selectionKey)) {
    selectedFiles.delete(selectionKey);
  } else {
    selectedFiles.add(selectionKey);
  }
}

function createFolder() {
  if (!currentConnection || !currentBucket) {
    alert('Please select a connection and bucket first');
    return;
  }
  document.getElementById('folderModal').style.display = 'block';
}

function hideFolderModal() {
  document.getElementById('folderModal').style.display = 'none';
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

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  
  input.onchange = async (e) => {
    showButtonLoading('uploadButton');
    try {
      const files = Array.from(e.target.files);
      let uploadCount = 0;
      let errorCount = 0;
      
      for (const file of files) {
        try {
          const key = currentPrefix + file.name;
          await ipcRenderer.invoke('upload-object', currentConnection.id, currentBucket, key, file.path);
          uploadCount++;
        } catch (error) {
          console.error('Error uploading file:', error);
          errorCount++;
          // Don't show alerts for each file to avoid overwhelming the user
        }
      }
      
      // Show a summary notification
      if (errorCount === 0) {
        showNotification(`Successfully uploaded ${uploadCount} file(s)`, 'success');
      } else if (uploadCount === 0) {
        showNotification(`Failed to upload all ${errorCount} file(s)`, 'error');
      } else {
        showNotification(`Uploaded ${uploadCount} file(s), failed to upload ${errorCount} file(s)`, 'info');
      }
      
      loadFiles();
    } finally {
      hideButtonLoading('uploadButton');
    }
  };
  
  input.click();
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
  const selectedItems = getSelectedItems();
  
  if (selectedItems.length === 0) {
    alert('Please select files to download');
    return;
  }
  
  showButtonLoading('downloadButton');
  
  try {
    let downloadCount = 0;
    let errors = [];
    
    for (const item of selectedItems) {
      if (item.Type === 'folder') continue;
      
      try {
        const key = item.Key;
        console.log(`Preparing to download: ${key}`);
        
        // 使用getObjectUrl获取下载链接
        const downloadUrl = await getObjectUrl(currentConnection.id, currentBucket, key, 'download');
        
        // 创建一个临时链接元素并触发下载
        const link = document.createElement('a');
        link.href = downloadUrl;
        link.download = key.split('/').pop(); // 设置文件名
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        downloadCount++;
      } catch (error) {
        console.error('Error downloading file:', error);
        errors.push({ file: item.Key, error: error.message });
      }
    }
    
    if (errors.length === 0) {
      if (downloadCount === 0) {
        showNotification('All downloads were cancelled', 'info');
      } else {
        showNotification(`Successfully downloaded ${downloadCount} file(s)`, 'success');
      }
    } else {
      const message = `Downloaded ${downloadCount} file(s)` +
        (errors.length > 0 ? `, but ${errors.length} file(s) failed to download.` : '');
      showNotification(message, 'warning');
      console.error('Download errors:', errors);
    }
  } catch (error) {
    console.error('Error in batch download:', error);
    showNotification(`Download failed: ${error.message}`, 'error');
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

  // Check if any folders are selected
  const hasFolder = Array.from(selectedFiles).some(key => key.endsWith('/'));
  const selectedCount = selectedFiles.size;

  if (hasFolder) {
    // Create and show folder deletion confirmation modal
    const folderConfirmModal = document.createElement('div');
    folderConfirmModal.className = 'modal';
    folderConfirmModal.style.display = 'flex';
    folderConfirmModal.innerHTML = `
      <div class="modal-content">
        <h2>⚠️ Warning: Folder Deletion</h2>
        <p>You are about to delete ${selectedCount} item(s) including folders. This action cannot be undone.</p>
        <p>To confirm deletion, please type "DELETE" below:</p>
        <input type="text" id="folderDeleteConfirm" placeholder="Type DELETE here" autofocus>
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
            
            for (const key of selectedFiles) {
              try {
                const isFolder = key.endsWith('/');
                const result = await ipcRenderer.invoke('delete-object', currentConnection.id, key, currentBucket, isFolder);
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
      await loadFiles();
    }
  } else {
    // Regular file deletion confirmation
    const confirmed = confirm('Are you sure you want to delete the selected files?');
    if (!confirmed) return;

    showButtonLoading('deleteButton');
    try {
      let deleteCount = 0;
      let errorCount = 0;
      
      for (const key of selectedFiles) {
        try {
          await ipcRenderer.invoke('delete-object', currentConnection.id, key, currentBucket, false);
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
      
      loadFiles();
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
function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  const notificationMessage = document.getElementById('notificationMessage');
  
  // Set message
  notificationMessage.textContent = message;
  
  // Set color based on type
  if (type === 'success') {
    notification.style.backgroundColor = '#28a745';
  } else if (type === 'error') {
    notification.style.backgroundColor = '#dc3545';
  } else if (type === 'info') {
    notification.style.backgroundColor = '#17a2b8';
  }
  
  // Show notification
  notification.style.display = 'block';
  
  // Auto hide after 5 seconds
  setTimeout(hideNotification, 5000);
}

function hideNotification() {
  const notification = document.getElementById('notification');
  notification.style.display = 'none';
}

async function previewFile(file) {
  showLoading('Loading preview...');
  try {
    // 获取文件扩展名
    const fileExtension = file.Key.split('.').pop().toLowerCase();
    
    // 对于文本文件和特殊格式，继续使用preview-object
    if (['txt', 'json', 'js', 'css', 'xml', 'md', 'markdown', 'yaml', 'yml', 'ini', 'csv', 'log'].includes(fileExtension)) {
      const result = await ipcRenderer.invoke('preview-object', currentConnection.id, currentBucket, file.Key);
      renderPreview(file, result);
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
      
      renderPreview(file, result);
    } catch (viewUrlError) {
      console.error('Error getting view URL, falling back to preview-object:', viewUrlError);
      // 如果获取链接失败，回退到原来的方法
      const result = await ipcRenderer.invoke('preview-object', currentConnection.id, currentBucket, file.Key);
      renderPreview(file, result);
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
function renderPreview(file, result) {
  const previewModal = document.getElementById('previewModal');
  const previewContent = document.getElementById('previewContent');
  
  // Clear preview content
  previewContent.innerHTML = '';
  
  // Get file extension for better handling
  const fileExtension = file.Key.split('.').pop().toLowerCase();
  
  if (result.type === 'text') {
    // 处理文本文件...
    let content = result.content;
    let language = '';
    
    // Add basic syntax highlighting for markdown
    if (['md', 'markdown'].includes(fileExtension)) {
      // Simple markdown highlighting
      content = content
        // Headers
        .replace(/^(#{1,6})\s(.+)$/gm, '<span style="color: #0d6efd;">$1</span> <span style="color: #0d6efd; font-weight: bold;">$2</span>')
        // Bold
        .replace(/\*\*(.+?)\*\*/g, '<span style="font-weight: bold;">$1</span>')
        // Italic
        .replace(/\*(.+?)\*/g, '<span style="font-style: italic;">$1</span>')
        // Code blocks
        .replace(/```[\s\S]+?```/g, match => `<span style="color: #d63384;">${match}</span>`)
        // Inline code
        .replace(/`(.+?)`/g, '<span style="color: #d63384; background: #f8f9fa; padding: 0 4px; border-radius: 3px;">$1</span>')
        // Links
        .replace(/\[(.+?)\]\((.+?)\)/g, '<span style="color: #0d6efd;">[$1]($2)</span>')
        // Lists
        .replace(/^(\s*[-*+]|\d+\.)\s/gm, '<span style="color: #198754;">$1 </span>');
    }
    
    previewContent.innerHTML = `
      <div style="height: 100%; overflow: auto; background: white;">
        <pre style="white-space: pre-wrap; word-wrap: break-word; padding: 20px; margin: 0; font-size: 14px; line-height: 1.5; font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;">${content}</pre>
      </div>
    `;
  } else if (['html', 'htm'].includes(fileExtension)) {
    // HTML file preview - using iframe instead of embed to fix black screen issue
    previewContent.innerHTML = `
      <div style="text-align: center; height: 100%; display: flex; flex-direction: column;">
        <div style="flex: 1; position: relative; min-height: 0; overflow: hidden; background: white;">
          <iframe 
            src="${result.content}" 
            style="width: 100%; height: 100%; border: none;" 
            sandbox="allow-scripts allow-same-origin allow-forms"
            allow="fullscreen"
          ></iframe>
        </div>
        
        <!-- Control panel for HTML files -->
        <div style="background: #f8f9fa; padding: 10px; border-top: 1px solid #dee2e6;">
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <a href="#" onclick="downloadFile('${encodeURIComponent(file.Key)}'); return false;" class="button" style="display: inline-block; padding: 8px 15px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 14px;">
              <i class="fa-solid fa-download"></i> Download HTML File
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
          <a href="${result.content}" download="${file.Key.split('/').pop()}" class="button" style="display: inline-block; margin-top: 20px; padding: 12px 24px; background: #0066cc; color: white; border-radius: 4px; text-decoration: none; font-size: 16px;">
            <i class="fa-solid fa-download"></i> Download File
          </a>
        </div>
      </div>
    `;
  }
  
  // Show preview modal
  previewModal.style.display = 'block';
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
  document.getElementById('previewModal').style.display = 'none';
}

// Helper function to download a file with the correct content-disposition
async function downloadFile(encodedKey) {
  try {
    showLoading('Preparing download...');
    const key = decodeURIComponent(encodedKey);
    
    // 使用明确的下载操作获取URL
    const downloadUrl = await getObjectUrl(currentConnection.id, currentBucket, key, 'download');
    
    // 创建一个临时链接元素并触发下载
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = key.split('/').pop(); // 设置文件名
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showNotification(`File "${key.split('/').pop()}" download started`, 'success');
  } catch (error) {
    console.error('Error downloading file:', error);
    showNotification(`Failed to download file: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  updateFormFields(); // Initialize form fields
  loadConnections(); // Load the connections when the page loads
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
              endpointInput.value = 'https://s3.amazonaws.com';
              console.log('Direct handler: Set AWS S3 default endpoint');
              break;
            case 'azure-blob':
              endpointInput.value = 'https://<account-name>.blob.core.windows.net';
              console.log('Direct handler: Set Azure Blob default endpoint');
              break;
            case 'pcg':
              endpointInput.value = 'https://storage.googleapis.com';
              console.log('Direct handler: Set PCG default endpoint');
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

// Also call this function directly to ensure it's applied immediately
initializeDirectEventListeners();

// Make downloadFile available globally
window.downloadFile = downloadFile;


