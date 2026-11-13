'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { args, validate, replayHeaders, captureSummary, COUNTRIES } = require('../shared');
const { collectionLaunch, collectionArgs } = require('../mac/reports.cjs');
const root = path.join(__dirname, '..');

test('normal collection defaults to no replay template or network diagnostics; explicit opt-in is preserved', () => {
  const normal = validate(args(['--value', 'demo']));
  assert.equal(normal['save-template'], false);
  assert.equal(normal.diagnostics, false);
  const opted = validate(args(['--value', 'demo', '--save-template', '--diagnostics', 'true']));
  assert.equal(opted['save-template'], true);
  assert.equal(opted.diagnostics, true);
  assert.equal(validate(args(['--value', 'demo', '--save-template', 'false']))['save-template'], false);
  assert.throws(() => validate({ value: 'demo', diagnostics: 'maybe' }));
  assert.ok(!collectionArgs({ value: 'demo' }).includes('--save-template'));
});

test('private replay retains necessary identity headers but excludes cookies and unrelated browser metadata', () => {
  const headers = replayHeaders({ 'auth-token': 'example', 'Content-Type': 'application/json', 'x-ak-uid': 'demo', Cookie: 'cookie-example', 'sec-ch-ua': 'browser', 'x-unrelated': 'example' });
  assert.deepEqual(headers, { 'auth-token': 'example', 'Content-Type': 'application/json', 'x-ak-uid': 'demo' });
});

test('diagnostic summary excludes request headers, body, URL query and original response values', () => {
  const summary = captureSummary({ request: { url: 'https://xfg.lingxing.com/report?auth=example', method: 'POST', headers: { 'auth-token': 'example' }, postData: 'private query' }, response: { status: 200, body: { data: { list: [{ volume: 12, item_name: 'private product' }] } } }, capturedAt: 'example' });
  assert.equal(summary.url, 'https://xfg.lingxing.com/report');
  assert.equal(summary.summary.count, 1);
  assert.ok(!/private product|private query|auth-token|\?auth/.test(JSON.stringify(summary)));
  assert.equal(summary.request, undefined);
  assert.equal(summary.response, undefined);
});

test('mac collection regression entry validates actual query options and preserves Unicode', () => {
  const launch = collectionLaunch(['app', '--collect-once', '--value', '示例品名', '--type', 'name', '--country', 'CA', '--shop', '示例 店铺', '--period', 'prev30', '--test-report', '/tmp/report.json']);
  assert.equal(launch.input.country, '加拿大');
  assert.equal(launch.input.type, '品名');
  assert.equal(launch.input.shop, '示例 店铺');
  assert.equal(launch.report, '/tmp/report.json');
  assert.throws(() => collectionLaunch(['--collect-once', '--value', 'demo', '--from', '2025-02-31', '--to', '2025-03-01']));
  assert.equal(collectionLaunch(['app']), null);
  assert.equal(COUNTRIES.length, 22);
  assert.equal(new Set(COUNTRIES).size, COUNTRIES.length);
});

test('release rejects mismatched tags and reports the package version', () => {
  const script = path.join(root, 'scripts/release-version.cjs');
  const good = spawnSync(process.execPath, [script], { env: { ...process.env, GITHUB_REF: `refs/tags/v${require('../package.json').version}` }, encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), require('../package.json').version);
  const bad = spawnSync(process.execPath, [script], { env: { ...process.env, GITHUB_REF: 'refs/tags/v0.0.0' }, encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
