/* Desktop interaction layer. Cloud operations remain in renderer.js. */
let workspaceConnections = [];
let selectionAnchor = null;
let commandMatches = [];
let commandIndex = 0;
let dialogFocus = new WeakMap();
let themePreference = 'system';
const systemAppearance = window.matchMedia('(prefers-color-scheme: dark)');

ipcRenderer.on('refresh-files', () => {
  if (![...document.querySelectorAll('.modal, .preview-modal')].some(el => getComputedStyle(el).display !== 'none')) loadFiles();
});
ipcRenderer.on('select-all-items', () => {
  if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) {
    document.execCommand('selectAll');
  } else if (currentBucket && ![...document.querySelectorAll('.modal, .preview-modal')].some(el => getComputedStyle(el).display !== 'none')) selectVisibleFiles();
});

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function renderConnectionItem(connection) {
  const item = document.createElement('div');
  item.className = 'connection-item';
  item.dataset.connectionId = connection.id;
  item.classList.toggle('active', currentConnection?.id === connection.id);
  const name = document.createElement('button');
  name.className = 'connection-name';
  name.title = connection.name;
  name.setAttribute('aria-pressed', String(currentConnection?.id === connection.id));
  const provider = window.storageTypeLabel(connection.type);
  name.innerHTML = `<span class="provider-symbol"><i class="fa-solid fa-database"></i></span><span class="connection-copy"><span class="connection-title">${escapeHtml(connection.name)}</span><span class="connection-subtitle">${escapeHtml(provider)}<span aria-hidden="true"> · </span>${escapeHtml(connection.bucket || connection.region || 'All buckets')}</span></span>`;
  name.onclick = () => selectConnection(connection);
  const actions = document.createElement('div');
  actions.className = 'connection-actions';
  for (const [label, icon, action] of [
    ['Edit connection', 'edit', () => editConnection(connection)],
    ['Delete connection', 'trash', () => deleteConnection(connection.id)]
  ]) {
    const button = document.createElement('button');
    button.className = 'action-button';
    button.title = label;
    button.setAttribute('aria-label', `${label}: ${connection.name}`);
    button.innerHTML = `<i class="fa-solid fa-${icon}"></i>`;
    button.onclick = event => { event.stopPropagation(); action(); };
    actions.appendChild(button);
  }
  item.append(name, actions);
  return item;
}

async function deleteConnection(id) {
  const connection = workspaceConnections.find(item => item.id === id);
  if (!confirm(`Remove connection “${connection?.name || 'this connection'}”? Your cloud files will not be deleted.`)) return;
  try {
    await ipcRenderer.invoke('delete-connection', id);
    if (currentConnection?.id === id) {
      currentConnection = null;
      currentBucket = null;
      currentPrefix = '';
      selectedFiles.clear();
      fileLoadGeneration++;
      listingInProgress = false;
      hideLoading();
    }
    await loadConnections();
    showNotification('Connection removed. Cloud files are unchanged.');
  } catch (error) { showNotification(`Could not remove connection: ${error.message}`, 'error'); }
}

function renderEmptyState(title, message, icon = 'folder', action) {
  const state = document.createElement('div');
  state.className = 'empty-state';
  state.innerHTML = `<i class="fa-solid fa-${icon}"></i><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`;
  if (action) {
    const button = document.createElement('button');
    button.className = 'primary-button';
    button.textContent = action.label;
    button.onclick = action.run;
    state.appendChild(button);
  }
  document.getElementById('fileList').replaceChildren(state);
}

function renderWelcome() {
  document.getElementById('fileList').innerHTML = `<div class="empty-state welcome-state">
    <div class="welcome-graphic" aria-hidden="true"><i class="fa-solid fa-cloud"></i></div>
    <h2>All your clouds. One calm place.</h2>
    <p>Browse, upload, and manage your objects without the noise. Start by connecting your storage.</p>
    <div class="welcome-actions"><button class="primary-button" onclick="showNewConnectionModal()"><i class="fa-solid fa-plus"></i> Connect storage</button><button class="text-action-button" onclick="openCommandPalette()">Open commands <kbd data-shortcut="K">${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} K</kbd></button></div>
    <div class="supported-providers"><span>Amazon S3</span><span>Azure Blob</span><span>Aliyun OSS</span><span>Google Cloud</span></div>
  </div>`;
}

