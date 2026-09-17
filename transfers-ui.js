/* Session-scoped transfers stay visible independently of folder listings. */
const transferTasks = new Map();
const pendingUploads = [];
const pendingDownloads = [];
let uploadsRunning = false;
let downloadsPreparing = false;

function isTransferFinished(task) {
  return ['completed', 'failed', 'cancelled'].includes(task.status);
}

function updateTransferSummary() {
  const tasks = [...transferTasks.values()];
  const count = status => tasks.filter(task => task.status === status).length;
  const uploading = tasks.filter(task => task.direction === 'upload' && task.status !== 'queued' && !isTransferFinished(task)).length;
  const downloading = tasks.filter(task => task.direction === 'download' && task.status !== 'queued' && !isTransferFinished(task)).length;
  const parts = [];
  if (uploading) parts.push(`${uploading} uploading`);
  if (downloading) parts.push(`${downloading} downloading`);
  for (const status of ['queued', 'completed', 'failed', 'cancelled']) {
    if (count(status)) parts.push(`${count(status)} ${status}`);
  }
  document.getElementById('transferPanel').hidden = tasks.length === 0;
  const summary = document.getElementById('transferSummary');
  if (summary.textContent !== parts.join(' · ')) summary.textContent = parts.join(' · ');
  document.getElementById('clearTransfersButton').disabled = !tasks.some(isTransferFinished);
}

function updateTransferRow(task) {
  const row = task.row;
  const knownSize = Number.isFinite(task.total) && task.total >= 0;
  const percent = task.status === 'completed' ? 100
    : task.total > 0 ? Math.min(99, Math.floor(task.loaded / task.total * 100)) : 0;
  const labels = {
    queued: 'Queued', preparing: 'Preparing…', uploading: 'Uploading',
    verifying: 'Checking download link…', starting: 'Starting download…',
    'awaiting-save': 'Choose save location…', downloading: 'Downloading',
    paused: 'Paused', interrupted: 'Interrupted',
    finalizing: 'Finalizing…', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled'
  };
  const label = labels[task.status];
  row.dataset.status = task.status;
  row.querySelector('.transfer-state').textContent = label;
  row.querySelector('.transfer-bytes').textContent = `${formatSize(task.loaded)} / ${knownSize ? formatSize(task.total) : 'Size unknown'}`;
  row.querySelector('.transfer-percent').textContent = task.status === 'finalizing' ? 'Confirming…' : knownSize ? `${percent}%` : '—';
  const progress = row.querySelector('[role="progressbar"]');
  if (knownSize) progress.setAttribute('aria-valuenow', String(percent));
  else progress.removeAttribute('aria-valuenow');
  progress.setAttribute('aria-valuetext', `${label}, ${knownSize ? `${percent}%, ` : ''}${formatSize(task.loaded)}${knownSize ? ` of ${formatSize(task.total)}` : ' transferred; total size unknown'}`);
  progress.classList.toggle('indeterminate', !knownSize && !isTransferFinished(task));
  progress.querySelector('span').style.width = knownSize ? `${percent}%` : '';
  const error = row.querySelector('.transfer-error');
  error.hidden = !task.error;
  error.textContent = task.error || '';
  const savePath = row.querySelector('.transfer-save-path');
  savePath.hidden = !task.localPath;
  savePath.textContent = task.localPath ? `Save to: ${task.localPath}` : '';
  savePath.title = task.localPath || '';
}

function setTransferState(task, status, error) {
  const changed = task.status !== status;
  task.status = status;
  task.error = error;
  if (status === 'completed') {
    if (task.direction === 'upload') task.loaded = task.total;
    else if (!Number.isFinite(task.total)) task.total = task.loaded;
  }
  updateTransferRow(task);
  updateTransferSummary();
  if (changed && ['preparing', 'downloading'].includes(status)) revealActiveTransfer(task);
}

ipcRenderer.on('upload-progress', (_, progress) => {
  const task = transferTasks.get(progress?.uploadId);
  if (!task || task.direction !== 'upload' || isTransferFinished(task)) return;
  // Only a successful IPC result marks an upload completed. Preserve the cloud
  // error rather than Electron's remote-invocation wrapper.
  if (progress.status === 'failed') { task.error = progress.error; return; }
  if (!['preparing', 'uploading', 'finalizing'].includes(progress.status)) return;
  if (Number.isFinite(progress.total) && progress.total >= 0) task.total = progress.total;
  if (Number.isFinite(progress.loaded)) task.loaded = Math.min(task.total, Math.max(task.loaded, progress.loaded, 0));
  setTransferState(task, progress.status);
});

ipcRenderer.on('download-progress', (_, progress) => {
  const task = transferTasks.get(progress?.downloadId);
  if (!task || task.direction !== 'download' || isTransferFinished(task)) return;
  if (!['awaiting-save', 'downloading', 'paused', 'interrupted', 'completed', 'failed', 'cancelled'].includes(progress.status)) return;
  if (progress.total === null || (Number.isFinite(progress.total) && progress.total >= 0)) task.total = progress.total;
  // Chromium may restart a resumed download from zero; use its actual count.
  if (Number.isFinite(progress.loaded)) task.loaded = Math.max(0, progress.loaded);
  if (typeof progress.path === 'string') task.localPath = progress.path;
  setTransferState(task, progress.status, progress.error);
});

