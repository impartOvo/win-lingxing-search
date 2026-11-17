'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const core = require('../automation/core.cjs');
const { execute } = require('../automation/cli.cjs');
const { dispatch } = require('../automation/dispatch.cjs');
const platform = require('../automation/platform.cjs');
const example = (fields = {}) => core.normalizeTask({ name: '示例任务', type: 'name', value: '示例商品', country: 'CA', match: 'fuzzy', period: 'prev7', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], ...fields });
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsarfetch-auto-v15-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('batch preview expands canonical unique scopes and group; batch saves atomically without replacing old tasks', t => {
  const root = temporary(t), old = example({ group: '原分组', time: '18:00' });
  core.saveConfig(root, { enabled: true, tasks: [old] });
  const request = { task: example({ source: 'mcp', currency: 'USD' }), values: ['合成一', '合成二', '合成一'], countries: ['CA', '加拿大', 'DE'], group: '本周采集' };
  const before = fs.readFileSync(core.paths(root).config), calls = [];
  const preview = execute({ action: 'batch-preview', ...request }, root);
  assert.equal(preview.count, 4); assert.equal(new Set(preview.tasks.map(t => t.id)).size, 4);
  assert.ok(preview.tasks.every(t => t.group === '本周采集' && t.source === 'mcp' && t.currency === 'USD'));
  assert.deepEqual(fs.readFileSync(core.paths(root).config), before);
  assert.throws(() => execute({ action: 'save-batch', ...request, countries: ['CA', 123] }, root, () => calls.push(1)));
  assert.deepEqual(fs.readFileSync(core.paths(root).config), before); assert.equal(calls.length, 0);
  const saved = execute({ action: 'save-batch', ...request }, root, (_, enabled, tasks) => calls.push({ enabled, tasks }));
  assert.equal(saved.tasks.length, 5); assert.equal(calls.length, 1);
  assert.deepEqual(core.readConfig(root).tasks[0], old);
  assert.deepEqual(core.scheduleSlots(core.readConfig(root).tasks).map(slot => slot.time), ['08:00', '18:00']);
});

