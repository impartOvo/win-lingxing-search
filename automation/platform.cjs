'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { paths, readConfig, scheduleSlots } = require('./core.cjs');
const taskName = dataRoot => 'LingxingSearch-Automation-' + crypto.createHash('sha256').update(path.resolve(dataRoot)).digest('hex').slice(0, 12);
const xml = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function monitorRegistration(dataRoot, schedule, executable = process.execPath) {
  paths(dataRoot);
  if (!schedule || typeof schedule.enabled !== 'boolean' || !Number.isInteger(schedule.intervalMinutes) || schedule.intervalMinutes < 5) throw new Error('监控计划必须使用至少 5 分钟的有效间隔');
  return { name: taskName(dataRoot) + '-Monitor', enabled: schedule.enabled, intervalMinutes: schedule.intervalMinutes,
    executable, args: ['--monitor-tick', '--data', dataRoot] };
}
function monitorPlist(plan, dataRoot) {
  const label = 'io.github.impartovo.' + plan.name.toLowerCase();
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${[plan.executable, ...plan.args].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>StartInterval</key><integer>${plan.intervalMinutes * 60}</integer><key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(paths(dataRoot).logs, 'monitor.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(paths(dataRoot).logs, 'monitor-error.log'))}</string>
</dict></plist>`;
}
function calendarIntervals(slots) {
  return slots.flatMap(({ time, days }) => {
    const [hour, minute] = time.split(':').map(Number);
    return days.map(day => `<dict><key>Weekday</key><integer>${day}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`);
  }).join('');
}
function install(dataRoot, enabled, tasks, options = {}) {
  const platform = options.platform || process.platform, exec = options.exec || execFileSync;
  const schedule = options.getSchedule ? options.getSchedule(dataRoot) : require('../monitoring/core.cjs').getSchedule(dataRoot);
  const monitor = monitorRegistration(dataRoot, schedule, options.executable || (platform === 'win32' ? path.join(__dirname, '..', 'PulsarFetch.exe') : process.execPath));
  const name = taskName(dataRoot), cli = path.join(__dirname, 'cli.cjs');
  const slots = enabled ? scheduleSlots(tasks || readConfig(dataRoot).tasks) : [];
  if (platform === 'win32') {
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'register-windows.ps1'),
      '-TaskName', name, '-LauncherPath', path.join(__dirname, '..', 'PulsarFetch.exe'), '-DataRoot', dataRoot, '-Mode', enabled ? 'enable' : 'disable'],
    { windowsHide: true, encoding: 'utf8', input: JSON.stringify(slots), timeout: 25000 });
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'register-windows.ps1'),
      '-TaskName', monitor.name, '-LauncherPath', monitor.executable, '-DataRoot', dataRoot,
      '-Kind', 'monitor', '-IntervalMinutes', String(monitor.intervalMinutes), '-Mode', monitor.enabled ? 'enable' : 'disable'],
    { windowsHide: true, encoding: 'utf8', input: '[]', timeout: 25000 });
  } else if (platform === 'darwin') {
    const label = 'io.github.impartovo.' + name.toLowerCase(), domain = `gui/${options.uid ?? process.getuid()}`;
    const folder = path.join(options.home || os.homedir(), 'Library', 'LaunchAgents'), file = path.join(folder, label + '.plist');
    if (fs.existsSync(file)) {
      try { exec('/bin/launchctl', ['bootout', domain, file], { stdio: 'ignore', timeout: 10000 }); } catch (error) { if (enabled && ![3, 5].includes(error.status)) throw error; }
    }
    if (!slots.length) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else {
      fs.mkdirSync(folder, { recursive: true });
      fs.mkdirSync(paths(dataRoot).logs, { recursive: true, mode: 0o700 });
      const calendar = calendarIntervals(slots);
      const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, cli, 'tick', '--data', dataRoot].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>StartCalendarInterval</key><array>${calendar}</array>
<key>StandardOutPath</key><string>${xml(path.join(paths(dataRoot).logs, 'scheduler.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(paths(dataRoot).logs, 'scheduler-error.log'))}</string>
</dict></plist>`;
      fs.writeFileSync(file, plist, { mode: 0o600 });
      exec('/bin/launchctl', ['bootstrap', domain, file], { encoding: 'utf8', timeout: 10000 });
    }
    const monitorFile = path.join(folder, 'io.github.impartovo.' + monitor.name.toLowerCase() + '.plist');
    if (fs.existsSync(monitorFile)) {
      try { exec('/bin/launchctl', ['bootout', domain, monitorFile], { stdio: 'ignore', timeout: 10000 }); }
      catch (error) { if (monitor.enabled && ![3, 5].includes(error.status)) throw error; }
    }
    if (!monitor.enabled) { if (fs.existsSync(monitorFile)) fs.unlinkSync(monitorFile); }
    else {
      fs.mkdirSync(folder, { recursive: true }); fs.mkdirSync(paths(dataRoot).logs, { recursive: true, mode: 0o700 });
      fs.writeFileSync(monitorFile, monitorPlist(monitor, dataRoot), { mode: 0o600 });
      exec('/bin/launchctl', ['bootstrap', domain, monitorFile], { encoding: 'utf8', timeout: 10000 });
    }
  } else throw new Error('定时运行仅支持 Windows 和 macOS');
  return { collection: { name, enabled, slots }, monitor };
}
function register(dataRoot, enabled, tasks, options) {
  try { return install(dataRoot, enabled, tasks, options); }
  catch (error) {
    const log = path.join(paths(dataRoot).logs, 'scheduler-error.log');
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    fs.appendFileSync(log, new Date().toISOString() + ' ' + error.message + '\n', { mode: 0o600 });
    throw new Error(`系统未能${enabled ? '同步' : '移除'}定时运行，请检查当前用户的计划任务权限。详细原因已写入 scheduler-error.log。`);
  }
}
module.exports = { register, taskName, calendarIntervals, monitorRegistration, monitorPlist };
