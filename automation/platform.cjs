'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { paths } = require('./core.cjs');
const taskName = dataRoot => 'LingxingSearch-Automation-' + crypto.createHash('sha256').update(path.resolve(dataRoot)).digest('hex').slice(0, 12);
function install(dataRoot, enabled) {
  const name = taskName(dataRoot), cli = path.join(__dirname, 'cli.cjs');
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'register-windows.ps1'),
      '-TaskName', name, '-NodePath', process.execPath, '-CliPath', cli, '-DataRoot', dataRoot, '-Mode', enabled ? 'enable' : 'disable'],
    { windowsHide: true, encoding: 'utf8', timeout: 25000 });
  } else if (process.platform === 'darwin') {
    const label = 'io.github.impartovo.' + name.toLowerCase(), domain = `gui/${process.getuid()}`;
    const folder = path.join(os.homedir(), 'Library', 'LaunchAgents'), file = path.join(folder, label + '.plist');
    if (fs.existsSync(file)) {
      try { execFileSync('/bin/launchctl', ['bootout', domain, file], { stdio: 'ignore', timeout: 10000 }); } catch (error) { if (enabled && ![3, 5].includes(error.status)) throw error; }
    }
    if (!enabled) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
    fs.mkdirSync(folder, { recursive: true });
    fs.mkdirSync(paths(dataRoot).logs, { recursive: true, mode: 0o700 });
    const xml = v => String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const calendar = Array.from({ length: 60 }, (_, minute) => `<dict><key>Minute</key><integer>${minute}</integer></dict>`).join('');
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[process.execPath, cli, 'tick', '--data', dataRoot].map(v => `<string>${xml(v)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string></dict><key>StartCalendarInterval</key><array>${calendar}</array>
<key>StandardOutPath</key><string>${xml(path.join(paths(dataRoot).logs, 'scheduler.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(paths(dataRoot).logs, 'scheduler-error.log'))}</string>
</dict></plist>`;
    fs.writeFileSync(file, plist, { mode: 0o600 });
    execFileSync('/bin/launchctl', ['bootstrap', domain, file], { encoding: 'utf8', timeout: 10000 });
  } else throw new Error('定时运行仅支持 Windows 和 macOS');
}
function register(dataRoot, enabled) {
  try { install(dataRoot, enabled); }
  catch (error) {
    const log = path.join(paths(dataRoot).logs, 'scheduler-error.log');
    fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
    fs.appendFileSync(log, new Date().toISOString() + ' ' + error.message + '\n', { mode: 0o600 });
    throw new Error(`系统未能${enabled ? '启用' : '移除'}定时运行，请检查当前用户的计划任务权限。详细原因已写入 scheduler-error.log。`);
  }
}
module.exports = { register, taskName };
