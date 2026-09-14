/* Real Chromium / Electron smoke tests using ONLY in-memory synthetic storage.
 * Does not import main.js, read saved connections, or contact a cloud provider.
 * Run: npm run test:ui
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'obrowser-ui-'));
app.setPath('userData', path.join(output, 'profile'));
const connections = [
  { id: 's3-demo', name: 'Studio production', type: 'aws-s3', region: 'eu-west-1', authMethod: 'access-key' },
  { id: 'gcs-demo', name: 'Design & research', type: 'gcs', bucket: 'studio-research', authMethod: 'service-account' },
  { id: 'azure-demo', name: 'Archive', type: 'azure-blob', bucket: 'studio-archive' },
  { id: 'oss-demo', name: 'Asia Pacific', type: 'aliyun-oss', region: 'oss-cn-hangzhou' }
];
const fixtureFiles = [
  { Key: 'Brand assets/', isFolder: true },
  { Key: 'Photography/', isFolder: true },
  { Key: "Team's notes/", isFolder: true },
  { Key: '2026-brand-guidelines.pdf', Size: 2457800, ContentType: 'application/pdf' },
  { Key: 'campaign-cover.jpg', Size: 1840200, ContentType: 'image/jpeg' },
  { Key: 'design-tokens.json', Size: 12400, ContentType: 'application/json' },
  { Key: 'launch-film.mp4', Size: 28670400, ContentType: 'video/mp4' },
  { Key: 'readme.md', Size: 4200, ContentType: 'text/markdown' },
  { Key: 'release-notes.txt', Size: 0, ContentType: 'text/plain' },
  { Key: 'workspace-backup.zip', Size: 95434200, ContentType: 'application/zip' }
].map(item => ({ LastModified: '2026-09-10T09:30:00Z', StorageClass: 'STANDARD', ...item }));
let saved = [];
let failure = false;
let slowNext = false;
let listingCalls = 0;
const mutations = [];
const downloadChecks = [];
const errors = [];
const externalRequests = [];

ipcMain.handle('get-connections', () => saved);
ipcMain.handle('save-connections', (_, next) => { saved = next; });
ipcMain.handle('save-connection', (_, connection) => { mutations.push(['save-connection', connection.name]); saved.push(connection); });
ipcMain.handle('delete-connection', (_, id) => { mutations.push(['delete-connection', id]); saved = saved.filter(c => c.id !== id); });
ipcMain.handle('list-objects', async (_, id, bucket, prefix) => {
  listingCalls++;
  if (slowNext) { slowNext = false; await new Promise(resolve => setTimeout(resolve, 120)); }
  if (failure) throw new Error('Access denied. Check this connection’s storage permissions.');
  if (!bucket) return { type: 'buckets', data: [
    { Name: 'studio-assets', CreationDate: '2026-04-12', Region: 'eu-west-1' },
    { Name: 'studio-backups', CreationDate: '2026-02-08', Region: 'eu-west-1' },
    { Name: 'studio-delivery', CreationDate: '2026-06-24', Region: 'eu-west-1' }
  ] };
  if (prefix) return { type: 'objects', data: prefix === 'empty/' ? [] : [{ Key: `${prefix}notes.md`, Size: 120, ContentType: 'text/markdown' }] };
  return { type: 'objects', data: fixtureFiles };
});
ipcMain.handle('preview-object', () => ({ type: 'text', content: '# A quieter workspace\n\nEverything you need. Nothing in your way.\n\n<script>window.previewInjected = true</script>' }));
ipcMain.handle('list-aws-profiles', () => ({ profiles: [{ name: 'studio-sso', sourceLabel: 'SSO', region: 'eu-west-1' }], configPath: 'fixture/config' }));
ipcMain.handle('check-aws-profile', () => ({ ok: true, source: 'sso', message: 'Fixture SSO profile is ready.' }));
ipcMain.handle('check-gcloud-adc', () => ({ live: true, present: true, canSignUrls: false, hasCli: true, message: 'Fixture application default credentials found.' }));
ipcMain.handle('set-region-override', () => true);
ipcMain.handle('create-folder', (_, ...args) => { mutations.push(['create-folder', ...args]); return true; });
ipcMain.handle('get-object-url', (_, ...args) => { downloadChecks.push(['get-object-url', ...args]); return 'data:text/plain,fixture-download'; });
ipcMain.handle('verify-object-url', (_, url) => { downloadChecks.push(['verify-object-url', url]); return { ok: true }; });
ipcMain.handle('delete-object', (_, ...args) => { mutations.push(['delete-object', ...args]); return { message: 'Fixture removed' }; });

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url)) { externalRequests.push(details.url); callback({ cancel: true }); }
    else callback({});
  });
  const win = new BrowserWindow({ width: 1280, height: 840, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_, level, message) => { if (level >= 3 && !message.includes('Access denied')) errors.push(message); });
  const run = source => win.webContents.executeJavaScript(`(async () => { ${source} })()`);
  const check = async (label, source) => { assert.equal(await run(source), true, label); console.log(`PASS ${label}`); };
  // Native pointer coordinates are essential: dispatching a synthetic dblclick
  // directly on a row cannot catch layout shifts between the two clicks.
  const clickPoint = async selector => run(`const target = document.querySelector(${JSON.stringify(selector)}); target.scrollIntoView({block:'nearest'}); const rect = target.getBoundingClientRect(); return {x:Math.round(rect.left + Math.min(40, rect.width / 2)),y:Math.round(rect.top + rect.height / 2)};`);
  const pointerClick = async (point, clickCount = 1) => {
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount });
    await run('await new Promise(resolve => setTimeout(resolve, 30));');
  };
  const shot = async name => {
    await run('hideNotification(); await new Promise(resolve => setTimeout(resolve, 160));');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadFile(path.join(__dirname, '..', 'index.html'));
    await run('await loadConnections(); themePreference = "light"; applyTheme();');
    await check('empty workspace has an actionable welcome', 'return !!document.querySelector(".welcome-state button") && document.getElementById("browserToolbar").hidden;');
    await shot('01-welcome');
    saved = connections.map(connection => ({ ...connection }));
    await run('await loadConnections(); await selectConnection(workspaceConnections[0]);');
    await check('connections and buckets render', 'return document.querySelectorAll(".connection-item").length === 4 && document.querySelectorAll(".bucket-item").length === 3;');
    await shot('02-buckets');
    await run('currentBucket = "studio-assets"; updateBreadcrumb(); await loadFiles();');
    await check('object rows render without external icons', 'return document.querySelectorAll("#fileList .file-item").length === 10 && !!document.querySelector(".file-icon svg");');
    await check('file headers align with data', `const header = document.querySelectorAll('.column-header > *')[2].getBoundingClientRect(); const name = document.querySelector('.file-name').getBoundingClientRect(); return Math.abs(header.x - name.x) < 2;`);
    await check('zero-byte files show a meaningful size', 'return formatSize(0) === "0 B";');
    await shot('03-objects-light');
    const folderPoint = await clickPoint('.folder .file-name');
    const folderTop = await run('return document.querySelector(".folder").getBoundingClientRect().top;');
    await pointerClick(folderPoint);
    const selectedFolderTop = await run('return document.querySelector(".folder").getBoundingClientRect().top;');
    assert.equal(selectedFolderTop, folderTop, 'selecting a row must not move it under the pointer');
    console.log('PASS first click keeps the folder name at the same coordinates');
    await pointerClick(folderPoint, 2);
    await check('double clicking an unselected folder name enters the folder', 'return currentPrefix === "Brand assets/" && document.querySelector(".path-segment.current").textContent === "Brand assets";');
    await run('await navigateUp();');
    const filePoint = await clickPoint('.file-item[data-key="readme.md"] .file-name');
    await pointerClick(filePoint);
    await pointerClick(filePoint, 2);
    await check('double clicking an unselected file name opens its preview', 'return getComputedStyle(document.getElementById("previewModal")).display !== "none" && document.getElementById("previewTitle").textContent === "readme.md";');
    await run('hidePreview(); clearSelection();');
    await run('themePreference = "dark"; applyTheme();');
    await shot('04-objects-dark');
    await run('themePreference = "light"; applyTheme(); document.querySelectorAll("#fileList .file-item")[3].click();');
    await check('single click selects without previewing', 'return selectedFiles.size === 1 && !document.getElementById("selectionBar").hidden && getComputedStyle(document.getElementById("previewModal")).display === "none";');
    await run('const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function() {}; try { await downloadSelected(); } finally { HTMLAnchorElement.prototype.click = click; }');
    assert.equal(downloadChecks[0][0], 'get-object-url');
    assert.equal(downloadChecks[1][0], 'verify-object-url');
    console.log('PASS batch download uses the actual selection and verifies its URL');
    await run('document.querySelectorAll("#fileList .file-item")[5].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));');
    await check('shift click selects a contiguous range', 'return selectedFiles.size === 3;');
    await shot('05-selection');
    await run('document.getElementById("searchInput").value = "does not exist"; filterFiles("does not exist");');
    await check('filter clears invisible selections and explains no results', 'return selectedFiles.size === 0 && !!document.getElementById("searchEmptyState");');
    await shot('06-no-results');
    await run('document.getElementById("searchInput").value = "readme"; filterFiles("readme"); selectVisibleFiles();');
    await check('select all only selects visible items', 'return selectedFiles.size === 1 && selectedFiles.has("readme.md");');
    await run('filterFiles(""); document.getElementById("searchInput").value = ""; clearSelection();');
    const beforeSort = listingCalls;
    await run('document.querySelector("[data-sort=size]").click();');
    assert.equal(listingCalls, beforeSort, 'sorting should be local');
    await check('folder names sort correctly, folders remain first', 'return sortObjects([{Key:"z/",isFolder:true},{Key:"a/",isFolder:true},{Key:"a.txt"}])[0].isFolder === true;');
    await run('currentSortField = "name"; await loadFiles(false); await navigateTo("Team\u0027s notes/");');
    await check('apostrophes in breadcrumbs are safe and navigable', 'return document.querySelector(".path-segment.current").textContent === "Team\u0027s notes";');
    await run('await navigateUp(); await previewFile({Key:"readme.md"});');
    await check('text preview treats file content as text', 'return !window.previewInjected && document.querySelector(".preview-content pre").textContent.includes("<script>");');
    await shot('07-preview');
    await run('hidePreview(); openCommandPalette();');
    await shot('08-commands');
    await run('document.getElementById("commandInput").value = "research"; renderCommands();');
    await check('command menu searches connections', 'return commandMatches.length === 1 && commandMatches[0].label === "Design & research";');
    await run('closeCommandPalette(); showNewConnectionModal();');
    await check('new connection focuses its name and hides optional settings', 'return document.activeElement.id === "connectionName" && !document.getElementById("advancedConnectionOptions").open;');
    await shot('09-connection');
    for (const provider of ['aws-s3', 'azure-blob', 'aliyun-oss', 'gcs']) {
      await run(`document.getElementById('storageType').value = '${provider}'; updateFormFields();`);
      await check(`${provider} only shows its own credential fields`, `return [...document.querySelectorAll('#connectionForm .form-group')].filter(group => ['aws-s3','azure-blob','aliyun-oss','gcs'].some(type => group.classList.contains(type)) && !group.classList.contains('${provider}')).every(group => getComputedStyle(group).display === 'none');`);
    }
    await shot('10-gcs-connection');
    await run('document.getElementById("gcsAuthMethod").value = "adc"; updateGcsAuthFields(); await refreshGcloudAdcStatus();');
    await check('GCS ADC fields toggle correctly', 'return getComputedStyle(document.querySelector(".gcs-auth-sa")).display === "none" && getComputedStyle(document.querySelector(".gcs-auth-adc")).display !== "none";');
    await run('document.getElementById("storageType").value = "aws-s3"; updateFormFields(); document.getElementById("awsAuthMethod").value = "profile"; updateAwsAuthFields(); await refreshAwsProfiles();');
    await check('AWS SSO fields retain discovered profiles', 'return document.getElementById("awsProfile").value === "studio-sso" && getComputedStyle(document.querySelector(".aws-auth-accesskey")).display === "none";');
    await run('hideConnectionModal(); showNewConnectionModal(); document.getElementById("connectionName").value="Fixture only"; document.getElementById("accessKey").value="fixture-key"; document.getElementById("secretKey").value="fixture-secret"; await document.getElementById("connectionForm").onsubmit({preventDefault(){},target:document.getElementById("connectionForm")});');
    assert.equal(mutations[0]?.[0], 'save-connection');
    console.log('PASS standard S3 saves without a custom endpoint');
    await run('createFolder(); document.getElementById("folderName").value="Fixture folder"; await document.getElementById("folderForm").onsubmit({preventDefault(){},target:document.getElementById("folderForm")});');
    assert.equal(mutations[1][0], 'create-folder');
    console.log('PASS new folder uses the current bucket');
    await run('selectedFiles.add("Brand assets/"); updateSelection(); window.pendingDelete = deleteSelected();');
    await check('folder deletion requires explicit typed confirmation', 'return document.getElementById("confirmFolderDelete").disabled;');
    await run('document.getElementById("cancelFolderDelete").click(); await window.pendingDelete;');
    assert.equal(mutations.filter(item => item[0] === 'delete-object').length, 0);
    console.log('PASS cancelling deletion does not mutate storage');
    await run('await navigateTo("empty/");');
    await check('empty folder has an upload action', 'return document.querySelector(".empty-state button").textContent === "Upload files";');
    await shot('11-empty-folder');
    failure = true;
    await run('await loadFiles();');
    await check('access errors offer retry and do not claim success', 'return document.querySelector(".empty-state h2").textContent.includes("Couldn’t") && getComputedStyle(document.getElementById("loadingOverlay")).display === "none";');
    await shot('12-error');
    failure = false;
    await run('await navigateTo("");');
    slowNext = true;
    await run('const old = selectConnection(workspaceConnections[0]); const latest = selectConnection(workspaceConnections[1]); await Promise.all([old, latest]);');
    await check('slow old requests cannot overwrite a newer connection', 'return currentConnection.id === "gcs-demo" && document.getElementById("workspaceTitle").textContent === "studio-research" && document.querySelectorAll("#fileList .file-item").length === 10;');
    win.setSize(980, 640);
    await shot('13-small-window');
    await check('minimum desktop size has no page overflow', 'return document.documentElement.scrollWidth <= window.innerWidth && document.querySelector(".file-item").scrollWidth <= document.querySelector(".file-item").clientWidth;');
    await run('showNewConnectionModal();');
    await shot('14-small-dialog');
    await check('small dialog stays inside viewport', 'const r = document.querySelector("#connectionModal .modal-content").getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight;');
    await run('hideConnectionModal(); openCommandPalette(); document.getElementById("commandInput").dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowDown", bubbles:true}));');
    await check('command palette arrow keys move the active option', 'return document.getElementById("commandInput").getAttribute("aria-activedescendant") === "command-1";');
    await run('document.getElementById("commandInput").dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));');
    await check('Escape dismisses the command palette', 'return getComputedStyle(document.getElementById("commandModal")).display === "none";');
    win.setSize(1600, 960);
    await shot('15-wide-window');
    await check('large windows reveal secondary metadata without overflow', 'return getComputedStyle(document.querySelector(".file-details > span:nth-child(4)")).display !== "none" && document.querySelector(".file-item").scrollWidth <= document.querySelector(".file-item").clientWidth;');
    assert.deepEqual(externalRequests, [], 'UI must work without external network requests');
    assert.deepEqual(errors, [], 'No Chromium runtime errors');
    if (process.argv.includes('--update-screenshots')) {
      const gallery = path.join(__dirname, '..', 'docs', 'screenshots');
      fs.mkdirSync(gallery, { recursive: true });
      for (const [source, destination] of [['02-buckets', 'buckets'], ['03-objects-light', 'workspace-light'], ['04-objects-dark', 'workspace-dark'], ['09-connection', 'connection'], ['10-gcs-connection', 'connection-gcs'], ['08-commands', 'commands']]) {
        fs.copyFileSync(path.join(output, `${source}.png`), path.join(gallery, `${destination}.png`));
      }
    }
    console.log(`\nAll UI smoke checks passed. Screenshots: ${output}`);
    app.exit(0);
  } catch (error) {
    await shot('failure').catch(() => {});
    console.error(error);
    console.error('Renderer errors:', errors);
    console.error(`Screenshots: ${output}`);
    app.exit(1);
  }
});