test('batch registration failure rolls the entire addition back; group toggles are all-or-nothing', t => {
  const root = temporary(t), old = example({ group: '分组' }), second = example({ time: '18:00', group: '分组' });
  const previous = core.saveConfig(root, { enabled: true, tasks: [old, second] }); let calls = 0;
  assert.throws(() => execute({ action: 'save-batch', task: example({ time: '09:00' }), values: ['合成'], countries: ['CA'], group: '批次' }, root, () => { if (++calls === 1) throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.deepEqual(core.readConfig(root), previous); assert.equal(calls, 2);
  assert.throws(() => execute({ action: 'set-enabled', ids: [old.id, 'missing'], enabled: false }, root, () => assert.fail('must not register')));
  assert.deepEqual(core.readConfig(root), previous);
  execute({ action: 'set-enabled', ids: [old.id, second.id], enabled: false }, root, () => {});
  assert.deepEqual(core.readConfig(root).tasks, previous.tasks.map(task => ({ ...task, enabled: false })));
});

test('backfill freezes the original civil date across year/leap boundaries, preserves definitions and dispatches only after validation', t => {
  const root = temporary(t), tasks = [example({ period: 'prev7' }), example({ period: 'lastMonth' })], now = new Date(2026, 10, 17, 10);
  core.saveConfig(root, { enabled: false, tasks }); const before = fs.readFileSync(core.paths(root).config), calls = [];
  const launchTask = (_, task, trigger, createdAt, occurrence) => { calls.push({ task, trigger, createdAt, occurrence }); return task.id; };
  dispatch(root, { ids: tasks.map(t => t.id), scheduledDate: '2024-03-01', now, launchTask });
  assert.deepEqual(calls.map(call => call.occurrence.dates), [{ from: '2024-02-23', to: '2024-02-29' }, { from: '2024-02-01', to: '2024-02-29' }]);
  assert.ok(calls.every(call => call.trigger === 'backfill' && call.occurrence.scheduledDate === '2024-03-01' && call.createdAt === now));
  dispatch(root, { ids: [tasks[0].id], scheduledDate: '2026-01-01', now, launchTask });
  assert.deepEqual(calls.at(-1).occurrence.dates, { from: '2025-12-25', to: '2025-12-31' });
  for (const options of [{ ids: [] }, { ids: [tasks[0].id, tasks[0].id] }, { ids: [tasks[0].id, crypto.randomUUID()] }, { ids: [tasks[0].id], scheduledDate: '2026-02-31' }, { ids: [tasks[0].id], scheduledDate: '2027-01-01' }]) {
    assert.throws(() => dispatch(root, { scheduledDate: '2026-01-01', now, launchTask: () => assert.fail('invalid request dispatched'), ...options }));
  }
  assert.deepEqual(fs.readFileSync(core.paths(root).config), before);
});

test('dashboard counts each logical scheduled occurrence once and distinguishes missing/future/paused/manual', t => {
  const root = temporary(t), now = new Date(2026, 10, 17, 12), date = core.localDate(now);
  const tasks = Array.from({ length: 7 }, (_, i) => example({ name: `示例 ${i}`, time: i === 4 ? '18:00' : '08:00', enabled: i !== 5 }));
  core.saveConfig(root, { enabled: true, tasks });
  function run(index, status, hour, fields = {}) {
    const item = { id: crypto.randomUUID(), taskId: tasks[index].id, task: tasks[index], status, pid: process.pid, trigger: 'schedule', dates: core.resolveDates(tasks[index], now), createdAt: new Date(2026, 10, 17, hour).toISOString(), scheduledDate: date, scheduledTime: tasks[index].time, ...fields };
    core.atomicJson(path.join(core.paths(root).runs, item.id + '.json'), item); return item;
  }
  run(0, 'error', 8); const success = run(0, 'ok', 9, { trigger: 'backfill' });
  run(1, 'error', 8); run(2, 'running', 8); run(6, 'ok', 8, { trigger: 'manual' });
  // A late retry of yesterday's occurrence must not fill today's missing slot.
  run(3, 'ok', 10, { trigger: 'backfill', scheduledDate: '2026-11-16' });
  const state = core.dashboard(root, now);
  assert.deepEqual([state.expected, state.success, state.failed, state.running, state.missing], [6, 1, 1, 1, 2]);
  assert.deepEqual(state.items.map(item => item.state), ['success', 'failed', 'running', 'missing', 'future', 'paused', 'missing']);
  assert.equal(state.items[0].runId, success.id);
  core.saveConfig(root, { enabled: false, tasks });
  const paused = core.dashboard(root, now);
  assert.equal(paused.expected, 3); assert.equal(paused.missing, 0); assert.equal(paused.items[4].state, 'paused');
  // Task edits/deletion cannot remove today's already observed occurrence.
  core.saveConfig(root, { enabled: true, tasks: [{ ...tasks[0], time: '19:00' }] });
  const edited = core.dashboard(root, now);
  assert.equal(edited.expected, 4);
  assert.equal(edited.items.filter(item => item.taskId === tasks[0].id).length, 2);
  assert.equal(edited.items.find(item => item.runId === success.id).time, '08:00');
});

test('Windows registration keeps exact collection slots and creates independent GUI monitor trigger', t => {
  const root = temporary(t), calls = [], tasks = [example(), example({ time: '18:00', days: [1, 5] })];
  const result = platform.register(root, true, tasks, { platform: 'win32', getSchedule: () => ({ enabled: true, intervalMinutes: 5 }), exec: (...args) => calls.push(args) });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0][2].input), core.scheduleSlots(tasks));
  assert.equal(calls[0][1][calls[0][1].indexOf('-TaskName') + 1], platform.taskName(root));
  assert.equal(calls[1][1][calls[1][1].indexOf('-TaskName') + 1], platform.taskName(root) + '-Monitor');
  assert.ok(calls.every(call => call[2].windowsHide));
  assert.equal(calls[1][1][calls[1][1].indexOf('-Kind') + 1], 'monitor');
  assert.equal(calls[1][1][calls[1][1].indexOf('-IntervalMinutes') + 1], '5');
  assert.deepEqual(result.monitor.args, ['--monitor-tick', '--data', root]);
  const script = fs.readFileSync(path.join(__dirname, '../automation/register-windows.ps1'), 'utf8');
  assert.match(script, /--monitor-tick --data/); assert.match(script, /-RepetitionInterval/);
  assert.match(script, /-MultipleInstances IgnoreNew/); assert.match(script, /-MultipleInstances Parallel/);
  calls.length = 0;
  platform.register(root, false, tasks, { platform: 'win32', getSchedule: () => ({ enabled: true, intervalMinutes: 30 }), exec: (...args) => calls.push(args) });
  assert.equal(calls[0][1].at(-1), 'disable'); assert.equal(calls[1][1].at(-1), 'enable');
});

test('Mac LaunchAgent separates calendar collection and GUI background monitoring, disabling each independently', t => {
  const root = temporary(t), home = temporary(t), calls = [], tasks = [example(), example({ time: '18:00' })];
  const options = { platform: 'darwin', home, uid: 501, executable: '/Applications/PulsarFetch.app/Contents/MacOS/PulsarFetch', getSchedule: () => ({ enabled: true, intervalMinutes: 5 }), exec: (...args) => calls.push(args) };
  platform.register(root, true, tasks, options);
  const folder = path.join(home, 'Library', 'LaunchAgents'), files = fs.readdirSync(folder), monitorFile = files.find(n => n.endsWith('-monitor.plist'));
  assert.equal(files.length, 2);
  const monitor = fs.readFileSync(path.join(folder, monitorFile), 'utf8'), collection = fs.readFileSync(path.join(folder, files.find(n => n !== monitorFile)), 'utf8');
  assert.match(monitor, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(monitor, /<string>--monitor-tick<\/string>/); assert.doesNotMatch(monitor, /ELECTRON_RUN_AS_NODE/);
  assert.match(collection, /<key>StartCalendarInterval<\/key>/); assert.doesNotMatch(collection, /StartInterval/);
  assert.equal((collection.match(/<key>Hour<\/key><integer>8<\/integer>/g) || []).length, 7);
  platform.register(root, false, tasks, options);
  assert.deepEqual(fs.readdirSync(folder), [monitorFile]);
  platform.register(root, false, tasks, { ...options, getSchedule: () => ({ enabled: false, intervalMinutes: 30 }) });
  assert.deepEqual(fs.readdirSync(folder), []);
  assert.throws(() => platform.monitorRegistration(root, { enabled: true, intervalMinutes: 4 }));
  assert.throws(() => core.paths('../relative'));
});
