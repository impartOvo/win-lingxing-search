'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PRIVATE, RESULTS, DATA_HOSTS, args, mkdirs, saveJson, businessHash, summary, redactUrl } = require('./shared');

function replaceExact(text, before, after) {
  if (!before || before === after) return text;
  return text.split(before).join(after);
}

async function crawl(options) {
  mkdirs();
  const templatePath = path.join(PRIVATE, 'request-template.json');
  if (!fs.existsSync(templatePath)) throw new Error('缺少查询模板；请先运行 browser.js 捕获一次产品表现查询');
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  let url = template.request.url;
  let body = template.request.postData;
  const oldValue = template.input.value;
  const newValue = options.value || oldValue;
  url = replaceExact(url, oldValue, newValue);
  body = replaceExact(body, oldValue, newValue);
  if (newValue !== oldValue && url === template.request.url && body === template.request.postData) {
    throw new Error('模板请求没有商品标识，无法安全替换；请用浏览器版重新捕获目标商品');
  }
  const from = options.from || template.dates?.[0];
  const to = options.to || template.dates?.[1];
  if (options.from || options.to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('日期格式需为 YYYY-MM-DD');
    url = replaceExact(replaceExact(url, template.dates?.[0], from), template.dates?.[1], to);
    body = replaceExact(replaceExact(body, template.dates?.[0], from), template.dates?.[1], to);
  }
  const target = new URL(url);
  if (target.protocol !== 'https:' || !DATA_HOSTS.has(target.hostname)) throw new Error('模板目标不是领星 ERP');
  const headers = { ...template.request.headers };
  for (const key of Object.keys(headers)) if (/^(host|content-length|connection|accept-encoding)$/i.test(key)) delete headers[key];
  const start = performance.now();
  const response = await fetch(url, { method: template.request.method, headers, body: ['GET','HEAD'].includes(template.request.method) ? undefined : body, redirect: 'manual' });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`返回内容不是 JSON（HTTP ${response.status}），可能登录已过期`); }
  const elapsedMs = Math.round(performance.now() - start);
  const result = {
    method: 'crawler', input: { value: newValue, from, to }, source: redactUrl(url),
    fetchedAt: new Date().toISOString(), elapsedMs, httpStatus: response.status,
    responseSummary: summary(data), responseHash: businessHash(data),
    baseline: newValue === oldValue && from === template.dates?.[0] && to === template.dates?.[1] ? template.baseline : null
  };
  if (!response.ok) throw new Error(`领星返回 HTTP ${response.status}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(RESULTS, `crawler-${stamp}.json`);
  saveJson(output, result);
  saveJson(path.join(RESULTS, `crawler-data-${stamp}.json`), data);
  console.log(JSON.stringify({ ...result, responseHash: '[已写入结果文件]', baseline: result.baseline ? {
    summary: result.baseline.summary,
    sameShape: JSON.stringify(result.baseline.summary) === JSON.stringify(result.responseSummary),
    sameHash: result.baseline.hash === result.responseHash,
    browserElapsedMs: result.baseline.browserElapsedMs,
    crawlerElapsedMs: elapsedMs
  } : null }, null, 2));
  console.log(`结果：${output}`);
}

const options = args(process.argv.slice(2));
if (options.help) {
  console.log('用法：node crawler.js [--value 商品标识] [--from YYYY-MM-DD --to YYYY-MM-DD]');
} else {
  crawl(options).catch(error => { console.error(`直连爬虫失败：${error.message}`); process.exitCode = 1; });
}
