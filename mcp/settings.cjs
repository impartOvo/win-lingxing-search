'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { parse } = require('smol-toml');
const { atomicJson } = require('../automation/core.cjs');
const file = root => path.join(root, '.private', 'mcp', 'connection.json');
function endpoint(value) {
  const url = new URL(String(value || '').trim());
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('MCP 地址需使用 HTTPS；本机测试可使用 localhost HTTP。');
  }
  return url.href;
}
function protect(value, mode) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'protect-windows.ps1'), '-Mode', mode],
      { input: value, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new Error('无法读取或保护本机 MCP 密钥，请在当前用户下重新保存连接。'); }
}
function raw(root) { return fs.existsSync(file(root)) ? JSON.parse(fs.readFileSync(file(root), 'utf8')) : null; }
function read(root) {
  const saved = raw(root);
  if (!saved) throw new Error('尚未配置 MCP，请先在“MCP 连接”中保存地址和密钥。');
  const key = saved.storage === 'windows-dpapi' ? protect(saved.secret, 'unprotect') : saved.secret;
  if (!key) throw new Error('MCP 密钥为空，请重新保存连接。');
  return { url: endpoint(saved.url), header: saved.header, transport: saved.transport || 'auto', key };
}
function status(root) {
  const saved = raw(root);
  return { configured: !!saved?.secret, url: saved?.url || '', header: saved?.header || 'X-Mcp-Key', transport: saved?.transport || 'auto', storage: saved?.storage || null };
}
function save(root, input) {
  const url = endpoint(input.url), header = input.header || 'X-Mcp-Key', transport = input.transport || 'auto';
  if (!['X-Mcp-Key', 'Authorization'].includes(header) || !['auto', 'http', 'sse'].includes(transport)) throw new Error('MCP 认证或传输方式无效。');
  let key = String(input.key || '').trim();
  if (!key) {
    const old = raw(root);
    if (!old || old.url !== url || old.header !== header) throw new Error('新连接需填写密钥；原连接留空表示保留已保存密钥。');
    key = read(root).key;
  }
  if (/[\r\n]/.test(key)) throw new Error('MCP 密钥不能包含换行。');
  const storage = process.platform === 'win32' ? 'windows-dpapi' : 'private-file';
  const secret = storage === 'windows-dpapi' ? protect(key, 'protect') : key;
  atomicJson(file(root), { version: 1, url, header, transport, storage, secret });
  fs.chmodSync(file(root), 0o600);
  return status(root);
}
function importCodex(root, configFile = path.join(os.homedir(), '.codex', 'config.toml')) {
  if (!fs.existsSync(configFile)) throw new Error('未找到本机 Codex 配置，请手动填写 MCP 地址和密钥。');
  let entry;
  try { entry = parse(fs.readFileSync(configFile, 'utf8')).mcp_servers?.lingxing; }
  catch { throw new Error('本机 Codex 配置无法解析，请手动填写连接。'); }
  if (!entry?.url || entry.enabled === false) throw new Error('本机配置未启用名为 lingxing 的远程 MCP，请手动填写连接。');
  const headers = entry.http_headers || {};
  const header = Object.keys(headers).find(name => name.toLowerCase() === 'x-mcp-key') || Object.keys(headers).find(name => name.toLowerCase() === 'authorization');
  if (!header) throw new Error('该配置没有可导入的 X-Mcp-Key 或 Authorization，请手动配置领星支持的授权。');
  return save(root, { url: entry.url, header: header.toLowerCase() === 'authorization' ? 'Authorization' : 'X-Mcp-Key', key: headers[header] });
}
function safeError(error, config) {
  let text = String(error?.message || error || 'MCP 调用失败');
  for (const secret of [config?.key, config?.url].filter(Boolean)) text = text.split(secret).join('[已隐藏]');
  text = text.replace(/https?:\/\/[^\s"<>]+/g, '[MCP 服务地址]').replace(/(?:Bearer\s+)[^\s"<>]+/gi, 'Bearer [已隐藏]');
  return text.slice(0, 900);
}
module.exports = { endpoint, read, status, save, importCodex, safeError };