function updateWorkspace() {
  const connected = Boolean(currentConnection);
  const items = [...document.querySelectorAll('#fileList .file-item[data-key]')];
  const visible = items.filter(row => !row.hidden);
  const noun = currentBucket ? 'objects' : 'buckets';
  document.getElementById('browserToolbar').hidden = !connected;
  document.querySelector('.column-header').hidden = !connected;
  document.getElementById('workspaceEyebrow').textContent = connected ? (currentBucket ? 'OBJECT BROWSER' : 'CLOUD STORAGE') : 'YOUR WORKSPACE';
  document.getElementById('workspaceTitle').textContent = connected ? (currentPrefix.split('/').filter(Boolean).pop() || currentBucket || 'All buckets') : 'Storage, simplified.';
  document.getElementById('workspaceDescription').textContent = connected ? (currentBucket ? storageObjectUri(currentConnection.type, currentBucket, currentPrefix) : `Browse the storage in ${currentConnection.name}.`) : 'A little less friction. A lot more focus.';
  document.getElementById('viewLabel').textContent = currentBucket ? 'Objects' : 'Buckets';
  document.getElementById('objectCount').textContent = items.length;
  document.getElementById('connectionCount').textContent = workspaceConnections.length;
  document.getElementById('upButton').disabled = !connected || (!currentPrefix && (!currentBucket || currentConnection.bucket === currentBucket));
  for (const id of ['uploadButton', 'newFolderButton']) document.getElementById(id).disabled = !currentBucket || !connected;
  const search = document.getElementById('searchInput');
  search.placeholder = currentBucket ? 'Filter this folder…' : 'Filter buckets…';
  search.setAttribute('aria-label', currentBucket ? 'Filter current folder' : 'Filter buckets');
  const totalSize = visible.reduce((sum, row) => sum + Number(row.dataset.size || 0), 0);
  document.getElementById('statusSummary').textContent = connected ? `${visible.length === items.length ? items.length : `${visible.length} of ${items.length}`} ${noun}${totalSize ? ` · ${formatSize(totalSize)}` : ''}` : 'Ready when you are';
  document.getElementById('statusHint').textContent = connected ? 'Double-click to open · Space to preview' : 'One workspace. All your clouds.';
  if (!connected) {
    document.getElementById('connectionStatus').style.display = 'none';
    document.getElementById('pathBreadcrumb').innerHTML = '<span class="breadcrumb-placeholder">Workspace</span>';
    renderWelcome();
  }
  updateSelection();
}

function updateSelection() {
  const rows = [...document.querySelectorAll('#fileList .file-item[data-key]')];
  for (const row of rows) {
    const selected = selectedFiles.has(row.dataset.key);
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (checkbox) checkbox.checked = selected;
  }
  document.getElementById('selectionBar').hidden = !selectedFiles.size;
  // Swap toolbar actions in place. Inserting a new bar above the list moves
  // the clicked row between mousedown events and breaks native double-clicks.
  for (const id of ['uploadButton', 'newFolderButton']) document.getElementById(id).hidden = selectedFiles.size > 0;
  document.getElementById('selectionCount').textContent = `${selectedFiles.size} selected`;
  document.getElementById('downloadButton').disabled = !selectedFiles.size || [...selectedFiles].every(key => key.endsWith('/'));
  document.getElementById('deleteButton').disabled = !selectedFiles.size;
  const selectAll = document.getElementById('selectAll');
  if (selectAll) {
    const selectable = rows.filter(row => !row.hidden && !row.classList.contains('bucket-item'));
    const checked = selectable.filter(row => selectedFiles.has(row.dataset.key)).length;
    selectAll.checked = selectable.length > 0 && checked === selectable.length;
    selectAll.indeterminate = checked > 0 && checked < selectable.length;
  }
}

