/* Real Electron DownloadItems served by an in-process HTTPS protocol handler.
 * No cloud, local server, credentials, or files outside the temporary profile.
 */
const { ipcMain, net } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { createDownloadManager } = require('../download-manager');
const { downloadContentDisposition } = require('../content-disposition');
const { verifyDownloadUrl } = require('../download-verifier');

module.exports = async ({ win, run, check, output }) => {
  const session = win.webContents.session;
  const manager = createDownloadManager(win.webContents);
  const filename = '中文下载验证.tar.gz';
  const targetPath = path.join(output, filename);
  const payload = Buffer.alloc(1024 * 1024, 42);
  let finishResponse;
  let nativeState;
  let allowSave;
  let mode = 'complete';
  const observed = [];
  const waitUntil = async (condition, label) => {
    const deadline = Date.now() + 8000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(condition(), label);
  };
  // Intercept the reserved .invalid host in-process. Any other URL is rejected;
  // the test never falls back to the external network.
  session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: /^https?:/.test(details.url) && new URL(details.url).hostname !== 'download.fixture.invalid' });
  });
  await session.protocol.handle('https', request => {
    if (new URL(request.url).hostname !== 'download.fixture.invalid') return new Response('', { status: 404 });
    if (request.headers.get('Range')) return new Response(payload.subarray(0, 1), {
      status: 206, headers: { 'Content-Range': `bytes 0-0/${payload.length}`, 'Content-Length': '1' }
    });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(payload.subarray(0, payload.length / 2));
        finishResponse = () => {
          controller.enqueue(payload.subarray(payload.length / 2));
          controller.close();
        };
      },
      cancel() { finishResponse = null; }
    }), { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': downloadContentDisposition(filename),
      'Content-Length': String(payload.length)
    } });
  });
  function selectPath(_, item) {
    assert.equal(item.getFilename(), filename, 'Chromium decodes filename* to the original Chinese filename');
    item.setSavePath(targetPath); // Only this fixture path, never the real Downloads directory.
    item.on('updated', () => observed.push(item.getReceivedBytes()));
    item.on('done', (_, state) => { nativeState = state; });
    allowSave = item;
    if (mode === 'cancel') item.cancel();
  }
  session.on('will-download', selectPath);
  ipcMain.removeHandler('start-download');
  ipcMain.handle('start-download', (_, request) => manager.start(request));
  ipcMain.removeHandler('verify-object-url');
  ipcMain.handle('verify-object-url', (_, url) => verifyDownloadUrl(url, net.fetch));
  try {
    await run(`window.nativeBatch = enqueueDownloads([{Key:${JSON.stringify(filename)}}], {connectionId:'fixture',connectionName:'Native download test',type:'aws-s3',bucket:'fixture',prefix:''});`);
    await run('await nativeBatch;');
    await waitUntil(() => allowSave && observed.some(bytes => bytes > 0), 'a real native DownloadItem reports bytes before completion');
    await check('real Chromium progress reaches the visible transfer row', `const task = [...transferTasks.values()][0]; return task.status === 'downloading' && task.loaded > 0 && task.loaded < task.total && task.row.querySelector('.transfer-save-path').textContent.includes(${JSON.stringify(filename)});`);
    finishResponse();
    await waitUntil(() => nativeState === 'completed', 'the native file finishes');
    await check('native completion reaches the UI only after the file is saved', 'return [...transferTasks.values()][0].status === "completed" && document.querySelector(".transfer-percent").textContent === "100%";');
    assert.deepEqual(fs.readFileSync(targetPath), payload, 'downloaded bytes are intact');
    console.log('PASS real Chromium download preserves the Chinese filename and file bytes');
    await run('clearFinishedTransfers();');
    mode = 'cancel';
    allowSave = null;
    nativeState = null;
    await run(`await enqueueDownloads([{Key:'cancelled.bin'}], {connectionId:'fixture',connectionName:'Native download test',type:'aws-s3',bucket:'fixture',prefix:''});`);
    await waitUntil(() => nativeState === 'cancelled', 'native cancellation settles');
    await check('real native cancellation is not shown as completion', 'return [...transferTasks.values()][0].status === "cancelled";');
    await run('clearFinishedTransfers();');
  } finally {
    session.removeListener('will-download', selectPath);
    manager.dispose();
    await session.protocol.unhandle('https');
  }
};
