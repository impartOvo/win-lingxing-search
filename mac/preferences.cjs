'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomicJson } = require('../automation/core.cjs');
const file = root => path.join(root, '.private', 'app-settings.json');
function read(root) {
  const saved = fs.existsSync(file(root)) ? JSON.parse(fs.readFileSync(file(root), 'utf8')) : {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('应用设置格式无效。');
  return { ...saved, version: 1, closeToTray: saved.closeToTray === true };
}
function save(root, request) {
  if (!request || typeof request.closeToTray !== 'boolean') throw new Error('后台运行开关无效。');
  const settings = { ...read(root), closeToTray: request.closeToTray };
  atomicJson(file(root), settings); return settings;
}
module.exports = { read, save };