function clearSelection() {
  selectedFiles.clear();
  selectionAnchor = null;
  updateSelection();
}

function selectVisibleFiles(checked = true) {
  for (const row of document.querySelectorAll('#fileList .file-item[data-key]:not(.bucket-item)')) {
    if (!row.hidden) checked ? selectedFiles.add(row.dataset.key) : selectedFiles.delete(row.dataset.key);
  }
  updateSelection();
}

function attachRowInteraction(row, item, open) {
  row.dataset.key = item.isFolder && !item.Key.endsWith('/') ? item.Key + '/' : item.Key;
  row.dataset.size = item.isFolder ? 0 : item.Size || 0;
  row.dataset.search = `${item.Key} ${item.ContentType || ''} ${item.StorageClass || ''}`.toLowerCase();
  row.tabIndex = 0;
  row.setAttribute('role', 'row');
  row.setAttribute('aria-label', `${item.isFolder ? 'Folder' : 'File'}: ${item.Key}`);
  row.querySelector('.file-name').title = `${item.Key}\n${item.ContentType || (item.isFolder ? 'Folder' : 'File')}\nStorage class: ${item.StorageClass || '—'}\nModified: ${item.LastModified || '—'}`;
  const checkbox = row.querySelector('input');
  if (checkbox) checkbox.setAttribute('aria-label', `Select ${item.Key}`);
  row.onclick = event => {
    if (event.target.closest('button, input, .checkbox-container')) return;
    const key = row.dataset.key;
    if (event.shiftKey && selectionAnchor) {
      const rows = [...document.querySelectorAll('#fileList .file-item[data-key]')].filter(r => !r.hidden);
      const from = rows.findIndex(r => r.dataset.key === selectionAnchor);
      const to = rows.indexOf(row);
      if (from >= 0) {
        if (!event.metaKey && !event.ctrlKey) selectedFiles.clear();
        rows.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(r => selectedFiles.add(r.dataset.key));
      }
    } else if (event.metaKey || event.ctrlKey) {
      selectedFiles.has(key) ? selectedFiles.delete(key) : selectedFiles.add(key);
      selectionAnchor = key;
    } else {
      selectedFiles.clear();
      selectedFiles.add(key);
      selectionAnchor = key;
    }
    row.focus({ preventScroll: true });
    updateSelection();
  };
  row.ondblclick = event => { if (!event.target.closest('button, input')) open(); };
  row.onkeydown = event => {
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const rows = [...document.querySelectorAll('#fileList .file-item[data-key]')].filter(r => !r.hidden);
      const next = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (next) { next.focus(); next.click(); }
    }
  };
}

function filterWorkspaceFiles(query) {
  const text = query.trim().toLowerCase();
  const rows = [...document.querySelectorAll('#fileList .file-item[data-key]')];
  for (const row of rows) {
    row.hidden = Boolean(text && !row.dataset.search.includes(text));
    // Never leave hidden objects armed for a destructive bulk action.
    if (row.hidden) selectedFiles.delete(row.dataset.key);
  }
  document.getElementById('searchEmptyState')?.remove();
  if (rows.length && rows.every(row => row.hidden)) {
    const empty = document.createElement('div');
    empty.id = 'searchEmptyState';
    empty.className = 'empty-state';
    empty.innerHTML = '<i class="fa-solid fa-search"></i><h2>No matches here</h2><p>Try a different name or clear the filter to see all items.</p><button class="text-action-button">Clear filter</button>';
    empty.querySelector('button').onclick = () => { document.getElementById('searchInput').value = ''; filterFiles(''); };
    document.getElementById('fileList').appendChild(empty);
  }
  updateWorkspace();
}

function applyTheme() {
  document.documentElement.dataset.theme = themePreference === 'system' ? (systemAppearance.matches ? 'dark' : 'light') : themePreference;
  document.getElementById('themeLabel').textContent = { system: 'System', light: 'Light', dark: 'Dark' }[themePreference];
  document.querySelector('#themeButton i').className = `fa-solid fa-${{ system: 'desktop', light: 'sun', dark: 'moon' }[themePreference]}`;
  document.getElementById('themeButton').title = `Appearance: ${themePreference}. Click to cycle system, light, and dark.`;
}

