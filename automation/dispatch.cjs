'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const core = require('./core.cjs');
function runtimeEnv(dataRoot) { return { ...process.env, LINGXING_DATA_DIR: dataRoot, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }; }
function launch(dataRoot, task, trigger, now = new Date(), occurrence = {}) {
  const p = core.paths(dataRoot), id = crypto.randomUUID();
  const run = { id, taskId: task.id, taskName: task.name, task, trigger, dates: occurrence.dates || core.resolveDates(task, now),
    createdAt: now.toISOString(), status: 'starting', pid: null, resultName: null, error: null };
  if (trigger === 'schedule' || trigger === 'backfill') {
    run.scheduledDate = occurrence.scheduledDate || core.localDate(now);
    run.scheduledTime = task.time;
  }
  const file = path.join(p.runs, id + '.json');
  core.atomicJson(file, run);
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(p.logs, id + '.log'), 'a', 0o600);
  try {
    const worker = path.join(__dirname, 'worker.cjs');
    if (!fs.existsSync(worker)) throw new Error('采集入口 worker.cjs 缺失，请修复程序文件并检查系统拦截记录。');
    const child = spawn(process.execPath, [worker, id], {
      cwd: path.join(__dirname, '..'), env: runtimeEnv(dataRoot), detached: true, windowsHide: true, stdio: ['ignore', log, log]
    });
    if (!child.pid) { child.on('error', () => {}); throw new Error('无法启动采集进程'); }
    run.pid = child.pid;
    core.atomicJson(file, run);
    child.on('error', error => core.atomicJson(file, { ...run, status: 'error', error: error.message, finishedAt: new Date().toISOString() }));
    child.unref();
  } catch (error) { run.status = 'error'; run.error = error.message; run.finishedAt = new Date().toISOString(); core.atomicJson(file, run); }
  finally { fs.closeSync(log); }
  return run;
}
function dispatch(dataRoot, { ids, scheduled = false, scheduledDate, now = new Date(), launchTask = launch } = {}) {
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) || new Set(ids).size !== ids.length)) throw new Error('请选择有效且不重复的任务标识');
  if (scheduledDate !== undefined && (scheduled || ids === undefined)) throw new Error('补采必须选择任务和原计划日期');
  const originalDate = scheduledDate !== undefined ? core.civilDate(scheduledDate) : null;
  if (originalDate && scheduledDate > core.localDate(now)) throw new Error('补采日期不能晚于今天');
  const config = core.readConfig(dataRoot);
  if (scheduled && !config.enabled) return [];
  const tasks = ids ? config.tasks.filter(t => ids.includes(t.id)) : config.tasks.filter(t => t.enabled);
  if (ids && tasks.length !== new Set(ids).size) throw new Error('部分任务不存在，请刷新列表');
  if (originalDate && tasks.some(task => !task.days.includes(originalDate.getDay()))) throw new Error('所选任务在该日期没有计划，请选择原计划日期');
  // Freeze and validate all relative periods before dispatching any worker.
  const occurrences = originalDate ? tasks.map(task => ({ scheduledDate, dates: core.resolveDates(task, originalDate) })) : [];
  return tasks.filter(t => !scheduled || (core.due(t, now) && core.claimSlot(dataRoot, t, now)))
    .map(task => launchTask(dataRoot, task, originalDate ? 'backfill' : scheduled ? 'schedule' : 'manual', now, originalDate ? occurrences[tasks.indexOf(task)] : undefined));
}
module.exports = { runtimeEnv, launch, dispatch };
