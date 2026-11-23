'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const settings = require('../mcp/settings.cjs');
const { LingxingClient } = require('../mcp/client.cjs');
const { capture, scope, paginate } = require('../mcp/collector.cjs');
const core = require('../automation/core.cjs');
const { launch } = require('../automation/dispatch.cjs');
const reports = require('../mac/reports.cjs');
const choices = { markets: [{ country: '德国', code: 'DE', country_id: 5 }], sellers: [{ seller_simple_name: '示例-DE', sid: 10, country_id: 5, currency_code: 'EUR' }] };
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxing-mcp-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('lingxing-mcp-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function mockClient(rows = [{ parent_asin: 'B0ASIN0001', volume: 0, amount: '0.00', return_goods_rate: null, currency_code: 'EUR' }]) {
  return { calls: [], connect: async () => {}, close: async () => {}, async call(id, params) {
    this.calls.push({ id, params });
    if (id === 'customer_review_country_sellers') return choices;
    if (id === 'erp_listing') return { code: 1, data: { total: 2, list: [{ local_name: '中文示例商品', parent_asin: 'B0ASIN0001', msku: 'DEMO-A' }, { local_name: '中文示例商品', parent_asin: 'B0ASIN0001', msku: 'DEMO-B' }] } };
    return { code: 1, data: { total: rows.length, list: rows } };
  } };
}
async function serverFixture(t, rateLimitOnce = false) {
  const calls = [], mock = mockClient();
  const server = new Server({ name: 'synthetic-lingxing', version: '1' }, { capabilities: { tools: {} } });
  const schema = { type: 'object', properties: { offset: { type: 'integer' }, length: { type: 'integer', maximum: 500 } }, required: ['offset', 'length'] };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['help', 'search', 'action'].map(name => ({ name, inputSchema: { type: 'object' } })) }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params;
    calls.push({ name, args });
    if (name === 'action' && rateLimitOnce) {
      rateLimitOnce = false;
      return { isError: true, content: [{ type: 'text', text: 'call failed, status: 429, response: {"code":429,"msg":"该用户的此工具并发已达上限"}' }] };
    }
    let data;
    if (name === 'help') data = { tools: [{ toolId: args.query, toolType: 'read' }] };
    else if (name === 'search') data = { toolId: args.toolId, toolType: 'read', inputSchema: args.toolId === 'customer_review_country_sellers' ? { type: 'object', additionalProperties: false } : schema };
    else data = await mock.call(args.toolId, args.params);
    return { content: [{ type: 'text', text: JSON.stringify({ code: 1, success: true, data }) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), enableJsonResponse: true });
  await server.connect(transport);
  const listener = http.createServer((req, res) => {
    if (req.headers['x-mcp-key'] !== 'synthetic-private-key') { res.writeHead(401); res.end(); return; }
    transport.handleRequest(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await server.close(); listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); });
  return { calls, config: { url: `http://127.0.0.1:${listener.address().port}/mcp`, header: 'X-Mcp-Key', key: 'synthetic-private-key', transport: 'http' } };
}

test('official SDK client authenticates over HTTP and enforces help -> schema -> read action', async t => {
  const fixture = await serverFixture(t, true), client = new LingxingClient(fixture.config);
  t.after(() => client.close());
  await client.connect();
  const result = await client.call('query_product_performance_asin_lists', { offset: 0, length: 2 });
  assert.equal(result.data.list.length, 1);
  assert.deepEqual(fixture.calls.map(c => c.name), ['help', 'search', 'action', 'action']);
  assert.deepEqual(fixture.calls[2].args, fixture.calls[3].args);
  await assert.rejects(client.call('query_product_performance_asin_lists', { offset: 0, length: 501 }), /参数不符合/);
  await assert.rejects(client.call('create_ready_send_delivery_order', {}), /只读/);
  assert.equal(fixture.calls.length, 4);
});

test('connection import stores a private credential, hides it from status, and requires a new key for a new endpoint', t => {
  const root = temporary(t), file = path.join(root, 'codex-synthetic.toml');
  const key = 'synthetic-import-key';
  fs.writeFileSync(file, '[mcp_servers.lingxing]\nenabled=true\nurl="https://example.invalid/mcp"\n[mcp_servers.lingxing.http_headers]\nX-Mcp-Key="' + key + '"\n');
  const result = settings.importCodex(root, file);
  assert.equal(result.configured, true);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(settings.read(root).key, key);
  if (process.platform === 'win32') assert.ok(!fs.readFileSync(path.join(root, '.private/mcp/connection.json'), 'utf8').includes(key));
  settings.save(root, { url: result.url, key: '' });
  assert.equal(settings.read(root).key, key);
  assert.throws(() => settings.save(root, { url: 'https://other.invalid/mcp', key: '' }), /新连接需填写密钥/);
  assert.throws(() => settings.save(root, { url: 'http://example.invalid/mcp', key }), /HTTPS/);
  assert.equal(settings.read(root).key, key);
  const message = settings.safeError(new Error('fetch ' + result.url + ' header ' + key), { key, url: result.url });
  assert.ok(!message.includes(key) && !message.includes(result.url));
});

