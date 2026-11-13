'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { args, validate, COUNTRIES } = require('../shared');

function collectionLaunch(argv) {
  const start = argv.indexOf('--collect-once');
  if (start < 0) return null;
  const input = args(argv.slice(start + 1));
  const report = input['test-report'];
  delete input['test-report'];
  return { input: validate(input), report };
}

function collectionArgs(input) {
  const options = validate({ ...input });
  const out = [];
  for (const key of ['type', 'value', 'match', 'country', 'shop', 'from', 'to', 'period']) {
    if (options[key]) out.push(`--${key}`, String(options[key]));
  }
  for (const key of ['save-template', 'diagnostics']) if (options[key]) out.push(`--${key}`);
  return out;
}
function summaryPath(directory, name) {
  if (typeof name !== 'string' || !/^browser-[\w.-]+\.json$/.test(name) || name.startsWith('browser-data-')) {
    throw new Error('无效的采集记录文件名');
  }
  return path.join(directory, name);
}
function readBundle(directory, name) {
  const file = summaryPath(directory, name);
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (summary.method !== 'browser' || summary.status !== 'ok') throw new Error('这次采集尚未确认成功');
  const dataName = `browser-data-${name.slice(8)}`;
  const payload = JSON.parse(fs.readFileSync(path.join(directory, dataName), 'utf8'));
  if (!Array.isArray(payload.data?.list)) throw new Error('结果文件缺少商品列表');
  return { name, dataName, summary, rows: payload.data.list };
}
function history(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => /^browser-[\w.-]+\.json$/.test(name) && !name.startsWith('browser-data-'))
    .sort().reverse().flatMap(name => {
      try {
        const { summary, rows } = readBundle(directory, name);
        return [{ name, input: summary.input, dates: summary.dates, fetchedAt: summary.fetchedAt, count: rows.length }];
      } catch { return []; }
    });
}
module.exports = { COUNTRIES, collectionLaunch, collectionArgs, summaryPath, readBundle, history };
