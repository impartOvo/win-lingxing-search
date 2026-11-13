'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PRIVATE = path.join(ROOT, '.private');
const RESULTS = path.join(ROOT, 'results');
const PAGE_URL = 'https://xfg.lingxing.com/erp/productExpressionNew';
const TYPES = new Set(['ASIN', '父ASIN', 'MSKU', 'SKU', 'SPU', 'FNSKU', '品名']);
const PERIODS = new Set(['前7天', '前30天', '近7天', '近30天']);
const MATCHES = new Set(['模糊', '精确']);
const TYPE_ALIAS = { asin: 'ASIN', parent_asin: '父ASIN', msku: 'MSKU', sku: 'SKU', spu: 'SPU', fnsku: 'FNSKU', name: '品名', local_name: '品名' };
const PERIOD_ALIAS = { prev7: '前7天', prev30: '前30天', recent7: '近7天', recent30: '近30天' };
const MATCH_ALIAS = { fuzzy: '模糊', exact: '精确' };
const COUNTRY_ALIAS = { DE: '德国', CA: '加拿大', UK: '英国', GB: '英国', FR: '法国', ES: '西班牙', IT: '意大利', NL: '荷兰', BE: '比利时', PL: '波兰', SE: '瑞典', IE: '爱尔兰', TR: '土耳其', MX: '墨西哥', BR: '巴西' };
const DATA_HOSTS = new Set(['xfg.lingxing.com', 'gw.lingxingerp.com']);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`无法识别参数：${key}`);
    if (key === '--help') { out.help = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${key} 缺少值`);
    out[key.slice(2)] = value;
  }
  return out;
}

function validate(options) {
  if (!options.value?.trim()) throw new Error('请提供 --value 商品标识或品名');
  options.value = options.value.trim();
  options.type ||= 'MSKU';
  options.type = TYPE_ALIAS[options.type.toLowerCase()] || options.type;
  if (!TYPES.has(options.type)) throw new Error(`--type 仅支持 ${[...TYPES].join('/')}`);
  options.match ||= '模糊';
  options.match = MATCH_ALIAS[options.match.toLowerCase()] || options.match;
  if (!MATCHES.has(options.match)) throw new Error('--match 仅支持 fuzzy/exact（模糊/精确）');
  if (options.country) options.country = COUNTRY_ALIAS[options.country.trim().toUpperCase()] || options.country.trim();
  if (options.shop) options.shop = options.shop.trim();
  for (const key of ['country', 'shop']) if (options[key] && options[key].length > 120) throw new Error(`--${key} 过长`);
  if (options.from || options.to) {
    if (!options.from || !options.to) throw new Error('自定义日期必须同时提供 --from 和 --to');
    for (const key of ['from', 'to']) {
      const value = options[key];
      const date = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new Error(`${key} 日期需为 YYYY-MM-DD`);
    }
    if (options.from > options.to) throw new Error('开始日期不能晚于结束日期');
    if (options.period) throw new Error('自定义日期与 --period 不能同时使用');
  } else {
    options.period ||= '前30天';
    options.period = PERIOD_ALIAS[options.period.toLowerCase()] || options.period;
    if (!PERIODS.has(options.period)) throw new Error(`--period 仅支持 ${[...PERIODS].join('/')}`);
  }
  if (options.value.length > 160) throw new Error('--value 过长');
  return options;
}

function mkdirs() {
  fs.mkdirSync(PRIVATE, { recursive: true });
  fs.mkdirSync(RESULTS, { recursive: true });
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function hash(data) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
}

function businessHash(data) {
  return hash(data && typeof data === 'object' && 'data' in data ? data.data : data);
}

function summary(data) {
  const fields = row => ({ fieldCount: Object.keys(row || {}).length, fields: Object.keys(row || {}).sort().slice(0, 15) });
  if (Array.isArray(data)) return { kind: 'array', count: data.length, ...fields(data[0]) };
  if (!data || typeof data !== 'object') return { kind: typeof data };
  const candidates = [data.data, data.rows, data.list, data.records, data.result];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return { kind: 'array', count: candidate.length, ...fields(candidate[0]) };
    if (candidate && typeof candidate === 'object') {
      for (const key of ['list', 'rows', 'records', 'data']) {
        if (Array.isArray(candidate[key])) return { kind: 'array', count: candidate[key].length, ...fields(candidate[key][0]) };
      }
    }
  }
  return { kind: 'object', keys: Object.keys(data).sort() };
}

function redactUrl(url) {
  const u = new URL(url);
  for (const key of u.searchParams.keys()) if (/token|secret|key|auth|sign|session/i.test(key)) u.searchParams.set(key, '[REDACTED]');
  return u.toString();
}

module.exports = { ROOT, PRIVATE, RESULTS, PAGE_URL, DATA_HOSTS, args, validate, mkdirs, saveJson, hash, businessHash, summary, redactUrl };
