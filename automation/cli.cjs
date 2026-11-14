'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');
const { dispatch } = require('./dispatch.cjs');
const { register } = require('./platform.cjs');
const dataIndex = process.argv.indexOf('--data');
const dataRoot = dataIndex >= 0 ? path.resolve(process.argv[dataIndex + 1]) : require('../shared').DATA_ROOT;
function execute(request, root = dataRoot) {
  const config = core.readConfig(root);
  switch (request.action) {
    case 'snapshot': return core.snapshot(root);
    case 'save-task': {
      const task = core.normalizeTask(request.task), index = config.tasks.findIndex(t => t.id === task.id);
      if (index < 0) config.tasks.push(task); else config.tasks[index] = task;
      core.saveConfig(root, config); break;
    }
    case 'delete-task': config.tasks = config.tasks.filter(t => t.id !== request.id); core.saveConfig(root, config); break;
    case 'schedule':
      if (request.enabled) { register(root, true); config.enabled = true; core.saveConfig(root, config); }
      else { config.enabled = false; core.saveConfig(root, config); register(root, false); }
      break;
    case 'run': {
      const launched = dispatch(root, { ids: request.ids });
      if (!launched.length) throw new Error('没有可运行的任务，请先保存并启用任务');
      break;
    }
    default: throw new Error('不支持的自动化操作');
  }
  return core.snapshot(root);
}
async function main() {
  if (process.argv[2] === 'tick') { dispatch(dataRoot, { scheduled: true }); return; }
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(JSON.stringify(execute(JSON.parse(input))));
}
if (require.main === module) main().catch(error => {
  if (process.argv[2] === 'tick') {
    fs.mkdirSync(core.paths(dataRoot).logs, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(core.paths(dataRoot).logs, 'scheduler-error.log'), new Date().toISOString() + ' ' + error.message + '\n', { mode: 0o600 });
  }
  console.error(error.message); process.exitCode = 1;
});
module.exports = { execute };
