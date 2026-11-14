'use strict';
titles.automation = ['自动化任务', '按星期和时间自动采集，多项任务同时运行'];
let automationState, automationId = null, automationBusy = false;
let automationRefreshing = false, automationRevision = 0, automationTasksJSON, automationRunsJSON;
const automationPeriods = { today: '今天', yesterday: '昨天', recent7: '近 7 天（含今天）', prev7: '前 7 天（截至昨天）', thisWeek: '本周（周一至今天）', lastWeek: '上周（周一至周日）', recent30: '近 30 天（含今天）', prev30: '前 30 天（截至昨天）', thisMonth: '本月（1 日至今天）', lastMonth: '上月（完整自然月）', custom: '固定日期区间' };
const automationLabel = state => ({ starting: '启动中', running: '运行中', ok: '成功', error: '失败' }[state] || '尚未运行');
const automationTime = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
function automationCells(body, values) {
  const tr = document.createElement('tr');
  for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
  body.append(tr); return tr;
}
function automationButton(cell, label, action) { const button = document.createElement('button'); button.textContent = label; button.onclick = guarded(action); cell.append(button); }
function automationFill(task) {
  automationId = task?.id || null;
  $('a-form').reset(); set('a-editor-heading', task ? '编辑任务' : '新建任务');
  for (const key of ['name', 'value', 'country', 'shop', 'from', 'to']) $(`a-${key}`).value = task?.[key] || '';
  const types = { ASIN: 'asin', 父ASIN: 'parent_asin', SKU: 'sku', MSKU: 'msku', FNSKU: 'fnsku', SPU: 'spu', 品名: 'name' };
  $('a-type').value = types[task?.type] || 'asin'; $('a-match').value = ['exact', '精确'].includes(task?.match) ? 'exact' : 'fuzzy';
  $('a-time').value = task?.time || '09:00'; $('a-enabled').checked = task?.enabled !== false;
  $('a-period').value = task?.period || 'prev30'; $('a-fixed').hidden = $('a-period').value !== 'custom';
  $('a-form').querySelectorAll('[name=weekday]').forEach(node => { node.checked = (task?.days || [1, 2, 3, 4, 5, 6]).includes(Number(node.value)); });
}
function automationRender(state) {
  automationState = state;
  set('a-status', `${state.enabled ? '定时运行已启用' : '定时已暂停'} · 当前运行 ${state.running} 项`);
  set('a-schedule', state.enabled ? '暂停定时运行' : '启用定时运行');
  const tasksJSON = JSON.stringify(state.tasks), runsJSON = JSON.stringify(state.runs);
  if (automationTasksJSON !== tasksJSON) {
    $('a-tasks').replaceChildren();
    for (const task of state.tasks) {
      const row = automationCells($('a-tasks'), [task.name, task.enabled ? '启用' : '停用', [task.value, task.country || '全部国家', task.shop || '全部店铺'].join(' · '), task.periodLabel, task.scheduleLabel, automationTime(task.nextAt), automationLabel(task.latest?.status)]);
      const cell = document.createElement('td'); row.append(cell);
      automationButton(cell, '编辑', () => { automationFill(task); $('a-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
      automationButton(cell, '立即运行', () => automationRequest({ action: 'run', ids: [task.id] }));
      automationButton(cell, '删除', async () => { await automationRequest({ action: 'delete-task', id: task.id }); if (automationId === task.id) automationFill(); });
    }
    automationTasksJSON = tasksJSON;
  }
  if (automationRunsJSON !== runsJSON) {
    $('a-runs').replaceChildren();
    for (const run of state.runs) {
      const row = automationCells($('a-runs'), [run.taskName, automationLabel(run.status), automationTime(run.createdAt), `${run.dates.from} — ${run.dates.to}`, run.error || (run.trigger === 'schedule' ? '定时触发' : '手动触发')]);
      const cell = document.createElement('td'); row.append(cell);
      if (run.status === 'ok') automationButton(cell, '查看结果', async () => renderResult(await api.readResult(run.resultName)));
      automationButton(cell, '日志', () => api.automationLog(run.id));
    }
    automationRunsJSON = runsJSON;
  }
}
async function automationRequest(request = { action: 'snapshot' }) {
  const refreshing = request.action === 'snapshot';
  if (refreshing && (automationRefreshing || automationBusy)) return;
  if (!refreshing && automationBusy) throw new Error('正在处理操作，请稍后重试');
  if (refreshing) automationRefreshing = true;
  else { automationBusy = true; automationRevision++; for (const id of ['a-save', 'a-schedule', 'a-run-all']) $(id).disabled = true; }
  const revision = automationRevision;
  try {
    const state = await api.automation(request);
    if (refreshing && (revision !== automationRevision || automationBusy)) return;
    automationRender(state);
    if (!refreshing) set('a-notice', '操作完成。任务按已保存的条件执行，可在下方查看运行记录。');
  } catch (error) { if (!refreshing || (revision === automationRevision && !automationBusy)) throw error; }
  finally {
    if (refreshing) automationRefreshing = false;
    else { automationBusy = false; for (const id of ['a-save', 'a-schedule', 'a-run-all']) $(id).disabled = false; }
  }
}
$('a-type').replaceChildren(...[...$('type').options].map(option => option.cloneNode(true)));
$('a-period').replaceChildren(...Object.entries(automationPeriods).map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; }));
automationFill();
$('a-period').onchange = () => { $('a-fixed').hidden = $('a-period').value !== 'custom'; };
$('a-new').onclick = () => automationFill();
$('a-refresh').onclick = guarded(() => automationRequest());
$('a-schedule').onclick = guarded(() => automationRequest({ action: 'schedule', enabled: !automationState?.enabled }));
$('a-run-all').onclick = guarded(() => automationRequest({ action: 'run' }));
$('a-form').onsubmit = event => {
  event.preventDefault();
  const task = Object.fromEntries(['name', 'type', 'value', 'match', 'country', 'shop', 'period', 'from', 'to', 'time'].map(key => [key, $(`a-${key}`).value]));
  task.id = automationId || crypto.randomUUID();
  task.enabled = $('a-enabled').checked;
  task.days = [...$('a-form').querySelectorAll('[name=weekday]:checked')].map(node => Number(node.value));
  guarded(async () => {
    await automationRequest({ action: 'save-task', task });
    // Keep editing the saved task, including a newly assigned ID.
    const saved = automationState.tasks.find(t => t.id === task.id);
    if (saved) automationFill(saved);
  })();
};
$('a-use-current').onclick = () => {
  for (const key of ['type', 'value', 'match', 'country', 'shop', 'from', 'to']) $(`a-${key}`).value = $(key).value;
  if ($('from').value && $('to').value) { $('a-period').value = 'custom'; $('a-fixed').hidden = false; }
};
document.querySelector('[data-page=automation]').addEventListener('click', guarded(() => automationRequest()));
setInterval(() => { if (!$('automation').hidden && !automationBusy) guarded(() => automationRequest())(); }, 4000);
