'use strict';
const { main } = require('../browser');
async function finish(code) {
  await Promise.all([
    new Promise(resolve => process.stdout.write('', resolve)),
    new Promise(resolve => process.stderr.write('', resolve))
  ]);
  process.exit(code);
}
main(process.argv.slice(2)).then(() => finish(0), error => {
  console.error(`浏览器版失败：${error.message}`);
  return finish(1);
});
