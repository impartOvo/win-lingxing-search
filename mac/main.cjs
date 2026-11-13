'use strict';
const { app, BrowserWindow, ipcMain, shell, utilityProcess, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const reports = require('./reports.cjs');

const smoke = process.argv.includes('--smoke-test');
const smokeRoot = smoke ? fs.mkdtempSync(path.join(os.tmpdir(), 'lingxing-smoke-')) : null;
app.setName('Lingxing Search');
if (smokeRoot) app.setPath('userData', smokeRoot);
let window, child, lastBundle, stage = '就绪', logs = [];
const dataRoot = () => app.getPath('userData');
const resultRoot = () => path.join(dataRoot(), 'results');
function send(channel, payload) { if (window && !window.isDestroyed()) window.webContents.send(channel, payload); }
function log(text) { logs.push(text); if (logs.length > 10000) logs.shift(); send('collector-log', text); }
function status(text) { stage = text; send('collector-status', { running: !!child, text }); }

function runCollector(input, helpOnly = false) {
  if (child) throw new Error('已有采集任务正在运行');
  const args = helpOnly ? ['--help'] : reports.collectionArgs(input);
  fs.mkdirSync(resultRoot(), { recursive: true });
  const logDir = path.join(dataRoot(), '.private', 'launcher-logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `mac-${Date.now()}.log`);
  const worker = utilityProcess.fork(path.join(__dirname, '..', 'browser.js'), args, {
    cwd: dataRoot(), env: { ...process.env, LINGXING_DATA_DIR: dataRoot() },
    serviceName: 'Lingxing collector', stdio: 'pipe'
  });
  child = worker;
  let resultFile, buffers = { out: '', err: '' }, output = '';
  const line = text => {
    fs.appendFileSync(logFile, text + '\n', 'utf8');
    output += text + '\n';
    log(text);
    if (text.startsWith('结果：')) resultFile = text.slice(3).trim();
    if (text.includes('尚未登录领星')) status('等待 Chrome 中登录');
    if (text.includes('阶段：筛选与采集')) status('筛选与采集中');
    if (text.includes('阶段：保存结果')) status('正在保存结果');
  };
  const stream = (kind, chunk) => {
    buffers[kind] += chunk;
    const lines = buffers[kind].split(/\r?\n/);
    buffers[kind] = lines.pop();
    lines.forEach(line);
  };
  worker.stdout.setEncoding('utf8'); worker.stderr.setEncoding('utf8');
  worker.stdout.on('data', chunk => stream('out', chunk));
  worker.stderr.on('data', chunk => stream('err', chunk));
  status(helpOnly ? '检查采集模块' : '正在打开领星');
  return new Promise((resolve, reject) => {
    worker.once('exit', code => {
      Object.values(buffers).filter(Boolean).forEach(line);
      child = null;
      try {
        if (helpOnly) {
          if (code !== 0 || !output.includes('--country')) throw new Error('内置采集模块加载失败');
          status('就绪'); resolve({ ok: true }); return;
        }
        if (!resultFile || path.resolve(path.dirname(resultFile)) !== path.resolve(resultRoot())) {
          throw new Error(`采集未完成（退出码 ${code}），请查看运行日志`);
        }
        lastBundle = reports.readBundle(resultRoot(), path.basename(resultFile));
        status('采集完成'); send('collector-result', lastBundle); resolve(lastBundle);
      } catch (error) { status('采集失败'); send('collector-error', error.message); reject(error); }
    });
  });
}

function registerIPC() {
  ipcMain.handle('app-state', () => ({ history: reports.history(resultRoot()), running: !!child, status: stage, logs, dataRoot: dataRoot() }));
  ipcMain.handle('read-result', (_, name) => { lastBundle = reports.readBundle(resultRoot(), name); return lastBundle; });
  ipcMain.handle('collect', (_, input) => {
    if (child) throw new Error('已有采集任务正在运行');
    reports.collectionArgs(input);
    runCollector(input).catch(error => log(error.message));
    return { started: true };
  });
  ipcMain.handle('open-folder', async (_, which) => {
    const folder = which === 'data' ? dataRoot() : resultRoot();
    fs.mkdirSync(folder, { recursive: true });
    const error = await shell.openPath(folder); if (error) throw new Error(error);
  });
  ipcMain.handle('open-json', async () => {
    if (!lastBundle) throw new Error('请先选择采集结果');
    const error = await shell.openPath(path.join(resultRoot(), lastBundle.dataName));
    if (error) throw new Error(error);
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280, height: 880, minWidth: 980, minHeight: 680, backgroundColor: '#111620',
    title: '商品诊断', titleBarStyle: 'hiddenInset', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => { if (child) { event.preventDefault(); status('采集正在进行，请等待完成后关闭'); } });
  window.once('ready-to-show', () => { if (!smoke) window.show(); });
  window.loadFile(path.join(__dirname, 'ui', 'index.html'));
  window.webContents.once('did-finish-load', () => { if (smoke) runSmoke().catch(finishSmoke); });
}

async function runSmoke() {
  const source = path.join(__dirname, '..', 'examples');
  fs.mkdirSync(resultRoot(), { recursive: true });
  for (const name of ['browser-demo.json', 'browser-data-demo.json']) fs.copyFileSync(path.join(source, name), path.join(resultRoot(), name));
  await runCollector(null, true);
  const deadline = Date.now() + 15000;
  while (!(await window.webContents.executeJavaScript('Boolean(window.__uiReady)'))) {
    if (Date.now() > deadline) throw new Error('界面初始化超时');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-page="history"]').click();
    await window.reloadHistory();
    document.querySelector('#history-list button').click();
    await new Promise(r => setTimeout(r, 200));
    if (document.querySelector('#sales').textContent !== '12') throw new Error('销量显示错误');
    if (document.querySelector('#return-rate').textContent !== '8.33%') throw new Error('退货率显示错误');
    if (document.querySelector('#refund-rate').textContent !== '16.67%') throw new Error('退款率显示错误');
    if (document.querySelectorAll('#variants tbody tr').length !== 2) throw new Error('关联明细缺失');
    document.querySelector('#edit-query').click();
    if (document.querySelector('#value').value !== 'B0ASIN0001') throw new Error('查询回填失败');
    return true;
  })()`);
  finishSmoke();
}
function finishSmoke(error) {
  const file = process.env.LINGXING_SMOKE_REPORT;
  if (file) fs.writeFileSync(file, JSON.stringify({ status: error ? 'error' : 'ok', error: error?.message || null, arch: process.arch, platform: process.platform, packaged: app.isPackaged, collector: 'utilityProcess', dataRootOutsideApp: !dataRoot().startsWith(app.getAppPath()) }, null, 2));
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } else createWindow(); });
  app.whenReady().then(() => {
    registerIPC();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: '商品诊断', submenu: [{ role: 'about', label: '关于商品诊断' }, { type: 'separator' }, { role: 'quit', label: '退出商品诊断' }] },
      { role: 'editMenu', label: '编辑' }, { role: 'windowMenu', label: '窗口' }
    ]));
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { if (smoke) finishSmoke(error); else dialog.showErrorBox('启动失败', error.message); });
  app.on('before-quit', event => { if (child) { event.preventDefault(); status('采集正在进行，请等待完成后退出'); } });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
if (smoke) setTimeout(() => finishSmoke(new Error('macOS 应用自检超时')), 60000).unref();
