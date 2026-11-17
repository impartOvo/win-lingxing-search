'use strict';
const path = require('node:path');
const modules = { automation: './automation/cli.cjs', monitoring: './monitoring/cli.cjs', data: './data/cli.cjs', mcp: './mcp/cli.cjs' };
async function execute(packet, root, implementations = {}) {
  if (!packet || !Object.hasOwn(modules, packet.module) || !packet.request || typeof packet.request !== 'object') throw new Error('无效的工作台操作。');
  const operation = implementations[packet.module] || require(modules[packet.module]).execute;
  if (packet.module === 'monitoring' && packet.request.action === 'save') {
    const schedule = implementations.automation || require(modules.automation).execute;
    return await operation({ ...packet.request, action: 'save-scheduled' }, root,
      { registerSchedule: () => schedule({ action: 'sync-schedule' }, root) });
  }
  return await operation(packet.request, root);
}
if (require.main === module) (async () => {
  console.log = (...args) => console.error(...args);
  const index = process.argv.indexOf('--data');
  const root = index >= 0 ? path.resolve(process.argv[index + 1]) : require('./shared').DATA_ROOT;
  let input = ''; for await (const part of process.stdin) input += part;
  process.stdout.write(JSON.stringify(await execute(JSON.parse(input), root)));
})().catch(error => { console.error(error instanceof SyntaxError ? '工作台请求格式无效。' : require('./mcp/settings.cjs').safeError(error)); process.exitCode = 1; });
module.exports = { execute };
