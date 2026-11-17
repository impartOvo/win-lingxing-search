'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const mainSource = fs.readFileSync(path.join(__dirname, '../mac/main.cjs'), 'utf8');

async function host(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsarfetch-mac-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { locks: 0, windows: 0, dialogs: 0, collector: 0, monitoring: [], features: [], paths: [], targets: [], notifications: [], exit: null };
  const userData = path.join(root, 'Lingxing Search'); fs.mkdirSync(userData);
  const paths = { appData: root, userData }, handlers = new Map(), app = new EventEmitter();
  Object.assign(app, { getPath: key => paths[key], setPath: (key, value) => { paths[key] = value; }, setName() {},
    whenReady: () => Promise.resolve(), requestSingleInstanceLock: () => { calls.locks++; return true; },
    exit: code => { calls.exit = code; }, quit: () => { calls.exit = 0; }, dock: { hide: () => { calls.dockHidden = true; } }, isPackaged: false });
  class BrowserWindow extends EventEmitter {
    constructor() { super(); calls.windows++; this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {}; this.webContents.send = () => {}; }
    loadFile() {} isDestroyed() { return false; }
    static getAllWindows() { return []; }
  }
  class Notification extends EventEmitter {
    constructor(input) { super(); this.input = input; calls.notifications.push(input); }
    static isSupported() { return options.supported !== false; }
    show() {
      if (options.delivery === 'throw') throw new Error('synthetic notification failure');
      if (options.delivery !== 'timeout') queueMicrotask(() => this.emit(options.delivery === 'failed' ? 'failed' : 'show'));
    }
  }
  const electron = { app, BrowserWindow, Notification, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { openPath: async file => { calls.paths.push(file); return ''; }, openExternal: async target => { calls.targets.push(target); } },
    utilityProcess: { fork: () => { calls.collector++; throw new Error('collector must not launch'); } },
    Menu: { setApplicationMenu() {}, buildFromTemplate: value => value }, dialog: { showErrorBox: () => { calls.dialogs++; } } };
  const monitoring = { execute: async (packet, dataRoot) => {
    calls.monitoring.push({ packet: JSON.parse(JSON.stringify(packet)), root: dataRoot });
    if (options.tickError) throw new Error('synthetic tick failure');
    return { pendingNotifications: options.pending || [] };
  } };
  const mocks = { electron, './reports.cjs': {}, '../automation/cli.cjs': { execute() { throw new Error('must not register schedules'); } }, '../mcp/cli.cjs': {},
    '../workspace.cjs': { execute: async (packet, dataRoot) => { calls.features.push({ packet, root: dataRoot }); return { ok: true }; } },
    '../monitoring/cli.cjs': monitoring, '../mcp/settings.cjs': { safeError: error => error.message } };
  const argv = ['electron', 'mac/main.cjs', ...(options.args || [])].map(value => value === '$ROOT' ? root : value);
  vm.runInNewContext(mainSource, { require: name => Object.hasOwn(mocks, name) ? mocks[name] : require(name), __dirname: path.join(__dirname, '../mac'),
    process: { argv, env: {}, platform: 'darwin', arch: 'x64' }, console, URL,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 10)), clearTimeout }, { filename: 'mac/main.cjs' });
  await new Promise(resolve => setImmediate(resolve));
  return { root, userData, calls, handlers, paths, wait: async () => {
    const until = Date.now() + 1000;
    while (calls.exit === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.notEqual(calls.exit, null, 'background host must exit');
  } };
}

test('renderer bridge preserves existing APIs and forwards exact feature/export/target arguments', async t => {
  const h = await host(t);
  assert.equal(h.calls.locks, 1); assert.equal(h.calls.windows, 1);
  assert.equal(h.paths.userData, h.userData);
  for (const key of ['mcp', 'automation', 'automation-log', 'app-state', 'read-result', 'collect', 'open-folder', 'open-json', 'feature', 'open-export', 'open-target']) assert.ok(h.handlers.has(key), key);
  const packet = { module: 'data', request: { action: 'history', filters: { search: '合成' } } };
  assert.equal((await h.handlers.get('feature')(null, packet)).ok, true);
  assert.deepEqual(h.calls.features, [{ packet, root: h.userData }]);
  let exposed; const invokes = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../mac/preload.cjs'), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_, api) => { exposed = api; } }, ipcRenderer: { invoke: (...args) => invokes.push(args), on() {} } }) });
  exposed.feature(packet); exposed.openExport('/synthetic/export.xlsx'); exposed.openTarget('https://xfg.lingxing.com/erp/EmailService');
  assert.deepEqual(invokes, [['feature', packet], ['open-export', '/synthetic/export.xlsx'], ['open-target', 'https://xfg.lingxing.com/erp/EmailService']]);
  for (const key of ['state', 'readResult', 'collect', 'mcp', 'automation', 'automationLog', 'openFolder', 'openJSON', 'onLog', 'onStatus', 'onResult', 'onError']) assert.equal(typeof exposed[key], 'function', key);
});

