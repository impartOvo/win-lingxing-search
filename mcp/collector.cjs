'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const shared = require('../shared');
const { resolveDates, atomicJson } = require('../automation/core.cjs');
const settings = require('./settings.cjs');
const { LingxingClient } = require('./client.cjs');

function scope(options, choices) {
  if (!Array.isArray(choices.markets) || !Array.isArray(choices.sellers)) throw new Error('MCP 国家店铺选项缺失。');
  const country = options.country ? choices.markets.find(m => m.country === options.country || m.code === options.country) : null;
  if (options.country && !country) throw new Error('当前 MCP 账号没有匹配的国家选项。');
  let sellers = choices.sellers.filter(s => !country || String(s.country_id) === String(country.country_id));
  if (options.shop) {
    const exact = sellers.filter(s => s.seller_simple_name === options.shop);
    const matched = exact.length ? exact : sellers.filter(s => String(s.seller_simple_name).toLowerCase().includes(options.shop.toLowerCase()));
    if (matched.length !== 1) throw new Error('MCP 店铺匹配不唯一或未找到，请填写完整店铺名并核对国家。');
    sellers = matched;
  }
  if (!sellers.length) throw new Error('当前 MCP 账号没有该范围内可用的店铺。');
  const currencies = [...new Set(sellers.map(s => s.currency_code).filter(Boolean))];
  const currency = options.currency || (currencies.length === 1 ? currencies[0] : null);
  if (!currency) throw new Error('当前范围包含多种币种，请选择国家、唯一店铺或明确指定统计币种。');
  return { mids: country ? String(country.country_id) : '', sids: sellers.map(s => String(s.sid)).join(','), currency_code: currency };
}
async function paginate(client, id, params, pageSize, listing = false) {
  let offset = 0, first, total, pages = 0;
  const rows = [], seenPages = new Set();
  for (;;) {
    const body = await client.call(id, { ...params, offset, length: pageSize });
    const data = body.data;
    if (!data || !Array.isArray(data.list)) throw new Error('MCP 返回缺少列表，未将异常响应作为成功结果。');
    const count = Number(data.total);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('MCP 返回的分页总数无效。');
    if (!first) { first = body; total = count; }
    else if (total !== count) throw new Error('MCP 分页期间总数发生变化，请重新采集。');
    const identity = JSON.stringify(data.list.map(r => [r.id, r.sid, r.store_id, r.parent_asin, r.asin, r.msku, r.sku, r.local_sku]));
    if (data.list.length && seenPages.has(identity)) throw new Error('MCP 返回重复分页，已停止以避免重复累计。');
    seenPages.add(identity); rows.push(...data.list); pages++;
    if (rows.length >= total) break;
    if (!data.list.length) throw new Error('MCP 分页提前结束，实际数据未收齐。');
    offset += data.list.length;
  }
  if (rows.length !== total) throw new Error('MCP 列表数量与分页总数不一致。');
  return { body: { ...first, data: { ...first.data, list: rows } }, total, pages, rows, listing };
}
async function productQuery(client, options, selectedScope) {
  const fields = { ASIN: 'asin', 父ASIN: 'parent_asin', MSKU: 'msku', SKU: 'local_sku', SPU: 'spu' };
  const dimensions = { ASIN: 'asin', 父ASIN: 'parent_asin', MSKU: 'msku', SKU: 'sku', SPU: 'spu' };
  if (!options.value) {
    const tab = options.type === '品名' ? '父ASIN' : options.type === 'FNSKU' ? 'MSKU' : options.type;
    return { search_value: [], summary_field: dimensions[tab], tab, resolved: null };
  }
  if (!['品名', 'FNSKU'].includes(options.type)) {
    return { search_field: fields[options.type], search_value: [options.value], summary_field: dimensions[options.type], tab: options.type, resolved: null };
  }
  const listings = await paginate(client, 'erp_listing', {
    mids: selectedScope.mids, sids: selectedScope.sids, pvi_ids: '',
    search_field: options.type === 'FNSKU' ? 'fnsku' : 'local_name', search_value: [options.value],
    exact_search: options.type === 'FNSKU' || options.match === '精确' ? '1' : '0'
  }, 200, true);
  const matching = listings.rows.filter(row => {
    const text = String(options.type === 'FNSKU' ? row.fnsku || '' : row.local_name || row.spu_name || '').toLowerCase();
    const value = options.value.toLowerCase();
    return options.type === 'FNSKU' || options.match === '精确' ? text === value : text.includes(value);
  });
  const key = options.type === 'FNSKU' ? 'msku' : 'parent_asin';
  const ids = [...new Set(matching.map(row => row[key]).filter(Boolean))];
  if (!ids.length) throw new Error('MCP Listing 未解析到匹配商品，请核对品名、标识和店铺范围。');
  if (options.type === 'FNSKU' && ids.length !== 1) throw new Error('该 FNSKU 对应多个 MSKU，请缩小店铺范围。');
  return { search_field: key, search_value: ids, summary_field: key, tab: options.type === 'FNSKU' ? 'MSKU' : '父ASIN',
    resolved: { via: 'erp_listing', field: key, identifiers: ids, matchedListings: matching.length } };
}
function dateRange(options) {
  if (options.from) return { from: options.from, to: options.to };
  const map = { '前7天': 'prev7', '前30天': 'prev30', '近7天': 'recent7', '近30天': 'recent30' };
  return resolveDates({ period: map[options.period] });
}
async function capture(input, overrides = {}) {
  const options = shared.validate({ ...input, source: 'mcp' });
  if (options['save-template'] || options.diagnostics) throw new Error('MCP 通道不保存浏览器请求模板或网络抓包，请关闭这两个选项。');
  const root = overrides.root || shared.DATA_ROOT;
  const config = overrides.config || settings.read(root);
  const client = overrides.client || new LingxingClient(config);
  const start = Date.now();
  try {
    console.log('正在连接领星 MCP…');
    await client.connect();
    const selectedScope = scope(options, await client.call('customer_review_country_sellers', {}));
    console.log('阶段：筛选与采集');
    const query = await productQuery(client, options, selectedScope), dates = dateRange(options);
    const collected = await paginate(client, 'query_product_performance_asin_lists', {
      start_date: dates.from, end_date: dates.to, date_type: 'purchase', date_range_type: 0,
      ...selectedScope, summary_field: query.summary_field,
      ...(query.search_field ? { search_field: query.search_field } : {}), search_value: query.search_value
    }, 500);
    if (!collected.total) throw new Error('MCP 产品表现没有匹配记录；请核对商品、日期和范围，未将空响应解释为零销量。');
    if (query.resolved && collected.rows.some(row => !query.search_value.includes(row[query.search_field]))) {
      throw new Error('MCP 返回了超出 Listing 解析范围的商品，已停止保存，请核对工具筛选口径。');
    }
    if (collected.rows.some(row => row.currency_code && row.currency_code !== selectedScope.currency_code)) {
      throw new Error('MCP 返回币种与指定统计币种不一致，已停止保存。');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID();
    const directory = path.join(root, 'results'), result = path.join(directory, 'mcp-' + stamp + '.json');
    const record = { method: 'mcp', source: 'lingxing-mcp', input: { ...options, currency: selectedScope.currency_code },
      query: { type: options.type, value: options.value, tab: query.tab }, resolved: query.resolved,
      ...(process.env.LINGXING_AUTOMATION_RUN_ID ? { automation: { taskId: process.env.LINGXING_AUTOMATION_TASK_ID, runId: process.env.LINGXING_AUTOMATION_RUN_ID } } : {}),
      appliedFilters: { country: options.country || null, shop: options.shop || null, match: options.match, currency: selectedScope.currency_code },
      requestFilters: { mids: selectedScope.mids, sids: selectedScope.sids, search_field: query.search_field },
      dates: [dates.from, dates.to], pagination: { total: collected.total, collected: collected.total, pageSize: 500, pages: collected.pages },
      fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - start,
      responseSummary: shared.summary(collected.body), responseHash: shared.businessHash(collected.body), status: 'ok' };
    console.log('阶段：保存结果');
    // Publish the success record only after its complete data file is available.
    atomicJson(path.join(directory, 'mcp-data-' + stamp + '.json'), collected.body);
    atomicJson(result, record);
    console.log('MCP 采集完成：' + collected.total + ' 条，币种 ' + selectedScope.currency_code);
    console.log('结果：' + result);
    return result;
  } catch (error) { throw new Error(settings.safeError(error, config)); }
  finally { await client.close(); }
}
module.exports = { capture, scope, paginate, productQuery, dateRange };