test('scope maps country and unique shop, chooses the site currency and rejects ambiguous multi-currency totals', () => {
  assert.deepEqual(scope({ country: '德国' }, choices), { mids: '5', sids: '10', currency_code: 'EUR' });
  assert.deepEqual(scope({ shop: '示例' }, choices), { mids: '', sids: '10', currency_code: 'EUR' });
  const multiple = { ...choices, sellers: [...choices.sellers, { seller_simple_name: '示例-US', sid: 20, currency_code: 'USD' }] };
  assert.throws(() => scope({}, multiple), /多种币种/);
  assert.throws(() => scope({ shop: '示例' }, multiple), /不唯一/);
  assert.equal(scope({ currency: 'CNY' }, multiple).currency_code, 'CNY');
});

test('name capture resolves and deduplicates Listing parents, preserves zero/null and publishes readable MCP history', async t => {
  const root = temporary(t), client = mockClient();
  const file = await capture({ type: 'name', value: '示例', country: '德国', from: '2026-11-01', to: '2026-11-01' }, { root, config: { key: 'do-not-save', url: 'https://example.invalid/mcp' }, client });
  const record = JSON.parse(fs.readFileSync(file));
  const query = client.calls.find(c => c.id === 'query_product_performance_asin_lists').params;
  assert.deepEqual(query.search_value, ['B0ASIN0001']);
  assert.equal(query.currency_code, 'EUR');
  assert.equal(record.method, 'mcp');
  assert.equal(record.resolved.matchedListings, 2);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('do-not-save'));
  const bundle = reports.readBundle(path.dirname(file), path.basename(file));
  assert.equal(bundle.rows[0].volume, 0);
  assert.equal(bundle.rows[0].return_goods_rate, null);
  assert.equal(reports.history(path.dirname(file)).length, 1);
  assert.throws(() => reports.summaryPath(path.dirname(file), '../mcp-data-outside.json'));
});

test('blank product fetches all products for one shop without a Listing lookup', async t => {
  const root = temporary(t), client = mockClient([{ msku: 'SAMPLE-MSKU', currency_code: 'EUR' }]);
  const file = await capture({ type: 'fnsku', value: ' ', country: '德国', shop: choices.sellers[0].seller_simple_name }, { root, config: {}, client });
  const query = client.calls.find(c => c.id === 'query_product_performance_asin_lists').params;
  assert.deepEqual(query.search_value, []);
  assert.equal(query.sids, '10');
  assert.equal(query.summary_field, 'msku');
  assert.ok(!client.calls.some(c => c.id === 'erp_listing'));
  assert.equal(reports.readBundle(path.dirname(file), path.basename(file)).summary.input.value, '');
});

test('empty data and incomplete or repeated pagination never become a successful capture', async t => {
  const root = temporary(t);
  await assert.rejects(capture({ type: 'asin', value: 'B0ASIN0001', country: '德国', from: '2026-11-01', to: '2026-11-01' }, { root, config: {}, client: mockClient([]) }), /没有匹配记录/);
  assert.ok(!fs.existsSync(path.join(root, 'results')));
  await assert.rejects(capture({ type: 'name', value: '示例', country: '德国', from: '2026-11-01', to: '2026-11-01' }, { root, config: {}, client: mockClient([{ parent_asin: 'OUTSIDE', volume: 1, currency_code: 'EUR' }]) }), /超出 Listing/);
  await assert.rejects(capture({ type: 'asin', value: 'B0ASIN0001', country: '德国', from: '2026-11-01', to: '2026-11-01' }, { root, config: {}, client: mockClient([{ asin: 'B0ASIN0001', currency_code: 'USD' }]) }), /币种.*不一致/);
  assert.ok(!fs.existsSync(path.join(root, 'results')));
  const repeated = { call: async () => ({ code: 1, data: { total: 2, list: [{ asin: 'B0ASIN0001' }] } }) };
  await assert.rejects(paginate(repeated, 'example', {}, 1), /重复分页/);
  const truncated = { call: async () => ({ code: 1, data: { total: 2, list: [] } }) };
  await assert.rejects(paginate(truncated, 'example', {}, 2), /提前结束/);
});

test('an independent automation worker uses its saved MCP connection and writes a usable result pair', async t => {
  const root = temporary(t), fixture = await serverFixture(t);
  settings.save(root, { ...fixture.config, key: fixture.config.key });
  const task = core.normalizeTask({ name: '示例 MCP 定时任务', source: 'mcp', currency: 'EUR', type: 'parent_asin', value: 'B0ASIN0001', country: '德国', period: 'yesterday', days: [1], time: '08:00' });
  const run = launch(root, task, 'manual');
  const deadline = Date.now() + 20000;
  let state;
  do { await new Promise(resolve => setTimeout(resolve, 50)); state = core.readJson(path.join(core.paths(root).runs, run.id + '.json')); } while (!['ok', 'error'].includes(state.status) && Date.now() < deadline);
  assert.equal(state.status, 'ok', state.error);
  assert.ok(state.resultName.startsWith('mcp-'));
  const bundle = reports.readBundle(path.join(root, 'results'), state.resultName);
  assert.equal(bundle.summary.automation.runId, run.id);
  assert.equal(bundle.summary.input.source, 'mcp');
  assert.equal(bundle.rows.length, 1);
});