test('export opening confines real files to exports and target opening only permits exact Lingxing pages', async t => {
  const h = await host(t), exports = path.join(h.userData, 'exports'), outside = path.join(h.root, 'outside');
  fs.mkdirSync(exports); fs.mkdirSync(outside);
  const file = path.join(exports, '合成.xlsx'); fs.writeFileSync(file, 'synthetic');
  await h.handlers.get('open-export')(null, file); assert.deepEqual(h.calls.paths, [fs.realpathSync(file)]);
  const escaped = path.join(outside, 'escape.csv'); fs.writeFileSync(escaped, 'synthetic');
  for (const target of [escaped, '../escape.csv', path.join(exports, '..', 'escape.csv'), path.join(exports, 'not-an-export.exe')]) await assert.rejects(h.handlers.get('open-export')(null, target));
  fs.symlinkSync(outside, path.join(exports, 'jump'), 'junction');
  await assert.rejects(h.handlers.get('open-export')(null, path.join(exports, 'jump', 'escape.csv')));
  fs.renameSync(exports, exports + '-original'); fs.symlinkSync(outside, exports, 'junction');
  await assert.rejects(h.handlers.get('open-export')(null, path.join(exports, 'escape.csv')));
  for (const target of ['https://xfg.lingxing.com/erp/EmailService', 'https://xfg.lingxing.com/erp/productExpressionNew']) await h.handlers.get('open-target')(null, target);
  for (const target of ['file:///tmp/test', 'https://evil.example/erp/EmailService', 'https://xfg.lingxing.com@localhost/erp/EmailService', 'https://xfg.lingxing.com/erp/EmailService?redirect=https://evil.example', 'https://xfg.lingxing.com/erp/EmailService#x', 'javascript:alert(1)']) await assert.rejects(h.handlers.get('open-target')(null, target));
  assert.equal(h.calls.paths.length, 1); assert.equal(h.calls.targets.length, 2);
});

test('independent background monitor skips GUI lock/window/dialog/collector and acknowledges only shown versions', async t => {
  const pending = [{ id: 'synthetic-stock', kind: 'inventory', notifyVersion: 2 }, { id: 'synthetic-mail', kind: 'mail', notifyVersion: 4 }];
  const h = await host(t, { args: ['--monitor-tick', '--data', '$ROOT'], pending }); await h.wait();
  assert.deepEqual([h.calls.locks, h.calls.windows, h.calls.dialogs, h.calls.collector, h.calls.exit], [0, 0, 0, 0, 0]);
  assert.equal(h.calls.dockHidden, true); assert.equal(h.calls.monitoring[0].root, h.root);
  assert.deepEqual(h.calls.monitoring.map(call => call.packet), [{ action: 'tick' }, { action: 'ack-notifications', ids: ['synthetic-stock', 'synthetic-mail'], versions: { 'synthetic-stock': 2, 'synthetic-mail': 4 } }]);
  assert.equal(h.calls.notifications.length, 1);
  assert.match(h.calls.notifications[0].body, /库存 1 项，站内信 1 项/);
});

test('unsupported, failed, throwing and permission-timeout notifications keep events pending without fake acknowledgment', async t => {
  for (const options of [{ supported: false }, { delivery: 'failed' }, { delivery: 'throw' }, { delivery: 'timeout' }]) {
    const h = await host(t, { args: ['--monitor-tick', '--data', '$ROOT'], pending: [{ id: 'synthetic', kind: 'mail', notifyVersion: 1 }], ...options }); await h.wait();
    assert.deepEqual(h.calls.monitoring.map(call => call.packet.action), ['tick']);
    assert.equal(h.calls.windows, 0); assert.equal(h.calls.dialogs, 0); assert.equal(h.calls.exit, 0);
    assert.match(fs.readFileSync(path.join(h.root, '.private/monitoring/host.log'), 'utf8'), /待投递提醒已保留/);
  }
});

test('background errors are logged without dialogs or GUI lock; empty state exits without notifications', async t => {
  for (const options of [{ tickError: true }, { args: ['--monitor-tick', '--data', 'relative'] }]) {
    const h = await host(t, { args: ['--monitor-tick', '--data', '$ROOT'], ...options }); await h.wait();
    assert.deepEqual([h.calls.locks, h.calls.windows, h.calls.dialogs, h.calls.collector, h.calls.exit], [0, 0, 0, 0, 1]);
    assert.ok(fs.existsSync(path.join(h.paths.userData, '.private/monitoring/host.log')));
  }
  const empty = await host(t, { args: ['--monitor-tick', '--data', '$ROOT'] }); await empty.wait();
  assert.equal(empty.calls.exit, 0); assert.equal(empty.calls.notifications.length, 0); assert.equal(empty.calls.monitoring.length, 1);
});
