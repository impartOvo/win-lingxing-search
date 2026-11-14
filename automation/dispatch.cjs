'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const core = require('./core.cjs');
function runtimeEnv(dataRoot) { return { ...process.env, LINGXING_DATA_DIR: dataRoot, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }; }
function launch(dataRoot, task, trigger, now = new Date()) {
  const p = core.paths(dataRoot), id = crypto.randomUUID();
  const run = { id, taskId: task.id, taskName: task.name, task, trigger, dates: core.resolveDates(task, now),
    createdAt: now.toISOString(), status: 'starting', pid: null, resultName: null, error: null };
  const file = path.join(p.runs, id + '.json');
  core.atomicJson(file, run);
  fs.mkdirSync(p.logs, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(p.logs, id + '.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.cjs'), id], {
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
function dispatch(dataRoot, { ids, scheduled = false, now = new Date(), launchTask = launch } = {}) {
  const config = core.readConfig(dataRoot);
  if (scheduled && !config.enabled) return [];
  const tasks = ids ? config.tasks.filter(t => ids.includes(t.id)) : config.tasks.filter(t => t.enabled);
  if (ids && tasks.length !== new Set(ids).size) throw new Error('部分任务不存在，请刷新列表');
  return tasks.filter(t => !scheduled || (core.due(t, now) && core.claimSlot(dataRoot, t, now)))
    .map(task => launchTask(dataRoot, task, scheduled ? 'schedule' : 'manual', now));
}
module.exports = { runtimeEnv, launch, dispatch };