function cycleTheme() {
  const choices = ['system', 'light', 'dark'];
  themePreference = choices[(choices.indexOf(themePreference) + 1) % choices.length];
  try { localStorage.setItem('obrowser.appearance', themePreference); } catch (_) { /* Preferences are optional. */ }
  applyTheme();
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  dialogFocus.set(dialog, document.activeElement);
  dialog.style.display = 'block';
  queueMicrotask(() => {
    const input = [...dialog.querySelectorAll('input:not([type="hidden"]), select')].find(element => element.getClientRects().length && !element.disabled);
    (input || dialog.querySelector('button'))?.focus();
  });
}

function closeDialog(id) {
  const dialog = document.getElementById(id);
  dialog.style.display = 'none';
  const previous = dialogFocus.get(dialog);
  if (previous?.isConnected) previous.focus();
}

function openShortcuts() { openDialog('shortcutsModal'); }
function closeShortcuts() { closeDialog('shortcutsModal'); }
function closeCommandPalette() { closeDialog('commandModal'); }

function availableCommands() {
  const commands = [
    { label: 'Add a new connection', icon: 'plus', group: 'Actions', run: showNewConnectionModal },
    { label: 'Change appearance', icon: 'sun', group: 'Actions', run: cycleTheme },
    { label: 'Keyboard shortcuts', icon: 'keyboard', group: 'Actions', run: openShortcuts }
  ];
  if (currentConnection) commands.unshift(
    { label: 'Filter current location', icon: 'search', group: 'Actions', run: () => document.getElementById('searchInput').focus() },
    { label: 'Refresh current location', icon: 'rotate', group: 'Actions', run: loadFiles }
  );
  if (currentBucket) commands.unshift(
    { label: 'Upload files', icon: 'upload', group: 'Actions', run: uploadFile },
    { label: 'Create a folder', icon: 'folder-plus', group: 'Actions', run: createFolder }
  );
  return commands.concat(workspaceConnections.map(connection => ({ label: connection.name, hint: storageTypeLabel(connection.type), icon: 'database', group: 'Connections', run: () => selectConnection(connection) })));
}

function renderCommands() {
  const query = document.getElementById('commandInput').value.trim().toLowerCase();
  commandMatches = availableCommands().filter(command => `${command.label} ${command.hint || ''}`.toLowerCase().includes(query));
  commandIndex = 0;
  const results = document.getElementById('commandResults');
  results.replaceChildren();
  let group;
  commandMatches.forEach((command, index) => {
    if (command.group !== group) {
      group = command.group;
      const heading = document.createElement('div');
      heading.className = 'command-group';
      heading.textContent = group;
      results.appendChild(heading);
    }
    const option = document.createElement('div');
    option.id = `command-${index}`;
    option.className = 'command-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === 0));
    option.innerHTML = `<i class="fa-solid fa-${command.icon}"></i><span>${escapeHtml(command.label)}</span>${command.hint ? `<small>${escapeHtml(command.hint)}</small>` : ''}`;
    option.onclick = () => runCommand(index);
    results.appendChild(option);
  });
  if (!commandMatches.length) results.innerHTML = '<div class="connection-empty">No matching commands or connections.</div>';
  syncCommandFocus();
}

function syncCommandFocus() {
  const input = document.getElementById('commandInput');
  if (commandMatches.length) input.setAttribute('aria-activedescendant', `command-${commandIndex}`);
  else input.removeAttribute('aria-activedescendant');
  document.querySelectorAll('.command-option').forEach((option, index) => {
    option.setAttribute('aria-selected', String(index === commandIndex));
    if (index === commandIndex) option.scrollIntoView({ block: 'nearest' });
  });
}

function runCommand(index) {
  const command = commandMatches[index];
  if (!command) return;
  closeCommandPalette();
  command.run();
}

