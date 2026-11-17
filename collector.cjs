'use strict';
const { args, validate } = require('./shared');
async function capture(input) {
  const options = validate({ ...input });
  if (options.source === 'mcp') return require('./mcp/collector.cjs').capture(options);
  delete options.currency; // MCP currency selection must not imply a browser-side conversion.
  return require('./browser').capture(options);
}
async function main(argv = process.argv.slice(2)) {
  const input = args(argv);
  if (input.help) {
    console.log('用法：node collector.cjs --source browser|mcp --type asin|parent_asin|msku|sku|fnsku|spu|name --value 商品标识或品名 [--match fuzzy|exact] [--country 德国] [--shop 店铺名] [--currency EUR] [--period prev30 | --from YYYY-MM-DD --to YYYY-MM-DD] [--save-template] [--diagnostics]');
    return;
  }
  await capture(input);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { capture, main };
