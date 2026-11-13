'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { collectionArgs, summaryPath, readBundle, history } = require('../mac/reports.cjs');
const root = path.join(__dirname, '..');
function cleanupTemp(directory) {
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('lingxing-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('preserves Unicode and validates collection dates before spawning', () => {
  const args = collectionArgs({ type: 'parent_asin', value: 'B0ASIN0001', country: '加拿大', shop: '示例 店铺', match: 'exact', from: '2025-01-01', to: '2025-01-30' });
  assert.equal(args[args.indexOf('--shop') + 1], '示例 店铺');
  assert.equal(args[args.indexOf('--type') + 1], '父ASIN');
  assert.throws(() => collectionArgs({ value: 'demo', from: '2025-02-31', to: '2025-03-01' }), /日期/);
  assert.throws(() => collectionArgs({ value: '' }), /商品标识/);
});
test('uses a writable data directory independently of bundled application files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxing-data-'));
  try {
    const child = spawnSync(process.execPath, ['-e', "const s=require('./shared');s.mkdirs();process.stdout.write(JSON.stringify({private:s.PRIVATE,results:s.RESULTS}));"], { cwd: root, env: { ...process.env, LINGXING_DATA_DIR: directory }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const values = JSON.parse(child.stdout);
    assert.equal(values.results, path.join(directory, 'results'));
    assert.equal(values.private, path.join(directory, '.private'));
    assert.ok(fs.statSync(values.results).isDirectory());
  } finally { cleanupTemp(directory); }
});
test('loads paired synthetic files and preserves null values and refund distinction', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxing-reports-'));
  try {
    for (const name of ['browser-demo.json', 'browser-data-demo.json']) fs.copyFileSync(path.join(root, 'examples', name), path.join(directory, name));
    const bundle = readBundle(directory, 'browser-demo.json');
    assert.equal(bundle.rows.length, 1);
    assert.equal(bundle.rows[0].sku, null);
    assert.equal(bundle.rows[0].return_goods_count, 1);
    assert.equal(bundle.rows[0].return_count, 2);
    assert.equal(bundle.rows[0].price_list.length, 2);
    assert.equal(history(directory).length, 1);
    fs.unlinkSync(path.join(directory, 'browser-data-demo.json'));
    assert.deepEqual(history(directory), []);
  } finally { cleanupTemp(directory); }
});
test('restricts history file names to the application result directory', () => {
  assert.throws(() => summaryPath('/data/results', '../browser-demo.json'));
  assert.throws(() => summaryPath('/data/results', 'browser-data-demo.json'));
  assert.throws(() => summaryPath('/data/results', '/other/browser-demo.json'));
  assert.throws(() => summaryPath('/data/results', 'browser-../private.json'));
});