function toggleTransferPanel() {
  const toggle = document.getElementById('transferPanelToggle');
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  document.getElementById('transferList').hidden = !expanded;
  if (expanded) revealActiveTransfer();
}

function revealActiveTransfer(task) {
  const list = document.getElementById('transferList');
  if (list.hidden) return;
  const active = task || [...transferTasks.values()].find(item => item.status !== 'queued' && !isTransferFinished(item));
  if (!active) return;
  const rowBounds = active.row.getBoundingClientRect();
  const listBounds = list.getBoundingClientRect();
  if (rowBounds.top < listBounds.top || rowBounds.bottom > listBounds.bottom) list.scrollTop += rowBounds.top - listBounds.top;
}

function clearFinishedTransfers() {
  for (const [id, task] of transferTasks) {
    if (!isTransferFinished(task)) continue;
    task.row.remove();
    transferTasks.delete(id);
  }
  updateTransferSummary();
  if (!transferTasks.size) document.getElementById('fileList').focus();
}

function addTransfer({ direction, name, key, total, filePath, target }) {
  const task = {
    id: crypto.randomUUID(), direction, name, key, filePath,
    total: Number.isFinite(total) && total >= 0 ? total : null,
    loaded: 0, status: 'queued', target: { ...target }
  };
  const row = document.createElement('li');
  task.row = row;
  row.className = 'transfer-item';
  row.dataset.transferId = task.id;
  row.dataset.direction = direction;
  row.innerHTML = `<span class="transfer-file-icon" aria-hidden="true"><i class="fa-solid fa-${direction}"></i></span>
    <div class="transfer-details"><div class="transfer-file-heading"><span class="transfer-file-name"></span><span class="transfer-percent"></span></div>
    <div class="transfer-destination"></div><div class="transfer-save-path" hidden></div>
    <div class="transfer-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div>
    <div class="transfer-metadata"><span class="transfer-state"></span><span class="transfer-bytes"></span></div>
    <div class="transfer-error" hidden></div></div>`;
  row.querySelector('.transfer-file-name').textContent = name;
  row.querySelector('.transfer-file-name').title = name;
  const destination = `${direction === 'download' ? 'From' : 'To'} ${target.connectionName} · ${storageObjectUri(target.type, target.bucket, key)}`;
  row.querySelector('.transfer-destination').textContent = destination;
  row.querySelector('.transfer-destination').title = destination;
  row.querySelector('[role="progressbar"]').setAttribute('aria-label', `${direction === 'download' ? 'Download' : 'Upload'} ${name}`);
  transferTasks.set(task.id, task);
  updateTransferRow(task);
  document.getElementById('transferList').appendChild(row);
  return task;
}

function showTransferPanel() {
  document.getElementById('transferList').hidden = false;
  document.getElementById('transferPanelToggle').setAttribute('aria-expanded', 'true');
  updateTransferSummary();
}

function enqueueUploads(files, target) {
  if (!files.length) return;
  for (const file of files) {
    pendingUploads.push(addTransfer({ direction: 'upload', name: file.name, filePath: file.path,
      total: file.size, key: target.prefix + file.name, target }));
  }
  showTransferPanel();
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
      setTransferState(task, 'preparing');
      try {
        const result = await ipcRenderer.invoke('upload-object', task.target.connectionId, task.target.bucket, task.key, task.filePath, task.id);
        if (!result?.success) throw new Error(result?.error || 'Upload did not complete.');
        setTransferState(task, 'completed');
        completed.push(task);
      } catch (error) {
        setTransferState(task, 'failed', task.error || error.message || String(error));
        failed++;
      }
    }
  } finally {
    uploadsRunning = false;
    updateTransferSummary();
  }
  if (completed.some(task => task.target.connectionId === currentConnection?.id
    && task.target.bucket === currentBucket && task.target.prefix === currentPrefix)) {
    currentSortField = 'modified';
    currentSortDirection = 'desc';
    await loadFiles();
  }
  const message = failed
    ? `Uploaded ${completed.length} file(s), ${failed} failed. See transfers for details.`
    : completed.length === 1 ? `Successfully uploaded: ${completed[0].name}` : `Successfully uploaded ${completed.length} files`;
  showNotification(message, failed ? (completed.length ? 'info' : 'error') : 'success');
}

function enqueueDownloads(files, target) {
  if (!files.length) return;
  for (const file of files) {
    pendingDownloads.push(addTransfer({ direction: 'download', name: file.Key.split('/').pop(),
      key: file.Key, total: file.Size, target }));
  }
  showTransferPanel();
  return prepareDownloadQueue();
}

async function prepareDownloadQueue() {
  if (downloadsPreparing) return;
  downloadsPreparing = true;
  try {
    while (pendingDownloads.length) {
      const task = pendingDownloads.shift();
      setTransferState(task, 'preparing');
      try {
        const url = await getObjectUrl(task.target.connectionId, task.target.bucket, task.key, 'download');
        setTransferState(task, 'verifying');
        await startVerifiedDownload(url, task.id);
        // start-download only acknowledges launch. Native DownloadItem events
        // own progress and completion (including errors AFTER a valid preflight).
      } catch (error) {
        if (!isTransferFinished(task)) setTransferState(task, 'failed', error.message || String(error));
      }
    }
  } finally {
    downloadsPreparing = false;
  }
}
