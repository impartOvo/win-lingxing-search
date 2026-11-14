'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const core = require('../automation/core.cjs');
const { dispatch, launch } = require('../automation/dispatch.cjs');
const { execute } = require('../automation/cli.cjs');
function example(fields = {}) { return core.normalizeTask({ name: '示例任务', type: 'name', value: '示例商品', country: 'CA', match: 'fuzzy', period: 'prev7', time: '09:00', days: [1, 2, 3, 4, 5, 6], ...fields }); }
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxing-auto-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('automation dates distinguish rolling, calendar, current-day and fixed ranges across year and leap boundaries', () => {
  const now = new Date(2026, 0, 5, 9, 0);
  const dates = period => core.resolveDates({ period }, now);
  assert.deepEqual(dates('today'), { from: '2026-01-05', to: '2026-01-05' });
  assert.deepEqual(dates('yesterday'), { from: '2026-01-04', to: '2026-01-04' });
  assert.deepEqual(dates('recent7'), { from: '2025-12-30', to: '2026-01-05' });
  assert.deepEqual(dates('prev7'), { from: '2025-12-29', to: '2026-01-04' });
  assert.deepEqual(dates('lastWeek'), { from: '2025-12-29', to: '2026-01-04' });
  assert.deepEqual(dates('thisWeek'), { from: '2026-01-05', to: '2026-01-05' });
  assert.deepEqual(dates('lastMonth'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(core.resolveDates({ period: 'lastMonth' }, new Date(2024, 2, 1)), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(core.resolveDates({ period: 'custom', from: '2025-02-01', to: '2025-02-07' }, now), { from: '2025-02-01', to: '2025-02-07' });
  assert.notDeepEqual(core.resolveDates({ period: 'prev7' }, new Date(2026, 0, 6)), dates('prev7'));
});

test('task edits persist, reject bad schedules, and delete independently of saved results', t => {
  const root = temporary(t), task = example();
  assert.equal(task.country, '加拿大');
  assert.throws(() => example({ days: [] })); assert.throws(() => example({ days: [7] }));
  assert.throws(() => example({ time: '25:00' })); assert.throws(() => example({ period: 'custom', from: '2026-02-31', to: '2026-03-01' }));
  assert.throws(() => example({ id: '../../outside' }));
  execute({ action: 'save-task', task }, root);
  execute({ action: 'save-task', task: { ...task, time: '18:30', enabled: false } }, root);
  assert.equal(core.readConfig(root).tasks.length, 1);
  assert.equal(core.readConfig(root).tasks[0].enabled, false);
  assert.equal(core.readConfig(root).tasks[0].time, '18:30');
  fs.mkdirSync(path.join(root, 'results')); fs.writeFileSync(path.join(root, 'results', 'keep.json'), '{}');
  execute({ action: 'delete-task', id: task.id }, root);
  assert.deepEqual(core.readConfig(root).tasks, []);
  assert.ok(fs.existsSync(path.join(root, 'results', 'keep.json')));
});

test('scheduler dispatches every due task without a concurrency cap, claims once, respects days and pause', t => {
  const root = temporary(t), now = new Date(2026, 10, 16, 9, 0, 5);
  const tasks = Array.from({ length: 40 }, (_, i) => example({ name: `示例 ${i}` }));
  tasks.push(example({ enabled: false }), example({ time: '09:01' }), example({ days: [0] }));
  core.saveConfig(root, { enabled: true, tasks });
  const launched = [];
  const launchTask = (_, task, trigger, when) => { launched.push({ task, trigger, dates: core.resolveDates(task, when) }); return task.id; };
  assert.equal(dispatch(root, { scheduled: true, now, launchTask }).length, 40);
  assert.equal(dispatch(root, { scheduled: true, now, launchTask }).length, 0);
  assert.equal(launched.length, 40);
  assert.equal(launched[0].trigger, 'schedule');
  assert.deepEqual(launched[0].dates, { from: '2026-11-09', to: '2026-11-15' });
  core.saveConfig(root, { enabled: false, tasks });
  assert.equal(dispatch(root, { scheduled: true, now: new Date(2026, 10, 17, 9), launchTask }).length, 0);
  assert.equal(dispatch(root, { ids: [tasks[40].id], now, launchTask }).length, 1); // manual can run a disabled task
  assert.throws(() => dispatch(root, { ids: ['missing'], launchTask }));
});

test('next run rolls over skipped Sunday and does not rewrite a running task snapshot on edit', t => {
  const root = temporary(t), task = example(), now = new Date(2026, 10, 14, 10);
  const next = new Date(core.nextRun(task, now));
  assert.equal(core.localDate(next), '2026-11-16'); assert.equal(next.getHours(), 9);
  core.saveConfig(root, { enabled: true, tasks: [task] });
  const run = { id: task.id, taskId: task.id, taskName: task.name, task: { ...task }, status: 'running', pid: process.pid, createdAt: new Date().toISOString(), dates: core.resolveDates(task) };
  core.atomicJson(path.join(core.paths(root).runs, run.id + '.json'), run);
  execute({ action: 'save-task', task: { ...task, value: '另一个示例' } }, root);
  const state = core.snapshot(root);
  assert.equal(state.running, 1); assert.equal(state.runs[0].task.value, task.value);
  assert.equal(state.tasks[0].value, '另一个示例');
});

test('an isolated worker records a missing-login failure without changing another running task', async t => {
  const root = temporary(t), other = example({ name: '另一个活动任务' });
  core.atomicJson(path.join(core.paths(root).runs, other.id + '.json'), { id: other.id, taskId: other.id, status: 'running', pid: process.pid, createdAt: new Date().toISOString() });
  const launched = launch(root, example(), 'manual');
  const deadline = Date.now() + 10000;
  let record;
  do {
    await new Promise(resolve => setTimeout(resolve, 50));
    record = core.readJson(path.join(core.paths(root).runs, launched.id + '.json'));
  } while (!['error', 'ok'].includes(record.status) && Date.now() < deadline);
  assert.equal(record.status, 'error');
  assert.match(record.error, /手动完成一次采集/);
  assert.equal(core.readJson(path.join(core.paths(root).runs, other.id + '.json')).status, 'running');
  assert.ok(!fs.existsSync(path.join(root, '.private', 'auth-state.json')));
});
