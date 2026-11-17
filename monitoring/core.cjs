'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { atomicJson } = require('../automation/core.cjs');

const DEFAULTS = { version: 1, enabled: false, inventoryIntervalMinutes: 30,
  mail: { enabled: false, intervalMinutes: 5, repeatMinutes: 120 }, inventoryRules: [] };
function paths(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /\0/.test(root)) throw new Error('监控数据目录必须是有效的绝对路径。');
  const base = path.join(path.resolve(root), '.private', 'monitoring');
  return { base, config: path.join(base, 'config.json'), state: path.join(base, 'state.json'), lock: path.join(base, 'lock') };
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(label + '超出有效范围。');
  return value;
}
function bool(value, fallback) { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new Error('监控开关必须为布尔值。'); return value; }
function text(value, max, label, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f]/.test(value) || (required && !value.trim())) throw new Error(label + '无效。');
  return value.trim();
}
function normalizeConfig(input = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('监控配置无效。');
  if (input.version !== undefined && input.version !== 1) throw new Error('不支持的监控配置版本。');
  const mail = input.mail ?? {};
  if (!mail || typeof mail !== 'object' || Array.isArray(mail)) throw new Error('站内信配置无效。');
  const rules = input.inventoryRules ?? [];
  if (!Array.isArray(rules) || rules.length > 500) throw new Error('库存规则数量无效。');
  const config = { version: 1, enabled: bool(input.enabled, false),
    inventoryIntervalMinutes: integer(input.inventoryIntervalMinutes ?? 30, 5, 10080, '库存检查间隔'),
    mail: { enabled: bool(mail.enabled, false), intervalMinutes: integer(mail.intervalMinutes ?? 5, 5, 10080, '站内信检查间隔'),
      repeatMinutes: integer(mail.repeatMinutes ?? 120, 5, 10080, '站内信提醒间隔') },
    inventoryRules: rules.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('库存规则无效。');
      const id = raw.id === undefined ? crypto.randomUUID() : text(raw.id, 120, '规则标识', true);
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('规则标识无效。');
      const normalized = require('../shared').validate({ type: raw.type || 'MSKU', value: raw.value, country: raw.country, shop: raw.shop });
      const type = normalized.type;
      if (!['ASIN', '父ASIN', 'MSKU', 'SKU', 'SPU', 'FNSKU', '品名'].includes(type)) throw new Error('库存商品类型无效。');
      return { id, name: text(raw.name, 120, '规则名称', true), enabled: bool(raw.enabled, true), type,
        value: text(normalized.value, 160, '商品标识', true), country: text(normalized.country, 120, '国家'), shop: text(normalized.shop, 120, '店铺'),
        threshold: integer(raw.threshold, 0, 1000000000, '库存阈值'), cooldownMinutes: integer(raw.cooldownMinutes ?? 120, 5, 10080, '库存提醒间隔') };
    }) };
  if (new Set(config.inventoryRules.map(rule => rule.id)).size !== rules.length) throw new Error('库存规则标识重复。');
  return config;
}
function read(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
function readConfig(root) { return normalizeConfig(read(paths(root).config, DEFAULTS)); }
function readState(root) {
  const state = read(paths(root).state, { version: 1, events: [], lastCheck: { inventory: null, mail: null }, errors: [] });
  if (state.version !== 1 || !Array.isArray(state.events) || !state.lastCheck || !Array.isArray(state.errors)) throw new Error('本机监控记录损坏。');
  return state;
}
function getSchedule(root) {
  const config = readConfig(root), intervals = [];
  if (config.inventoryRules.some(rule => rule.enabled)) intervals.push(config.inventoryIntervalMinutes);
  if (config.mail.enabled) intervals.push(config.mail.intervalMinutes);
  return { enabled: config.enabled && intervals.length > 0, intervalMinutes: intervals.length ? Math.min(...intervals) : 30 };
}
function validNow(value) { const date = value === undefined ? new Date() : new Date(value); if (!Number.isFinite(date.getTime())) throw new Error('检查时间无效。'); return date; }
function pending(event, now) {
  return event.state === 'active' && event.notifyVersion > (event.deliveredVersion || 0) && (!event.snoozedUntil || Date.parse(event.snoozedUntil) <= now.getTime());
}
function snapshot(root, now = new Date()) {
  now = validNow(now);
  const state = readState(root);
  return { config: readConfig(root), events: state.events, pendingNotifications: state.events.filter(event => pending(event, now)), lastCheck: state.lastCheck, errors: state.errors };
}
function lockPort(root) {
  // Canonicalize aliases before choosing a mutex address. Nothing is read from or written to a lock file.
  let canonical = fs.realpathSync.native(path.resolve(root));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  // Stay below the OS ephemeral client-port range to avoid ordinary browser/HTTP connections.
  return 20000 + crypto.createHash('sha256').update('pulsarfetch-monitor\0' + canonical).digest().readUInt32BE(0) % 25000;
}
async function locked(root, fn) {
  const p = paths(root); fs.mkdirSync(p.base, { recursive: true, mode: 0o700 });
  // An exclusive loopback bind is an OS-owned, crash-released mutex. Never remove a stale sentinel:
  // multiple contenders cannot unlink a new owner's lock. Hash collisions conservatively report busy.
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error('监控正在运行或本机监控锁端口暂不可用，请稍后重试。'));
    server.once('error', onError);
    server.listen({ host: '127.0.0.1', port: lockPort(root), exclusive: true }, () => { server.removeListener('error', onError); resolve(); });
  });
  try { return await fn(); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
function upsert(state, key, kind, title, message, target, active, cooldown, now, extra = {}) {
  const stamp = now.toISOString(); let event = state.events.find(item => item.key === key);
  if (!event && !active) return;
  if (!event) { event = { id: crypto.randomUUID(), key, kind, title, message, target, state: 'active', unread: true,
    createdAt: stamp, updatedAt: stamp, notifyVersion: 1, deliveredVersion: 0, lastNotifiedAt: stamp, ...extra }; state.events.push(event); return; }
  const previous = event.state;
  const changed = event.title !== title || event.message !== message;
  Object.assign(event, { title, message, target, ...extra });
  if (!active) {
    if (previous !== 'resolved') Object.assign(event, { state: 'resolved', updatedAt: stamp, resolvedAt: stamp });
    return;
  }
  event.state = 'active';
  if (changed || previous !== 'active') event.updatedAt = stamp;
  const snoozed = event.snoozedUntil && Date.parse(event.snoozedUntil) > now.getTime();
  if (previous !== 'active') { event.unread = true; delete event.resolvedAt; delete event.snoozedUntil; }
  if (previous !== 'active' || (!snoozed && now.getTime() - Date.parse(event.lastNotifiedAt) >= cooldown * 60000)) {
    event.notifyVersion++; event.lastNotifiedAt = stamp; event.updatedAt = stamp; event.unread = true;
  }
}
function resolveWhere(state, predicate, now) { for (const event of state.events) if (event.state === 'active' && predicate(event)) Object.assign(event, { state: 'resolved', resolvedAt: now.toISOString(), updatedAt: now.toISOString() }); }
function failure(state, key, message, now, cooldown) {
  state.errors = state.errors.filter(item => item.key !== key);
  state.errors.push({ key, message, at: now.toISOString() });
  upsert(state, 'error:' + key, 'error', '监控检查失败', message, '', true, cooldown, now);
}
function success(state, key, now) { state.errors = state.errors.filter(item => item.key !== key); resolveWhere(state, event => event.key === 'error:' + key, now); }
function due(previous, minutes, now) { return !previous || now.getTime() - Date.parse(previous) >= minutes * 60000; }
async function tick(root, options = {}) {
  return locked(root, async () => {
    const now = validNow(options.now), config = readConfig(root), state = readState(root);
    if (!config.enabled) return snapshot(root, now);
    const providers = options.providers || require('./providers.cjs');
    if (config.inventoryRules.some(rule => rule.enabled) && (options.force === true || due(state.lastCheck.inventory, config.inventoryIntervalMinutes, now))) {
      for (const rule of config.inventoryRules.filter(rule => rule.enabled)) {
        const key = 'inventory:' + rule.id;
        try {
          const rows = await providers.inventory(root, rule);
          if (!Array.isArray(rows) || !rows.length || rows.some(row => !row.identity || typeof row.quantity !== 'number' || !Number.isSafeInteger(row.quantity) || row.quantity < 0)) throw new Error('unknown inventory');
          const seen = new Set();
          for (const row of rows) {
            if (seen.has(row.identity)) throw new Error('duplicate inventory'); seen.add(row.identity);
          }
          for (const row of rows) upsert(state, key + ':' + row.identity, 'inventory', rule.name + '：FBA 可售库存提醒',
            'MSKU ' + (row.seller_sku || rule.value) + '；FNSKU ' + (row.fnsku || '未知') + '；FBA 可售库存 ' + row.quantity + '，提醒阈值 ' + rule.threshold + '（严格低于时提醒）。',
            'https://xfg.lingxing.com/erp/productExpressionNew', row.quantity < rule.threshold, rule.cooldownMinutes, now,
            { ruleId: rule.id, inventory: { identity: row.identity, quantity: row.quantity, sid: row.sid, seller_sku: row.seller_sku,
              fnsku: row.fnsku, unique_id: row.unique_id, group_by_sid: row.group_by_sid, share_type: row.share_type } });
          success(state, key, now);
        } catch { failure(state, key, '库存规则“' + rule.name + '”未取得可确认的 FBA 可售数量，请核对 MCP 连接、商品及国家店铺范围。', now, rule.cooldownMinutes); }
      }
      state.lastCheck.inventory = now.toISOString();
    }
    if (config.mail.enabled && (options.force === true || due(state.lastCheck.mail, config.mail.intervalMinutes, now))) {
      try {
        const stores = await providers.mail(root);
        if (!Array.isArray(stores) || stores.some(store => !store.id || !Number.isSafeInteger(store.pending) || store.pending < 0 || !Number.isSafeInteger(store.overdue) || store.overdue < 0) || new Set(stores.map(store => String(store.id))).size !== stores.length) throw new Error('unknown mail');
        const keys = new Set();
        for (const store of stores) {
          const key = 'mail:' + store.id; keys.add(key);
          const name = typeof store.name === 'string' ? store.name.replace(/[\u0000-\u001f]/g, '').slice(0, 120) : '店铺';
          upsert(state, key, 'mail', name + '：站内信待处理', '待回复 ' + store.pending + ' 封，超时 ' + store.overdue + ' 封。',
            'https://xfg.lingxing.com/erp/EmailService', store.pending > 0 || store.overdue > 0, config.mail.repeatMinutes, now);
        }
        resolveWhere(state, event => event.kind === 'mail' && !keys.has(event.key), now); success(state, 'mail', now);
      } catch { failure(state, 'mail', '站内信检查失败，请在采集页重新登录领星，并确认“售后邮件 > 站内信”访问权限。', now, config.mail.repeatMinutes); }
      state.lastCheck.mail = now.toISOString();
    }
    atomicJson(paths(root).state, state); return snapshot(root, now);
  });
}
function saveUnlocked(root, config) {
    const old = readConfig(root), state = readState(root), now = new Date();
    // Changing scope/rules must cause a fresh check, even inside the prior interval.
    if (JSON.stringify(old.inventoryRules) !== JSON.stringify(config.inventoryRules) || old.inventoryIntervalMinutes !== config.inventoryIntervalMinutes) state.lastCheck.inventory = null;
    if (JSON.stringify(old.mail) !== JSON.stringify(config.mail)) state.lastCheck.mail = null;
    if (!old.enabled && config.enabled) state.lastCheck = { inventory: null, mail: null };
    const activeRules = new Set(config.inventoryRules.filter(rule => rule.enabled).map(rule => rule.id));
    const changedScopes = new Set(config.inventoryRules.filter(rule => {
      const previous = old.inventoryRules.find(item => item.id === rule.id);
      return previous && ['type', 'value', 'country', 'shop'].some(field => previous[field] !== rule[field]);
    }).map(rule => rule.id));
    resolveWhere(state, event => !config.enabled || (event.kind === 'inventory' && (!activeRules.has(event.ruleId) || changedScopes.has(event.ruleId))) || (event.kind === 'mail' && !config.mail.enabled) || (event.kind === 'error' && (event.key.startsWith('error:inventory:') ? !activeRules.has(event.key.slice('error:inventory:'.length)) : !config.mail.enabled)), now);
    state.errors = state.errors.filter(error => config.enabled && (error.key.startsWith('inventory:') ? activeRules.has(error.key.slice(10)) : config.mail.enabled));
    atomicJson(paths(root).state, state); atomicJson(paths(root).config, config); return snapshot(root);
}
async function save(root, input) {
  const config = normalizeConfig(input);
  return locked(root, () => saveUnlocked(root, config));
}
function restoreFile(file, bytes) {
  if (bytes === null) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function saveScheduled(root, input, registerSchedule) {
  const config = normalizeConfig(input);
  if (typeof registerSchedule !== 'function') throw new Error('监控事务保存缺少系统调度同步回调。');
  return locked(root, async () => {
    const p = paths(root), files = [p.config, p.state];
    const before = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null);
    let registrationAttempted = false;
    try {
      saveUnlocked(root, config);
      registrationAttempted = true;
      await registerSchedule(root);
      return snapshot(root);
    } catch {
      const failures = [];
      for (let index = 0; index < files.length; index++) {
        try { restoreFile(files[index], before[index]); }
        catch { failures.push(index === 0 ? '原监控配置恢复失败' : '原提醒状态恢复失败'); }
      }
      if (registrationAttempted) {
        try { await registerSchedule(root); }
        catch { failures.push('原系统调度恢复失败'); }
      }
      const outcome = failures.length ? failures.join('；') : '已完整恢复原监控配置、提醒状态' + (registrationAttempted ? '及系统调度' : '');
      // Do not include arbitrary scheduler exception text: it may contain command arguments or private paths.
      throw new Error((registrationAttempted ? '监控设置的系统调度同步失败；' : '监控设置保存失败；') + outcome + '。');
    }
  });
}
async function mutate(root, action, request, options = {}) {
  const now = validNow(options.now), ids = request.ids ?? (request.id ? [request.id] : null);
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => typeof id !== 'string' || id.length > 120)) throw new Error('请选择有效的提醒标识。');
  let until;
  if (action === 'snooze') until = new Date(now.getTime() + integer(request.minutes ?? 60, 5, 10080, '稍后提醒时长') * 60000).toISOString();
  return locked(root, async () => {
    const state = readState(root);
    if (ids.some(id => !state.events.some(event => event.id === id))) throw new Error('提醒记录不存在。');
    for (const event of state.events.filter(event => ids.includes(event.id))) {
      if (action === 'mark-read') event.unread = false;
      else if (action === 'snooze') { event.snoozedUntil = until; event.notifyVersion++; event.lastNotifiedAt = until; }
      else if (action === 'ack-notifications') {
        const version = request.versions?.[event.id] ?? event.notifyVersion;
        integer(version, 1, event.notifyVersion, '通知版本');
        event.deliveredVersion = Math.max(event.deliveredVersion || 0, version);
      } else throw new Error('不支持的提醒操作。');
      event.updatedAt = now.toISOString();
    }
    atomicJson(paths(root).state, state); return snapshot(root, now);
  });
}
module.exports = { DEFAULTS, paths, normalizeConfig, readConfig, readState, getSchedule, snapshot, tick, save, saveScheduled, mutate, lockPort };
