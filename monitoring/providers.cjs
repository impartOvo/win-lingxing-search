'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAIL_URL = 'https://xfg.lingxing.com/erp/EmailService';
const DASHBOARD_PATH = /^(?:\/pb-aftersale-mailforgateway)?\/api\/webmail\/after_sales\/mailDashboard$/;
const HOSTS = new Set(['xfg.lingxing.com', 'gw.lingxingerp.com']);
const FIELDS = { ASIN: 'asin', 父ASIN: 'parent_asin', MSKU: 'seller_sku', SKU: 'sku', SPU: 'spu', FNSKU: 'fnsku', 品名: 'product_name' };
function normalizeInventory(rows, authorizedSids) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('库存查询没有可确认的记录。');
  const result = new Map();
  for (const row of rows) {
    if (!row || !authorizedSids.has(String(row.sid)) || !['string', 'number'].includes(typeof row.sid) ||
        typeof row.seller_sku !== 'string' || !row.seller_sku || typeof row.fnsku !== 'string' || !row.fnsku ||
        !Number.isSafeInteger(row.afn_fulfillable_quantity) || row.afn_fulfillable_quantity < 0) throw new Error('FBA 可售数量或店铺商品身份缺失，库存未知。');
    const identity = crypto.createHash('sha256').update(JSON.stringify([String(row.sid), row.seller_sku, row.fnsku])).digest('hex');
    const value = { identity, sid: String(row.sid), seller_sku: row.seller_sku, fnsku: row.fnsku,
      quantity: row.afn_fulfillable_quantity, unique_id: row.unique_id ?? null, group_by_sid: row.group_by_sid ?? null, share_type: row.share_type ?? null };
    const previous = result.get(identity);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('相同 FBA 商品返回冲突数量或共享池信息，库存未知。');
    result.set(identity, value);
  }
  // Each sid/MSKU/FNSKU is checked independently. Pool metadata is opaque: never add shared warehouses or countries.
  return [...result.values()];
}
async function inventory(root, rule, overrides = {}) {
  const settings = require('../mcp/settings.cjs');
  const client = overrides.client || new (require('../mcp/client.cjs').LingxingClient)(settings.read(root));
  try {
    await client.connect();
    const choices = await client.call('customer_review_country_sellers', {});
    if (!Array.isArray(choices.markets) || !Array.isArray(choices.sellers)) throw new Error('库存国家店铺选项缺失。');
    const market = rule.country ? choices.markets.find(item => item.country === rule.country || item.code === rule.country) : null;
    if (rule.country && !market) throw new Error('库存国家无法确认。');
    let sellers = choices.sellers.filter(seller => !market || String(seller.country_id) === String(market.country_id));
    if (rule.shop) {
      const exact = sellers.filter(seller => seller.seller_simple_name === rule.shop);
      sellers = exact.length ? exact : sellers.filter(seller => typeof seller.seller_simple_name === 'string' && seller.seller_simple_name.toLowerCase().includes(rule.shop.toLowerCase()));
      if (sellers.length !== 1) throw new Error('库存店铺匹配不唯一。');
    }
    if (!sellers.length) throw new Error('没有授权库存店铺。');
    const sids = [];
    for (const seller of sellers) {
      const country = choices.markets.find(item => String(item.country_id) === String(seller.country_id));
      if (!country || !seller.sid || !seller.currency_code) throw new Error('库存店铺国家映射不完整。');
      const selected = require('../mcp/collector.cjs').scope({ country: country.country || country.code, shop: seller.seller_simple_name }, choices);
      if (selected.sids !== String(seller.sid)) throw new Error('库存店铺映射不唯一。');
      if (!sids.includes(String(seller.sid))) sids.push(String(seller.sid));
    }
    const rows = [];
    for (const sid of sids) {
      let offset = 0, total = null; const pageIdentities = new Set();
      for (;;) {
        const body = await client.call('get_fba_stock_list', { offset, length: 500, sid,
          fulfillment_channel_type: 'FBA', is_hide_zero_stock: '0', is_parant_asin_merge: '0',
          search_field: FIELDS[rule.type], search_value: rule.value, query_fba_storage_quantity_list: true });
        const data = body?.list ? body : body?.data;
        if (!data || !Array.isArray(data.list) || (typeof data.total !== 'number' && !(typeof data.total === 'string' && /^\d+$/.test(data.total))) || !Number.isSafeInteger(Number(data.total)) || Number(data.total) < 0) throw new Error('库存分页结构无效。');
        if (total === null) total = Number(data.total);
        if (total !== Number(data.total)) throw new Error('库存分页期间记录数变化。');
        const signature = JSON.stringify(data.list.map(row => [row.sid, row.seller_sku, row.fnsku, row.unique_id]));
        if (data.list.length && pageIdentities.has(signature)) throw new Error('库存返回重复分页。');
        pageIdentities.add(signature);
        if (data.list.some(row => String(row.sid) !== sid)) throw new Error('库存响应超出明确店铺范围。');
        rows.push(...data.list); offset += data.list.length;
        if (offset === total) break;
        if (!data.list.length || offset > total) throw new Error('库存分页未完整收齐。');
      }
    }
    return normalizeInventory(rows, new Set(sids));
  } finally { await client.close(); }
}
function normalizeDashboards(pendingBody, overdueBody) {
  const stores = new Map();
  for (const [field, body] of [['pending', pendingBody], ['overdue', overdueBody]]) {
    if (!body || Number(body.code) !== 1 || !Array.isArray(body.list) || !Number.isSafeInteger(body.total) || body.total < 0) throw new Error('站内信看板响应无效。');
    let sum = 0; const seen = new Set();
    for (const row of body.list) {
      const id = String(row.store_id ?? '');
      if (!id || !['number', 'string'].includes(typeof row.store_id) || typeof row.store_name !== 'string' || !Number.isSafeInteger(row.mail_count) || row.mail_count < 0 || seen.has(id)) throw new Error('站内信店铺计数无效。');
      seen.add(id); sum += row.mail_count;
      const store = stores.get(id) || { id, name: row.store_name, pending: 0, overdue: 0 };
      if (store.name !== row.store_name) throw new Error('站内信店铺映射不一致。');
      store[field] = row.mail_count; stores.set(id, store);
    }
    if (sum !== body.total) throw new Error('站内信看板计数未完整收齐。');
  }
  return [...stores.values()];
}
function isDashboard(request) {
  try { const url = new URL(request.url()); return request.method() === 'GET' && url.protocol === 'https:' && HOSTS.has(url.hostname) && DASHBOARD_PATH.test(url.pathname); } catch { return false; }
}
async function mail(root, overrides = {}) {
  const privateDir = path.join(root, '.private'), auth = path.join(privateDir, 'auth-state.json'), session = path.join(privateDir, 'session-storage.json');
  if (!fs.existsSync(auth) || !fs.existsSync(session)) throw new Error('请先在采集页登录领星并保存登录态。');
  const storage = JSON.parse(fs.readFileSync(session, 'utf8'));
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) throw new Error('登录态无效，请重新登录领星。');
  const chromium = overrides.chromium || require('playwright').chromium;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let context;
  try {
    context = await browser.newContext({ storageState: auth });
    await context.addInitScript(saved => {
      if (location.origin === 'https://xfg.lingxing.com') for (const [key, value] of Object.entries(saved)) sessionStorage.setItem(key, value);
    }, storage);
    // Rendering the mailbox may initialize background requests. Only these two verified read routes are allowed.
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (HOSTS.has(url.hostname) && /\/webmail\//i.test(url.pathname) && !(isDashboard(request) ||
          (request.method() === 'GET' && /^(?:\/pb-aftersale-mailforgateway)?\/api\/webmail\/after_sales\/amazonBuyerList$/.test(url.pathname)))) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const captured = page.waitForRequest(isDashboard, { timeout: 40000 });
    // Attach a handler immediately so failed navigation cannot leave a rejected waiter unhandled.
    captured.catch(() => {});
    await page.goto(MAIL_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    const request = await captured;
    if (/login|signin/i.test(new URL(page.url()).pathname)) throw new Error('登录已失效，请重新登录领星。');
    const headers = require('../shared').replayHeaders(await request.allHeaders());
    const bodies = [];
    for (const status of ['1', '2']) {
      const url = new URL(request.url());
      url.searchParams.set('mail_status', status); url.searchParams.set('mids', ''); url.searchParams.set('sids', ''); url.searchParams.set('req_time_sequence', String(Date.now()));
      const response = await context.request.get(url.href, { headers, timeout: 30000, maxRedirects: 0 });
      if (!response.ok()) throw new Error('站内信看板访问失败。');
      bodies.push(await response.json());
    }
    return normalizeDashboards(...bodies);
  } finally { try { if (context) await context.close(); } finally { await browser.close(); } }
}
module.exports = { inventory, mail, normalizeInventory, normalizeDashboards, isDashboard, MAIL_URL };
