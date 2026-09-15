/* Session-scoped upload queue. It stays visible independently of folder listings. */
const uploadTasks = new Map();
const pendingUploads = [];
let uploadsRunning = false;

function isUploadFinished(task) {
  return task.status === 'completed' || task.status === 'failed';
}

function updateUploadSummary() {
  const tasks = [...uploadTasks.values()];
  const queued = tasks.filter(task => task.status === 'queued').length;
  const completed = tasks.filter(task => task.status === 'completed').length;
  const failed = tasks.filter(task => task.status === 'failed').length;
  const active = tasks.length - queued - completed - failed;
  const parts = [];
  if (active) parts.push(`${active} uploading`);
  if (queued) parts.push(`${queued} queued`);
  if (completed) parts.push(`${completed} completed`);
  if (failed) parts.push(`${failed} failed`);
  document.getElementById('uploadPanel').hidden = tasks.length === 0;
  const summary = document.getElementById('uploadSummary');
  if (summary.textContent !== parts.join(' · ')) summary.textContent = parts.join(' · ');
  document.getElementById('clearUploadsButton').disabled = completed + failed === 0;
}

function updateUploadRow(task) {
  const row = task.row;
  const percent = task.status === 'completed' ? 100
    : task.total > 0 ? Math.min(99, Math.floor(task.loaded / task.total * 100)) : 0;
  const labels = {
    queued: 'Queued', preparing: 'Preparing…', uploading: 'Uploading',
    finalizing: 'Finalizing…', completed: 'Completed', failed: 'Failed'
  };
  const label = labels[task.status];
  row.dataset.status = task.status;
  row.querySelector('.upload-state').textContent = label;
  row.querySelector('.upload-bytes').textContent = `${formatSize(task.loaded)} / ${formatSize(task.total)}`;
  row.querySelector('.upload-percent').textContent = task.status === 'finalizing' ? 'Confirming…' : `${percent}%`;
  const progress = row.querySelector('[role="progressbar"]');
  progress.setAttribute('aria-valuenow', String(percent));
  progress.setAttribute('aria-valuetext', `${label}, ${percent}%, ${formatSize(task.loaded)} of ${formatSize(task.total)}`);
  progress.querySelector('span').style.width = `${percent}%`;
  const error = row.querySelector('.upload-error');
  error.hidden = !task.error;
  error.textContent = task.error || '';
}

function setUploadState(task, status, error) {
  task.status = status;
  task.error = error;
  if (status === 'completed') task.loaded = task.total;
  updateUploadRow(task);
  updateUploadSummary();
  if (status === 'preparing') revealActiveUpload();
}

ipcRenderer.on('upload-progress', (_, progress) => {
  const task = uploadTasks.get(progress?.uploadId);
  // Only a successful IPC result marks the file as completed. Keep the original
  // cloud error instead of Electron's noisy remote-invocation wrapper.
  if (!task || isUploadFinished(task)) return;
  if (progress.status === 'failed') { task.error = progress.error; return; }
  if (!['preparing', 'uploading', 'finalizing'].includes(progress.status)) return;
  if (Number.isFinite(progress.total) && progress.total >= 0) task.total = progress.total;
  if (Number.isFinite(progress.loaded)) task.loaded = Math.min(task.total, Math.max(task.loaded, progress.loaded, 0));
  setUploadState(task, progress.status);
});

function toggleUploadPanel() {
  const toggle = document.getElementById('uploadPanelToggle');
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  document.getElementById('uploadList').hidden = !expanded;
  if (expanded) revealActiveUpload();
}

function revealActiveUpload() {
  const list = document.getElementById('uploadList');
  if (list.hidden) return;
  const active = [...uploadTasks.values()].find(task => task.status !== 'queued' && !isUploadFinished(task));
  if (!active) return;
  const rowBounds = active.row.getBoundingClientRect();
  const listBounds = list.getBoundingClientRect();
  if (rowBounds.top < listBounds.top || rowBounds.bottom > listBounds.bottom) {
    list.scrollTop += rowBounds.top - listBounds.top;
  }
}

function clearFinishedUploads() {
  for (const [id, task] of uploadTasks) {
    if (!isUploadFinished(task)) continue;
    task.row.remove();
    uploadTasks.delete(id);
  }
  updateUploadSummary();
  if (!uploadTasks.size) document.getElementById('uploadButton').focus();
}

function enqueueUploads(files, target) {
  if (!files.length) return;
  const list = document.getElementById('uploadList');
  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const task = {
      id: crypto.randomUUID(), name: file.name, filePath: file.path,
      total: file.size, loaded: 0, status: 'queued', target: { ...target },
      key: target.prefix + file.name
    };
    const row = document.createElement('li');
    task.row = row;
    row.className = 'upload-item';
    row.dataset.uploadId = task.id;
    row.innerHTML = `<span class="upload-file-icon" aria-hidden="true"><i class="fa-solid fa-file"></i></span>
      <div class="upload-details"><div class="upload-file-heading"><span class="upload-file-name"></span><span class="upload-percent"></span></div>
      <div class="upload-destination"></div>
      <div class="upload-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <div class="upload-metadata"><span class="upload-state"></span><span class="upload-bytes"></span></div>
      <div class="upload-error" hidden></div></div>`;
    row.querySelector('.upload-file-name').textContent = file.name;
    row.querySelector('.upload-file-name').title = file.name;
    const destination = `${target.connectionName} · ${storageObjectUri(target.type, target.bucket, task.key)}`;
    row.querySelector('.upload-destination').textContent = destination;
    row.querySelector('.upload-destination').title = destination;
    row.querySelector('[role="progressbar"]').setAttribute('aria-label', `Upload ${file.name}`);
    uploadTasks.set(task.id, task);
    pendingUploads.push(task);
    updateUploadRow(task);
    fragment.appendChild(row);
  }
  list.appendChild(fragment);
  list.hidden = false;
  document.getElementById('uploadPanelToggle').setAttribute('aria-expanded', 'true');
  updateUploadSummary();
  return processUploadQueue();
}

async function processUploadQueue() {
  if (uploadsRunning) return;
  uploadsRunning = true;
  const completed = [];
  let failed = 0;
  try {
    while (pendingUploads.length) {
      const task = pendingUploads.shift();
      setUploadState(task, 'preparing');
      try {
        const result = await ipcRenderer.invoke('upload-object', task.target.connectionId, task.target.bucket, task.key, task.filePath, task.id);
        if (!result?.success) throw new Error(result?.error || 'Upload did not complete.');
        setUploadState(task, 'completed');
        completed.push(task);
      } catch (error) {
        setUploadState(task, 'failed', task.error || error.message || String(error));
        failed++;
      }
    }
  } finally {
    uploadsRunning = false;
    updateUploadSummary();
  }
  // Refresh only if the visible folder was one of this queue's destinations.
  if (completed.some(task => task.target.connectionId === currentConnection?.id
    && task.target.bucket === currentBucket && task.target.prefix === currentPrefix)) {
    currentSortField = 'modified';
    currentSortDirection = 'desc';
    await loadFiles();
  }
  const message = failed
    ? `Uploaded ${completed.length} file(s), ${failed} failed. See uploads for details.`
    : completed.length === 1 ? `Successfully uploaded: ${completed[0].name}` : `Successfully uploaded ${completed.length} files`;
  showNotification(message, failed ? (completed.length ? 'info' : 'error') : 'success');
}
