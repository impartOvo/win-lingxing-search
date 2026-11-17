'use strict';
const path = require('node:path');
const core = require('./core.cjs');
async function execute(request, root, options = {}) {
  core.paths(root);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('监控请求无效。');
  switch (request.action) {
    case 'snapshot': return core.snapshot(root, options.now);
    case 'save': if (!request.config) throw new Error('缺少监控配置。'); return core.save(root, request.config);
    case 'save-scheduled': if (!request.config) throw new Error('缺少监控配置。'); return core.saveScheduled(root, request.config, options.registerSchedule);
    case 'tick': if (request.force !== undefined && typeof request.force !== 'boolean') throw new Error('立即检查参数无效。'); return core.tick(root, { ...options, force: request.force === true });
    case 'mark-read': case 'snooze': case 'ack-notifications': return core.mutate(root, request.action, request, options);
    default: throw new Error('不支持的监控操作。');
  }
}
if (require.main === module) (async () => {
  // The existing MCP client logs retry progress with console.log. RPC stdout must remain exactly one JSON value.
  console.log = (...values) => console.error(...values);
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024 * 1024) throw new Error('监控请求过大。'); }
  const index = process.argv.indexOf('--data');
  if (index < 0 || !process.argv[index + 1]) throw new Error('请通过 --data 指定监控数据目录。');
  const root = path.resolve(process.argv[index + 1]);
  let request; try { request = JSON.parse(input.replace(/^\uFEFF/, '')); } catch { throw new Error('监控请求 JSON 无效。'); }
  process.stdout.write(JSON.stringify(await execute(request, root)));
})().catch(() => { process.stderr.write('监控操作失败，请核对配置、登录态与连接；可在监控页查看检查错误。\n'); process.exitCode = 1; });
module.exports = { execute };
