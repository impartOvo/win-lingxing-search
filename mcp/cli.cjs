'use strict';
const { DATA_ROOT } = require('../shared');
const settings = require('./settings.cjs');
async function execute(request, root = DATA_ROOT) {
  switch (request.action) {
    case 'status': return settings.status(root);
    case 'save': return settings.save(root, request);
    case 'import-codex': return settings.importCodex(root);
    case 'test': {
      const config = settings.read(root);
      const { LingxingClient } = require('./client.cjs');
      const client = new LingxingClient(config);
      try {
        await client.connect();
        const options = await client.call('customer_review_country_sellers', {});
        await client.schema('query_product_performance_asin_lists');
        return { ...settings.status(root), connected: true, protocol: client.mode, countries: options.markets?.length || 0, shops: options.sellers?.length || 0 };
      } finally { await client.close(); }
    }
    default: throw new Error('不支持的 MCP 连接操作。');
  }
}
let currentRequest = {};
if (require.main === module) (async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const index = process.argv.indexOf('--data');
  const root = index >= 0 ? require('node:path').resolve(process.argv[index + 1]) : DATA_ROOT;
  currentRequest = JSON.parse(input);
  process.stdout.write(JSON.stringify(await execute(currentRequest, root)));
})().catch(error => {
  console.error(error instanceof SyntaxError || error instanceof TypeError ? 'MCP 连接参数或配置无效，请核对地址、密钥和网络。' : settings.safeError(error, currentRequest));
  process.exitCode = 1;
});
module.exports = { execute };
