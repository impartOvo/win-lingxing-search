'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const Ajv = require('ajv');
const { safeError } = require('./settings.cjs');
const ALLOWED = new Set(['customer_review_country_sellers', 'query_product_performance_asin_lists', 'erp_listing', 'get_fba_stock_list']);
function unwrap(result) {
  if (result.isError) throw new Error('MCP 工具返回错误：' + (result.content?.filter(c => c.type === 'text').map(c => c.text).join(' ') || '无详情'));
  let value = result.structuredContent;
  if (!value) {
    const text = result.content?.find(c => c.type === 'text')?.text;
    try { value = JSON.parse(text); } catch { throw new Error('MCP 返回了无法解析的业务数据。'); }
  }
  if (value.success === false || (value.code !== undefined && Number(value.code) !== 1)) throw new Error('领星查询失败：' + (value.msg || '请核对当前账号权限'));
  return value.data ?? value;
}
class LingxingClient {
  constructor(config) { this.config = config; this.schemas = new Map(); }
  async connect() {
    const config = this.config;
    const headers = { [config.header]: config.header === 'Authorization' && !/^Bearer\s/i.test(config.key) ? 'Bearer ' + config.key : config.key };
    const fetcher = (url, options) => fetch(url, { ...options, redirect: 'error' });
    for (const mode of config.transport === 'auto' ? ['http', 'sse'] : [config.transport]) {
      this.client = new Client({ name: 'lingxing-search', version: require('../package.json').version });
      try {
        const options = { requestInit: { headers }, fetch: fetcher };
        this.transport = mode === 'sse' ? new SSEClientTransport(new URL(config.url), options) : new StreamableHTTPClientTransport(new URL(config.url), options);
        await this.client.connect(this.transport, { timeout: 30000 });
        this.mode = mode;
        const tools = (await this.client.listTools()).tools;
        this.names = {};
        for (const key of ['help', 'search', 'action']) {
          const matches = tools.filter(t => t.name === key || t.name.endsWith('_' + key));
          if (matches.length !== 1) throw new Error('服务缺少唯一的领星 ' + key + ' 工具。');
          this.names[key] = matches[0].name;
        }
        return this;
      } catch (error) {
        await this.close();
        if (config.transport === 'auto' && mode === 'http' && [404, 405].includes(error.code)) continue;
        throw new Error(safeError(error, config));
      }
    }
    throw new Error('无法连接 MCP 服务。');
  }
  async invoke(name, args) {
    for (let attempt = 0; ; attempt++) {
      try { return unwrap(await this.client.callTool({ name, arguments: args }, undefined, { timeout: 60000 })); }
      catch (error) {
        const limited = Number(error.code) === 429 || /status:\s*429|"code"\s*:\s*429|并发已达上限/i.test(String(error.message));
        if (!limited || attempt >= 5) throw new Error(safeError(error, this.config));
        const delay = Math.min(30000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 750);
        // All invocations are discovery or allowlisted reads. Retry only an explicit service limit.
        console.log('领星 MCP 返回限流，等待 ' + Math.ceil(delay / 1000) + ' 秒后重试只读查询…');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  async schema(id) {
    if (!ALLOWED.has(id)) throw new Error('此客户端仅支持已核验的商品诊断只读工具。');
    if (!this.schemas.has(id)) {
      const catalog = await this.invoke(this.names.help, { query: id, limit: 50 });
      const tool = catalog.tools?.find(t => t.toolId === id);
      if (!tool || tool.toolType !== 'read') throw new Error('当前连接未提供所需的只读工具：' + id);
      const spec = await this.invoke(this.names.search, { toolId: id });
      if (spec.toolType !== 'read' || !spec.inputSchema) throw new Error('领星工具定义不符合只读查询要求。');
      const ajv = new Ajv({ strict: false, validateFormats: false });
      this.schemas.set(id, ajv.compile(spec.inputSchema));
    }
    return this.schemas.get(id);
  }
  async call(id, params) {
    const validate = await this.schema(id);
    if (!validate(params)) throw new Error('MCP 查询参数不符合当前接口定义：' + new Ajv().errorsText(validate.errors));
    const body = await this.invoke(this.names.action, { toolId: id, params });
    if (body.code !== undefined && Number(body.code) !== 1) throw new Error('领星业务查询失败，请核对条件和账号权限。');
    return body;
  }
  async close() { try { if (this.client) await this.client.close(); } catch { } }
}
module.exports = { LingxingClient, unwrap, ALLOWED };
