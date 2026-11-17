'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');
const { dispatch } = require('./dispatch.cjs');
const { register } = require('./platform.cjs');
const dataIndex = process.argv.indexOf('--data');
const dataRoot = dataIndex >= 0 ? path.resolve(process.argv[dataIndex + 1]) : require('../shared').DATA_ROOT;
function execute(request, root = dataRoot, registerSchedule = register, dispatchTasks = dispatch) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('自动化请求无效');
  const previous = core.readConfig(root);
  const config = { ...previous, tasks: [...previous.tasks] };
  function persist(force = false) {
    core.saveConfig(root, config);
    const changed = JSON.stringify(core.scheduleSlots(config.tasks)) !== JSON.stringify(core.scheduleSlots(previous.tasks));
    if (!force && (!config.enabled || !changed)) return;
    try { registerSchedule(root, config.enabled, config.tasks); }
    catch (error) {
      // A pause must remain effective even if the OS refuses to remove a trigger.
      if (!config.enabled) throw error;
      core.saveConfig(root, previous);
      try { registerSchedule(root, previous.enabled, previous.tasks); }
      catch {
        throw new Error('任务配置已恢复，但系统定时计划恢复失败，请暂停后重新启用定时运行。详细原因已写入 scheduler-error.log。');
      }
      throw error;
    }
  }
  switch (request.action) {
    case 'snapshot': return core.snapshot(root);
    case 'dashboard': return core.dashboard(root);
    case 'batch-preview': return core.batchPreview(request);
    case 'save-batch': {
      const batch = core.batchPreview(request);
      config.tasks.push(...batch.tasks);
      persist(); break;
    }
    // Product upgrades may rename the executable. Rebind the system launcher
    // without rewriting the user's task definitions or their enabled state.
    case 'sync-schedule': registerSchedule(root, config.enabled, config.tasks); break;
    case 'save-task': {
      const task = core.normalizeTask(request.task), index = config.tasks.findIndex(t => t.id === task.id);
      if (index < 0) config.tasks.push(task); else config.tasks[index] = task;
      persist(); break;
    }
    case 'set-enabled': {
      if (typeof request.enabled !== 'boolean' || !Array.isArray(request.ids) || !request.ids.length || request.ids.some(id => typeof id !== 'string') || new Set(request.ids).size !== request.ids.length || request.ids.some(id => !config.tasks.some(t => t.id === id))) throw new Error('请选择有效且不重复的任务并指定启停状态');
      config.tasks = config.tasks.map(task => request.ids.includes(task.id) ? { ...task, enabled: request.enabled } : task);
      persist(); break;
    }
    case 'delete-task': config.tasks = config.tasks.filter(t => t.id !== request.id); persist(); break;
    case 'schedule':
      config.enabled = request.enabled === true;
      persist(true);
      break;
    case 'run': {
      const launched = dispatchTasks(root, { ids: request.ids });
      if (!launched.length) throw new Error('没有可运行的任务，请先保存并启用任务');
      break;
    }
    case 'backfill': {
      if (!Array.isArray(request.ids) || !request.ids.length || request.scheduledDate === undefined) throw new Error('补采必须选择任务和原计划日期');
      // The dispatch module validates the entire request before launching workers.
      dispatchTasks(root, { ids: request.ids, scheduledDate: request.scheduledDate });
      break;
    }
    default: throw new Error('不支持的自动化操作');
  }
  return core.snapshot(root);
}
async function main() {
  if (process.argv[2] === 'tick') { dispatch(dataRoot, { scheduled: true }); return; }
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(await execute(JSON.parse(input))));
}
if (require.main === module) main().catch(error => {
  if (process.argv[2] === 'tick') {
    fs.mkdirSync(core.paths(dataRoot).logs, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(core.paths(dataRoot).logs, 'scheduler-error.log'), new Date().toISOString() + ' ' + error.message + '\n', { mode: 0o600 });
  }
  console.error(error.message); process.exitCode = 1;
});
module.exports = { execute };
