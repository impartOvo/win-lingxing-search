'use strict';
titles.monitor = ['监控提醒', '及时发现 FBA 库存不足与待回复站内信。'];
const feature = (module, request) => api.feature({ module, request });
const lines = value => [...new Set(value.split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
const bind = (id, fn) => { $(id).onclick = guarded(fn); };
const cellButton = (cell, label, fn) => automationButton(cell, label, fn);
let monitorState, monitorBusy = false, monitorRefreshing = false, ruleId, previewPacket, authorizedScopes;

function updateFeatureGroups(state) {
  const select = $('a-group-filter'), previous = select.value;
  const groups = [...new Set(state.tasks.map(task => task.group).filter(Boolean))].sort();
  if (JSON.stringify(groups) !== select.dataset.groups) {
    select.replaceChildren(new Option('全部任务组', ''), ...groups.map(group => new Option(group, group)));
    select.value = groups.includes(previous) ? previous : ''; select.dataset.groups = JSON.stringify(groups);
  }
}
function batchInput() {
  const task = Object.fromEntries(['name', 'group', 'type', 'value', 'match', 'country', 'shop', 'period', 'from', 'to', 'time', 'source', 'currency'].map(key => [key, $(`a-${key}`).value]));
  task.name = $('batch-group').value.trim(); task.enabled = $('a-enabled').checked;
  task.days = [...$('a-form').querySelectorAll('[name=weekday]:checked')].map(node => Number(node.value));
  return { task, values: lines($('batch-values').value), countries: lines($('batch-countries').value), group: $('batch-group').value.trim() };
}
async function dashboard() {
  const value = await feature('automation', { action: 'dashboard' });
  set('a-dashboard', `今日应执行 ${value.expected} · 成功 ${value.success} · 失败 ${value.failed} · 运行中 ${value.running} · 未发现运行记录 ${value.missing}`);
}
bind('a-dashboard-refresh', dashboard);
bind('a-batch-open', () => { $('a-editor').hidden = false; $('a-batch').hidden = false; $('a-editor').scrollIntoView({ behavior: 'smooth' }); });
bind('a-batch-close', () => { $('a-batch').hidden = true; });
bind('a-clone', () => { const task = taskSelected(); if (!task) throw new Error('请先选择任务。'); editTask({ ...task, id: null, name: `${task.name} · 副本` }); });
$('a-group-filter').onchange = () => { if (automationState) renderTaskWorkbench(automationState); };
for (const [id, enabled] of [['a-group-on', true], ['a-group-off', false]]) bind(id, async () => {
  const ids = (automationState?.tasks || []).filter(task => !$('a-group-filter').value || task.group === $('a-group-filter').value).map(task => task.id);
  if (!ids.length) throw new Error('当前任务组没有任务。');
  await automationRequest({ action: 'set-enabled', ids, enabled });
});
const civilToday = new Date();
$('a-backfill-date').value = `${civilToday.getFullYear()}-${String(civilToday.getMonth()+1).padStart(2,'0')}-${String(civilToday.getDate()).padStart(2,'0')}`;
bind('a-backfill', async () => { if (!selectedTaskId) throw new Error('请先选择任务。'); await automationRequest({ action: 'backfill', ids: [selectedTaskId], scheduledDate: $('a-backfill-date').value }); await dashboard(); });
bind('batch-preview', async () => {
  const packet = batchInput(); previewPacket = null;
  const result = await feature('automation', { action: 'batch-preview', ...packet });
  $('batch-list').replaceChildren();
  for (const task of result.tasks) automationCells($('batch-list'), [task.name, task.value, task.country || '全部国家', task.time, task.source === 'mcp' ? 'MCP' : '浏览器']);
  previewPacket = packet; set('batch-notice', `共 ${result.count} 项。请核对任务编辑器中的日期、通道、星期与时间后保存。`);
});
bind('batch-save', async () => {
  if (!previewPacket || JSON.stringify(previewPacket) !== JSON.stringify(batchInput())) throw new Error('条件已变化或尚未预览，请先重新预览。');
  await automationRequest({ action: 'save-batch', ...previewPacket }); previewPacket = null; set('batch-notice', '全部计划已保存。'); await dashboard();
});

async function loadScopes() {
  set('scope-notice', '正在读取 MCP 授权范围…');
  authorizedScopes = await feature('mcp', { action: 'options' });
  $('countries').replaceChildren(...[...new Set(authorizedScopes.markets.map(m => m.country))].map(country => new Option(country, country)));
  for (const prefix of ['', 'a-', 'r-']) applyScopes(prefix);
  set('scope-notice', `已加载 ${authorizedScopes.markets.length} 个站点、${authorizedScopes.sellers.length} 家授权店铺。`);
}
function applyScopes(prefix) {
  if (!authorizedScopes) return;
  const country = $(`${prefix}country`).value.trim(), market = authorizedScopes.markets.find(item => item.country === country);
  const sellers = authorizedScopes.sellers.filter(item => !country || String(item.country_id) === String(market?.country_id));
  const datalist = $(prefix ? `${prefix}shops` : 'shops');
  datalist.replaceChildren(...[...new Set(sellers.map(item => item.seller_simple_name))].map(name => new Option(name, name)));
  $(`${prefix}shop`).title = `授权店铺；统计币种：${[...new Set(sellers.map(item => item.currency_code).filter(Boolean))].join(' / ')}`;
}
bind('scope-load', loadScopes);
for (const prefix of ['', 'a-', 'r-']) $(`${prefix}country`).addEventListener('input', () => applyScopes(prefix));

async function loadFeatureHistory() {
  const filters = Object.fromEntries(['search','country','shop','source','from','to'].map(key => [key, $(`h-${key}`).value.trim()]));
  const result = await feature('data', { action: 'history', filters });
  set('history-count', `${result.count} 次采集符合当前条件`); $('history-list').replaceChildren();
  for (const item of result.items) {
    const row = automationCells($('history-list'), [automationTime(item.savedAt), `${item.type} · ${item.value}`, `${item.country || '全部国家'} · ${item.shop || '全部店铺'}`, `${item.from} — ${item.to}`, `${item.source === 'mcp' ? 'MCP' : '浏览器'} · ${item.currency || item.currencies?.join(' / ') || '见记录'}`, item.count, item.quality.warnings.join('；'), '']);
    cellButton(row.cells[7], '查看', async () => renderResult(await api.readResult(item.name)));
    cellButton(row.cells[7], '导出', async () => {
      const exported = await feature('data', { action: 'export', name: item.name, format: $('h-format').value });
      set('h-notice', `导出完成：${exported.path}`); await api.openExport(exported.path);
    });
  }
  for (const [id, fallback] of [['compare-left', 0], ['compare-right', 1]]) {
    const select = $(id), previous = select.value;
    select.replaceChildren(...result.items.map(item => new Option(`${automationTime(item.savedAt)} · ${item.value} · ${item.country || '全部国家'} · ${item.shop || '全部店铺'}`, item.name)));
    select.value = result.items.some(item => item.name === previous) ? previous : result.items[Math.min(fallback, result.items.length - 1)]?.name || '';
  }
}
bind('h-filter', loadFeatureHistory);
bind('h-clear', async () => { for (const key of ['search','country','shop','source','from','to']) $(`h-${key}`).value = ''; await loadFeatureHistory(); });
async function analyze(compare) {
  const request = compare ? { action: 'compare', leftName: $('compare-left').value, rightName: $('compare-right').value } : { action: 'daily' };
  if (compare && (!request.leftName || !request.rightName)) throw new Error('请先选择两次采集。');
  const result = await feature('data', request); $('data-list').replaceChildren();
  for (const item of result.items) for (const [key, label] of [['volume','销量'],['amount','销售额'],['sessions_total','会话数']]) {
    const metric = item.metrics[key];
    automationCells($('data-list'), [compare ? '跨期比较' : item.date, `${item.entity} · ${item.country || ''} · ${item.shop || ''} · ${item.grain}${compare ? '' : ` · ${item.source === 'mcp' ? 'MCP' : '浏览器'} · 采集于 ${automationTime(item.savedAt)}`}`, item.currency || '—', label, format(compare ? metric?.left : metric, 2), compare ? format(metric?.right,2) : '', compare ? format(metric?.delta,2) : '']);
  }
  set('data-notice', `${compare ? result.comparable ? '范围与币种兼容。' : '两次采集不适合直接比较。' : `只采用单个自然日，跳过 ${result.skippedRolling} 次期间汇总。`}${result.warnings.join('；')}`);
}
bind('data-compare', () => analyze(true)); bind('data-daily', () => analyze(false));

function fillRule(rule) {
  ruleId = rule?.id || null; $('r-form').reset();
  const types = { ASIN:'asin', 父ASIN:'parent_asin', SKU:'sku', MSKU:'msku', FNSKU:'fnsku', SPU:'spu', 品名:'name' };
  $('r-type').value = types[rule?.type] || rule?.type || 'msku';
  for (const key of ['name','value','country','shop']) $(`r-${key}`).value = rule?.[key] || '';
  $('r-threshold').value = rule?.threshold ?? 10; $('r-cooldown').value = rule?.cooldownMinutes ?? 120; $('r-enabled').checked = rule?.enabled !== false;
  applyScopes('r-');
}
$('r-type').replaceChildren(...[...$('type').options].map(option => option.cloneNode(true))); fillRule();
function renderMonitor(state, settings) {
  monitorState = state; const config = state.config;
  if (settings) { $('n-enabled').checked = config.enabled; $('n-mail-enabled').checked = config.mail.enabled; $('n-inventory-interval').value = config.inventoryIntervalMinutes; $('n-mail-interval').value = config.mail.intervalMinutes; $('n-mail-repeat').value = config.mail.repeatMinutes; }
  set('n-status', `${config.enabled ? '后台监控已启用' : '后台监控已暂停'} · 库存检查 ${automationTime(state.lastCheck.inventory)} · 站内信检查 ${automationTime(state.lastCheck.mail)}${state.errors.length ? `\n${state.errors.map(item=>item.message).join('；')}` : ''}`);
  $('r-list').replaceChildren();
  for (const rule of config.inventoryRules) {
    const row = automationCells($('r-list'), [rule.name, `${rule.type} · ${rule.value} · ${rule.country || '全部国家'} · ${rule.shop || '全部店铺'}`, rule.threshold, rule.enabled ? '启用' : '停用', '']);
    cellButton(row.cells[4], '编辑', () => fillRule(rule));
  }
  $('n-events').replaceChildren();
  for (const event of state.events) {
    const row = automationCells($('n-events'), [{ inventory:'库存', mail:'站内信', error:'异常' }[event.kind] || event.kind, `${event.title}\n${event.message}`, event.state === 'resolved' ? '已恢复' : event.unread ? '待查看' : '已查看', automationTime(event.updatedAt), '']);
    cellButton(row.cells[4], '已查看', () => monitorAction({ action:'mark-read', ids:[event.id] }));
    cellButton(row.cells[4], '稍后提醒', () => monitorAction({ action:'snooze', ids:[event.id], minutes:60 }));
    if (event.target) cellButton(row.cells[4], '打开领星', () => api.openTarget(event.target));
  }
}
async function refreshMonitor() {
  if (monitorBusy || monitorRefreshing) return; monitorRefreshing = true;
  try { const state = await feature('monitoring', { action:'snapshot' }); if (!monitorBusy) renderMonitor(state, !monitorState); }
  finally { monitorRefreshing = false; }
}
async function monitorAction(request) {
  if (monitorBusy) throw new Error('正在保存或检查，请等待当前操作完成。'); monitorBusy = true;
  const editing = [...document.querySelectorAll('#r-form input,#r-form select,#r-form button,#r-list button'), $('r-new')];
  for (const node of editing) node.disabled = true;
  for (const id of ['n-save','n-check','r-delete']) $(id).disabled = true;
  try { set('n-notice','正在处理…'); renderMonitor(await feature('monitoring',request),true); set('n-notice','操作完成。读取异常与提醒见监控状态。'); }
  catch (e) { await feature('monitoring',{action:'snapshot'}).then(state=>renderMonitor(state,true)).catch(()=>{}); throw e; }
  finally { monitorBusy = false; for (const node of editing) node.disabled = false; for (const id of ['n-save','n-check','r-delete']) $(id).disabled = false; }
}
function monitorConfig() {
  if (!monitorState) throw new Error('请先等待设置读取完成。');
  return { ...monitorState.config, enabled:$('n-enabled').checked, inventoryIntervalMinutes:Number($('n-inventory-interval').value), mail:{ enabled:$('n-mail-enabled').checked, intervalMinutes:Number($('n-mail-interval').value), repeatMinutes:Number($('n-mail-repeat').value) }, inventoryRules:[...monitorState.config.inventoryRules] };
}
bind('n-refresh',refreshMonitor); bind('n-check',()=>monitorAction({action:'tick',force:true})); bind('n-save',()=>monitorAction({action:'save',config:monitorConfig()}));
bind('r-new',()=>fillRule());
$('r-form').onsubmit = event => { event.preventDefault(); guarded(async()=>{
  const config=monitorConfig(), id=ruleId || crypto.randomUUID();
  config.inventoryRules=config.inventoryRules.filter(rule=>rule.id!==id);
  config.inventoryRules.push({id, ...Object.fromEntries(['name','type','value','country','shop'].map(key=>[key,$(`r-${key}`).value.trim()])),enabled:$('r-enabled').checked,threshold:Number($('r-threshold').value),cooldownMinutes:Number($('r-cooldown').value)});
  await monitorAction({action:'save',config}); ruleId=id;
})(); };
bind('r-delete',async()=>{ if(!ruleId) throw new Error('请先编辑要删除的规则。');const config=monitorConfig();config.inventoryRules=config.inventoryRules.filter(rule=>rule.id!==ruleId);await monitorAction({action:'save',config});fillRule(); });
document.querySelector('[data-page=monitor]').addEventListener('click',guarded(refreshMonitor));
document.querySelector('[data-page=automation]').addEventListener('click',guarded(()=>api.feature ? dashboard() : undefined));
setInterval(()=>{ if(!api.feature)return;if(!$('monitor').hidden)guarded(refreshMonitor)();if(!$('automation').hidden)guarded(dashboard)(); },15000);
