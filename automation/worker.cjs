'use strict';
const path = require('node:path');
const core = require('./core.cjs');
const { DATA_ROOT } = require('../shared');
async function main() {
  const id = process.argv[2];
  if (!/^[a-f0-9-]{36}$/i.test(id || '')) throw new Error('无效的运行标识');
  const file = path.join(core.paths(DATA_ROOT).runs, id + '.json');
  let run = core.readJson(file);
  if (!run) throw new Error('找不到任务运行记录');
  // The dispatcher writes the PID before the worker updates the same record.
  const deadline = Date.now() + 5000;
  while (!run.pid && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10)); run = core.readJson(file);
  }
  if (!run.pid) throw new Error('任务启动信息未保存，请重试');
  run.status = 'running'; run.pid = process.pid; run.startedAt = new Date().toISOString(); core.atomicJson(file, run);
  process.env.LINGXING_ISOLATED_CAPTURE = '1';
  process.env.LINGXING_LOGIN_TIMEOUT_MS = '30000';
  process.env.LINGXING_AUTOMATION_TASK_ID = run.taskId;
  process.env.LINGXING_AUTOMATION_RUN_ID = run.id;
  try {
    const { capture } = require('../browser');
    const { validate } = require('../shared');
    const input = Object.fromEntries(['type', 'value', 'match', 'country', 'shop'].map(k => [k, run.task[k]]));
    const result = await capture(validate({ ...input, ...run.dates }));
    run.status = 'ok'; run.resultName = path.basename(result);
  } catch (error) {
    run.status = 'error'; run.error = error.message; console.error(error.message); process.exitCode = 1;
  } finally { run.finishedAt = new Date().toISOString(); core.atomicJson(file, run); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
