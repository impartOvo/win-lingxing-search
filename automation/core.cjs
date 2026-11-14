'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validate } = require('../shared');

const PERIODS = {
  today: '今天', yesterday: '昨天', recent7: '近 7 天（含今天）', prev7: '前 7 天（截至昨天）',
  thisWeek: '本周（周一至今天）', lastWeek: '上周（周一至周日）',
  recent30: '近 30 天（含今天）', prev30: '前 30 天（截至昨天）',
  thisMonth: '本月（1 日至今天）', lastMonth: '上月（完整自然月）', custom: '固定日期区间'
};
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shift = (date, days) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
function resolveDates(task, now = new Date()) {
  let from = shift(now, 0), to = shift(now, 0);
  switch (task.period) {
    case 'today': break;
    case 'yesterday': from = to = shift(now, -1); break;
    case 'recent7': from = shift(now, -6); break;
    case 'prev7': from = shift(now, -7); to = shift(now, -1); break;
    case 'recent30': from = shift(now, -29); break;
    case 'prev30': from = shift(now, -30); to = shift(now, -1); break;
    case 'thisWeek': from = shift(now, -((now.getDay() + 6) % 7)); break;
    case 'lastWeek': to = shift(now, -((now.getDay() + 6) % 7) - 1); from = shift(to, -6); break;
    case 'thisMonth': from = new Date(now.getFullYear(), now.getMonth(), 1); break;
    case 'lastMonth': from = new Date(now.getFullYear(), now.getMonth() - 1, 1); to = new Date(now.getFullYear(), now.getMonth(), 0); break;
    case 'custom': return { from: task.from, to: task.to };
    default: throw new Error('请选择有效的采集日期范围');
  }
  return { from: localDate(from), to: localDate(to) };
}
function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('任务内容无效');
  const id = raw.id || crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('任务标识无效');
  const name = String(raw.name || '').trim();
  if (!name || name.length > 120) throw new Error('请填写任务名称（最多 120 字符）');
  if (!Object.hasOwn(PERIODS, raw.period)) throw new Error('请选择采集日期范围');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time)) throw new Error('运行时间请填写 HH:mm，例如 09:00');
  if (!Array.isArray(raw.days) || !raw.days.length || raw.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('至少选择一个有效的星期');
  const task = { id, name, enabled: raw.enabled !== false, type: raw.type, value: raw.value, match: raw.match,
    country: raw.country || '', shop: raw.shop || '', period: raw.period, from: raw.from || '', to: raw.to || '',
    days: [...new Set(raw.days)].sort(), time: raw.time };
  const input = validate({ type: task.type, value: task.value, match: task.match, country: task.country, shop: task.shop, ...resolveDates(task) });
  for (const key of ['type', 'value', 'match', 'country', 'shop']) task[key] = input[key] || '';
  return task;
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function paths(dataRoot) {
  const base = path.join(dataRoot, '.private', 'automation');
  return { base, config: path.join(base, 'tasks.json'), runs: path.join(base, 'runs'), slots: path.join(base, 'slots'), logs: path.join(base, 'logs') };
}
function readJson(file, fallback) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
function readConfig(dataRoot) {
  const value = readJson(paths(dataRoot).config, { enabled: false, tasks: [] });
  if (!Array.isArray(value.tasks)) throw new Error('自动化任务配置损坏，请检查本机 tasks.json');
  return { enabled: value.enabled === true, tasks: value.tasks.map(normalizeTask) };
}
function saveConfig(dataRoot, config) {
  const value = { enabled: config.enabled === true, tasks: config.tasks.map(normalizeTask) };
  if (new Set(value.tasks.map(t => t.id)).size !== value.tasks.length) throw new Error('任务标识重复');
  atomicJson(paths(dataRoot).config, value); return value;
}
function due(task, now) { return task.enabled && task.days.includes(now.getDay()) && task.time === `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; }
function nextRun(task, now = new Date()) {
  if (!task.enabled) return null;
  const [hour, minute] = task.time.split(':').map(Number);
  for (let day = 0; day <= 7; day++) {
    const date = shift(now, day); date.setHours(hour, minute, 0, 0);
    if (date > now && task.days.includes(date.getDay())) return date.toISOString();
  }
  return null;
}
function claimSlot(dataRoot, task, now) {
  fs.mkdirSync(paths(dataRoot).slots, { recursive: true, mode: 0o700 });
  const file = path.join(paths(dataRoot).slots, `${task.id}-${localDate(now)}-${task.time.replace(':', '')}.json`);
  try { fs.writeFileSync(file, JSON.stringify({ at: now.toISOString() }), { flag: 'wx', mode: 0o600 }); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
}
function alive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function snapshot(dataRoot, now = new Date()) {
  const config = readConfig(dataRoot), p = paths(dataRoot);
  const runs = fs.existsSync(p.runs) ? fs.readdirSync(p.runs).filter(n => n.endsWith('.json')).map(n => readJson(path.join(p.runs, n))).filter(Boolean) : [];
  for (const run of runs) {
    if (['starting', 'running'].includes(run.status) && !alive(run.pid) && now - new Date(run.createdAt) > 15000) {
      run.status = 'error'; run.error = '采集进程已退出，任务未完成'; run.finishedAt = now.toISOString(); atomicJson(path.join(p.runs, run.id + '.json'), run);
    }
  }
  runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = runs.filter(r => ['starting', 'running'].includes(r.status));
  return { ...config, periods: PERIODS, weekdays: WEEKDAYS, running: active.length,
    tasks: config.tasks.map(task => ({ ...task, scheduleLabel: `${task.days.map(d => WEEKDAYS[d]).join('、')} ${task.time}`, periodLabel: PERIODS[task.period],
      nextAt: config.enabled ? nextRun(task, now) : null, latest: runs.find(r => r.taskId === task.id) || null })),
    runs: [...new Map([...active, ...runs.slice(0, 100)].map(r => [r.id, r])).values()] };
}
module.exports = { PERIODS, WEEKDAYS, localDate, resolveDates, normalizeTask, atomicJson, paths, readJson, readConfig, saveConfig, due, nextRun, claimSlot, snapshot };