function openCommandPalette() {
  document.getElementById('commandInput').value = '';
  renderCommands();
  openDialog('commandModal');
}

function prepareConnectionForm() {
  const form = document.getElementById('connectionForm');
  const actions = form.querySelector('.form-buttons');
  const identity = document.createElement('div');
  identity.className = 'form-identity';
  const nameGroup = form.elements.name.closest('.form-group');
  const typeGroup = form.elements.type.closest('.form-group');
  form.insertBefore(identity, nameGroup);
  identity.append(nameGroup, typeGroup);
  const network = document.createElement('details');
  network.className = 'advanced-options';
  network.id = 'advancedConnectionOptions';
  network.innerHTML = '<summary>Advanced · endpoint, region &amp; starting location</summary>';
  for (const element of [document.getElementById('endpointField'), document.getElementById('regionField'), form.elements.bucket.closest('.form-group'), form.elements.prefix.closest('.form-group')]) network.appendChild(element);
  form.insertBefore(network, actions);
  const label = document.createElement('span');
  label.className = 'form-section-label';
  label.textContent = 'AUTHENTICATION';
  form.insertBefore(label, document.getElementById('awsAuthMethod').closest('.form-group'));
  // Associate existing provider-specific labels without changing their IDs or save contract.
  form.querySelectorAll('.form-group').forEach((group, index) => {
    const control = group.querySelector('input, select');
    if (!control) return;
    control.id ||= `connection-field-${index}`;
    group.querySelectorAll('label').forEach(label => {
      const type = ['aws-s3', 'azure-blob', 'aliyun-oss', 'gcs'].find(type => label.classList.contains(type));
      label.htmlFor = (type && group.querySelector(`div.${type} input, div.${type} select`)?.id) || control.id;
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  try { themePreference = localStorage.getItem('obrowser.appearance') || 'system'; } catch (_) { /* Private sessions. */ }
  if (!['system', 'light', 'dark'].includes(themePreference)) themePreference = 'system';
  applyTheme();
  systemAppearance.addEventListener('change', applyTheme);
  prepareConnectionForm();
  document.querySelectorAll('[data-shortcut]').forEach(element => { element.textContent = `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'} ${element.dataset.shortcut}`; });
  updateWorkspace();
  const commandInput = document.getElementById('commandInput');
  commandInput.oninput = renderCommands;
  commandInput.onkeydown = event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      commandIndex = commandMatches.length ? (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandMatches.length) % commandMatches.length : 0;
      syncCommandFocus();
    } else if (event.key === 'Enter') { event.preventDefault(); runCommand(commandIndex); }
  };
  document.addEventListener('keydown', event => {
    const modal = [...document.querySelectorAll('.modal, .preview-modal')].reverse().find(element => getComputedStyle(element).display !== 'none');
    if (modal) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (modal.id === 'connectionModal') hideConnectionModal();
        else if (modal.id === 'folderModal') hideFolderModal();
        else if (modal.id === 'previewModal') hidePreview();
        else if (modal.id) closeDialog(modal.id);
        else modal.querySelector('#cancelFolderDelete')?.click();
      }
      if (event.key === 'Tab') {
        const focusable = [...modal.querySelectorAll('button, input, select, textarea, summary, a[href], iframe, [tabindex="0"]')].filter(element => !element.disabled && element.getClientRects().length > 0);
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openCommandPalette(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && currentConnection) { event.preventDefault(); document.getElementById('searchInput').focus(); return; }
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && currentBucket) { event.preventDefault(); selectVisibleFiles(); }
    if (event.key === 'Escape') clearSelection();
  });
  document.querySelectorAll('.modal, .preview-modal').forEach(modal => modal.addEventListener('click', event => {
    if (event.target !== modal) return;
    if (modal.id === 'connectionModal' || modal.id === 'folderModal') return; // Never discard form edits on a stray click.
    if (modal.id === 'previewModal') hidePreview();
    else closeDialog(modal.id);
  }));
});
