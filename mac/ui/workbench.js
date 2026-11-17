'use strict';
let selectedTaskId, taskFilter = 'all', renderedTaskFilter;
function details(list, values) {
  list.replaceChildren();
  for (const [label, value] of values) {
    const term = document.createElement('dt'), definition = document.createElement('dd');
    term.textContent = label; definition.textContent = value || '—'; list.append(term, definition);
  }
}
function queryPreview() {
  details($('query-preview'), [['商品', $('value').value], ['国家', $('country').value || '全部国家'], ['店铺', $('shop').value || '全部店铺'], ['日期', `${$('from').value} — ${$('to').value}`], ['通道', $('source').value === 'mcp' ? 'MCP' : '浏览器'], ['输出', 'JSON']]);
  $('currency').disabled = $('source').value !== 'mcp' || $('run').disabled;
}
function collectPeriod() {
  const period = $('collect-period').value;
  const iso = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const shifted = (value, days) => { const next = new Date(value); next.setDate(next.getDate() + days); return next; };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const monday = shifted(today, -((today.getDay() + 6) % 7)), month = new Date(today.getFullYear(), today.getMonth(), 1);
  const ranges = { today: [today, today], yesterday: [shifted(today, -1), shifted(today, -1)], recent7: [shifted(today, -6), today], prev7: [shifted(today, -7), shifted(today, -1)], recent30: [shifted(today, -29), today], prev30: [shifted(today, -30), shifted(today, -1)], thisWeek: [monday, today], lastWeek: [shifted(monday, -7), shifted(monday, -1)], thisMonth: [month, today], lastMonth: [new Date(today.getFullYear(), today.getMonth() - 1, 1), shifted(month, -1)] };
  if (ranges[period]) [$('from').value, $('to').value] = ranges[period].map(iso);
  set('collect-date-note', period === 'custom' ? '使用固定日期；定时任务会保留这个区间。' : `${['prev7', 'prev30'].includes(period) ? '截至昨天，不包含今天。' : '按本机时区计算。'}定时任务每次自动更新日期。`);
  queryPreview();
}
function resultTab(tab) {
  for (const key of ['records', 'info', 'json']) $(`result-${key}`).hidden = tab !== key;
  document.querySelectorAll('[data-result-tab]').forEach(node => node.setAttribute('aria-selected', String(node.dataset.resultTab === tab)));
}
function resultInformation(value) {
  const summary = value.summary, input = summary.input;
  set('result-info', `查询条件  ${input.type} / ${input.value}\n\n国家 / 店铺  ${input.country || '全部国家'} / ${input.shop || '全部店铺'}\n\n数据日期  ${(summary.dates || []).join(' — ')}\n\n采集时间  ${new Date(summary.fetchedAt).toLocaleString('zh-CN')}\n\n采集通道  ${summary.method === 'mcp' ? 'MCP' : '浏览器'}\n\n统计币种  ${input.currency || value.rows[0]?.currency_code || '见记录字段'}\n\n商品记录  ${value.rows.length}\n\n结果文件  ${value.name}\n\n数据文件  ${value.dataName}`);
  set('result-json', JSON.stringify(value.payload, null, 2)); resultTab('records');
}
function taskSelected() { return automationState?.tasks.find(task => task.id === selectedTaskId); }
function taskInspector() {
  const task = taskSelected(), run = task?.latest;
  for (const id of ['a-detail-edit', 'a-detail-run-now', 'a-detail-delete']) $(id).disabled = !task;
  $('a-detail-result').disabled = run?.status !== 'ok'; $('a-detail-log').disabled = !run;
  set('a-detail-name', task?.name || '暂无所选任务');
  set('a-detail-scope', task ? `${task.type} · ${task.value}\n${task.country || '全部国家'} · ${task.shop || '全部店铺'}` : '');
  const status = run?.status || '';
  set('a-detail-state', task ? `${task.enabled ? '' : '任务已停用 · 最近'}${automationLabel(status)}` : '选择任务查看详情');
  $('a-detail-state').className = `state ${status}`;
  const elapsed = run?.finishedAt && run?.startedAt ? `${format((new Date(run.finishedAt) - new Date(run.startedAt)) / 1000, 1)} 秒` : ['starting', 'running'].includes(status) ? '进行中' : '—';
  details($('a-detail-meta'), task ? [['数据日期', task.periodLabel], ['采集通道', task.source === 'mcp' ? 'MCP' : '浏览器'], ['最近耗时', elapsed], ['下次运行', !task.enabled ? '任务已停用' : automationState.enabled ? automationTime(task.nextAt) : '定时已暂停']] : []);
  set('a-detail-run', run ? `开始  ${automationTime(run.createdAt)}\n数据  ${run.dates.from} — ${run.dates.to}\n${status === 'ok' ? '采集完成，结果已保存。' : status === 'error' ? '采集失败，请查看下方原因。' : '后台采集中，可查看最近日志。'}` : '尚无运行记录。');
  set('a-detail-error', run?.error || ''); $('a-detail-error').hidden = !run?.error;
  document.querySelectorAll('#a-tasks tr[data-id]').forEach(row => row.setAttribute('aria-selected', String(row.dataset.id === selectedTaskId)));
}
function renderTaskWorkbench(state) {
  const changed = automationTasksJSON !== JSON.stringify(state.tasks) || renderedTaskFilter !== taskFilter;
  if (changed) {
    const tasks = state.tasks.filter(task => taskFilter === 'all' || (taskFilter === 'enabled' ? task.enabled : !task.enabled));
    if (!tasks.some(task => task.id === selectedTaskId)) selectedTaskId = tasks[0]?.id;
    $('a-tasks').replaceChildren();
    for (const task of tasks) {
      const row = automationCells($('a-tasks'), ['', '', '', task.source === 'mcp' ? 'MCP' : '浏览器']); row.dataset.id = task.id;
      const name = document.createElement('button'); name.className = 'task-name'; name.textContent = task.name;
      const scope = document.createElement('small'); scope.textContent = `${task.country || '全部国家'} · ${task.shop || '全部店铺'} · ${task.periodLabel}`;
      row.cells[0].append(name, scope);
      const time = document.createElement('span'), days = document.createElement('small'); time.textContent = task.time; days.textContent = task.days.length === 7 ? '每天' : task.days.map(day => ['日', '一', '二', '三', '四', '五', '六'][day]).join(' '); row.cells[1].append(time, days);
      const status = document.createElement('span'); status.className = `state ${task.latest?.status || ''}`; status.textContent = task.enabled ? automationLabel(task.latest?.status) : '已停用'; row.cells[2].append(status);
      row.onclick = () => { selectedTaskId = task.id; taskInspector(); };
    }
    if (!tasks.length) { const row = automationCells($('a-tasks'), ['没有符合条件的任务']); row.cells[0].colSpan = 4; }
    set('a-task-count', `${tasks.length} / ${state.tasks.length} 项任务`);
    automationTasksJSON = JSON.stringify(state.tasks); renderedTaskFilter = taskFilter;
  }
  taskInspector();
}
function editTask(task) { automationFill(task); $('a-editor').hidden = false; $('a-editor').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('a-name').focus(); }
async function showAutomationLog(id) { set('log', await api.automationLog(id)); show('logs'); }
$('collect-period').replaceChildren(...Object.entries(automationPeriods).map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
$('collect-period').value = 'prev30'; $('collect-period').onchange = collectPeriod;
$('query').addEventListener('input', queryPreview); $('query').addEventListener('change', queryPreview);
for (const id of ['from', 'to']) $(id).addEventListener('change', () => { $('collect-period').value = 'custom'; collectPeriod(); });
document.querySelectorAll('[data-days]').forEach(node => { node.onclick = () => { $('collect-period').value = `prev${node.dataset.days}`; collectPeriod(); }; });
document.querySelectorAll('[data-result-tab]').forEach(node => { node.onclick = () => resultTab(node.dataset.resultTab); });
document.querySelectorAll('[data-task-filter]').forEach(node => { node.onclick = () => { taskFilter = node.dataset.taskFilter; document.querySelectorAll('[data-task-filter]').forEach(button => button.setAttribute('aria-selected', String(button === node))); if (automationState) renderTaskWorkbench(automationState); }; });
$('a-new').onclick = () => editTask(); $('a-editor-close').onclick = () => { $('a-editor').hidden = true; };
$('a-detail-edit').onclick = () => editTask(taskSelected());
$('a-detail-result').onclick = guarded(async () => { if (taskSelected()?.latest?.status === 'ok') renderResult(await api.readResult(taskSelected().latest.resultName)); });
$('a-detail-log').onclick = guarded(() => showAutomationLog(taskSelected().latest.id));
$('a-detail-run-now').onclick = guarded(() => automationRequest({ action: 'run', ids: [selectedTaskId] }));
$('a-detail-delete').onclick = guarded(async () => { await automationRequest({ action: 'delete-task', id: selectedTaskId }); $('a-editor').hidden = true; });
$('collect-schedule').onclick = guarded(async () => { show('automation'); await automationRequest(); editTask(); $('a-use-current').click(); $('a-period').value = $('collect-period').value; $('a-fixed').hidden = $('a-period').value !== 'custom'; $('a-name').value = $('value').value; });
$('browser-collect').onclick = () => { $('source').value = 'browser'; queryPreview(); show('collect'); };
set('a-timezone', `本机时区 · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
queryPreview();
