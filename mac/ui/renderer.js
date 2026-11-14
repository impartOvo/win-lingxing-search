'use strict';
const $ = id => document.getElementById(id);
const api = window.desktop;
let bundle, selected = 0, variants = [], sortDescending = true;
const titles = { collect: ['采集条件', '设置商品、国家、店铺与日期，开始一次采集'], results: ['采集结果', '查看所选商品在指定时间段内的表现'], history: ['历史记录', '每条记录代表一次采集，可随时重新打开'], logs: ['运行日志', '查看本次采集进度与错误信息'] };
function show(page) {
  document.querySelectorAll('.page').forEach(node => { node.hidden = node.id !== page; });
  document.querySelectorAll('nav button').forEach(node => node.classList.toggle('active', node.dataset.page === page));
  $('heading').textContent = titles[page][0]; $('subtitle').textContent = titles[page][1];
}
function error(message) { $('error').textContent = message || ''; $('error').hidden = !message; }
function guarded(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(e => error(e.message)); }
const number = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const format = (v, digits = 0) => number(v) === null ? '—' : number(v).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rate = v => number(v) === null ? '—' : `${format(number(v) * 100, 2)}%`;
const set = (id, value) => { $(id).textContent = value; };
function dates(days) {
  const to = new Date(); to.setDate(to.getDate() - 1);
  const from = new Date(); from.setDate(from.getDate() - days);
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('from').value = iso(from); $('to').value = iso(to);
}
function fill(input, values) {
  const types = { ASIN: 'asin', 父ASIN: 'parent_asin', SKU: 'sku', MSKU: 'msku', FNSKU: 'fnsku', SPU: 'spu', 品名: 'name' };
  $('type').value = types[String(input.type).replaceAll(' ', '')] || input.type || 'asin';
  $('value').value = input.value || ''; $('match').value = ['精确', 'exact'].includes(input.match) ? 'exact' : 'fuzzy';
  $('country').value = input.country || ''; $('shop').value = input.shop || '';
  if (values?.length === 2) { $('from').value = values[0]; $('to').value = values[1]; }
}
function scope(row) { return (row.seller_store_countries || []).map(x => [x.seller_name, x.country].filter(Boolean).join(' · ')).join(' / ') || [bundle.summary.input.country || '全部国家', bundle.summary.input.shop || '全部店铺'].join(' · '); }
function identifier(row) { const field = { 父ASIN: 'parent_asin', ASIN: 'asin', MSKU: 'msku', SKU: 'sku', SPU: 'spu' }[bundle.summary.query?.tab]; return row[field] || row.parent_asin || row.asin || row.msku || row.sku || row.spu || bundle.summary.input.value; }
function table() {
  const body = $('variants').querySelector('tbody'); body.replaceChildren();
  for (const v of variants) {
    const tr = document.createElement('tr');
    for (const text of [v.local_name, v.seller_sku, v.local_sku, [v.seller_name, v.country].filter(Boolean).join(' · '), format(v.volume), format(v.price, 2)]) {
      const td = document.createElement('td'); td.textContent = text ?? '—'; tr.append(td);
    }
    body.append(tr);
  }
}
function renderRecord() {
  const row = bundle.rows[selected]; if (!row) return;
  const currency = row.currency_code || row.currency_icon || '';
  set('sales', format(row.volume)); set('amount', format(row.amount, 2)); set('amount-label', `销售额${currency ? ' · ' + currency : ''}`);
  set('return-rate', rate(row.return_goods_rate)); set('return-count', `退货量 ${format(row.return_goods_count)}`);
  set('ad-amount', format(row.ad_sales_amount, 2)); set('ad-label', `广告销售额${currency ? ' · ' + currency : ''}`);
  set('sessions', format(row.sessions_total)); set('views', format(row.page_views_total)); set('cvr', `转化率 ${rate(row.cvr)}`);
  set('fba', format(row.afn_fulfillable_quantity)); set('days', format(row.available_days));
  set('refund-count', format(row.return_count)); set('refund-rate', rate(row.return_rate));
  for (const [device, value] of [['browser', row.sessions], ['mobile', row.sessions_mobile]]) {
    const ratio = number(row.sessions_total) > 0 && number(value) !== null ? number(value) / number(row.sessions_total) : null;
    set(`${device}-count`, `${format(value)}${ratio !== null ? ' · ' + rate(ratio) : ''}`);
    $(`${device}-bar`).value = ratio === null ? 0 : Math.min(100, Math.max(0, ratio * 100));
  }
  set('product-name', row.local_name || (row.spu_spu_names || []).map(x => x.spu_name).filter(Boolean).join(' / ') || row.item_name || '未返回品名');
  set('scope', scope(row)); set('saved-at', `采集于 ${new Date(bundle.summary.fetchedAt).toLocaleString('zh-CN')} · 耗时 ${format(bundle.summary.elapsedMs / 1000, 1)} 秒`);
  variants = [...(row.price_list || [])]; table(); set('variant-count', `${variants.length} 条`);
  set('variant-note', variants.length ? `售价币种：${currency}。表格可横向滚动。` : '本次响应没有关联 MSKU 明细。');
}
function renderResult(value) {
  bundle = value; selected = 0;
  $('empty').hidden = value.rows.length > 0; $('result-content').hidden = !value.rows.length;
  $('record').replaceChildren();
  value.rows.forEach((row, index) => { const option = document.createElement('option'); option.value = index; option.textContent = `${identifier(row)} · ${scope(row)}`; $('record').append(option); });
  set('result-dates', `${(value.summary.dates || []).join(' — ')} · ${value.rows.length} 条商品记录`);
  renderRecord(); show('results');
}
function resetPage() {
  bundle = undefined; selected = 0; variants = []; sortDescending = true;
  $('query').reset();
  $('from').value = ''; $('to').value = '';
  $('record').replaceChildren(); $('variants').querySelector('tbody').replaceChildren();
  $('result-content').hidden = true; $('empty').hidden = false;
  $('empty').querySelector('h2').textContent = '还没有采集结果';
  $('log').textContent = '';
  error(''); status({ running: false, text: '就绪' }); show('collect');
}
async function reloadHistory() {
  const state = await api.state();
  set('history-count', `${state.history.length} 次成功采集 · 每次对应一组结果文件`);
  $('history-list').replaceChildren();
  for (const item of state.history) {
    const tr = document.createElement('tr');
    for (const text of [new Date(item.fetchedAt).toLocaleString('zh-CN'), `${item.input.type} · ${item.input.value}`, `${item.input.country || '全部国家'} · ${item.input.shop || '全部店铺'}`, (item.dates || []).join(' — '), item.count]) { const td = document.createElement('td'); td.textContent = String(text); tr.append(td); }
    const cell = document.createElement('td'), button = document.createElement('button'); button.textContent = '查看'; button.onclick = guarded(async () => renderResult(await api.readResult(item.name))); cell.append(button); tr.append(cell); $('history-list').append(tr);
  }
  return state;
}
window.reloadHistory = reloadHistory;
function status(value) { set('status', `● ${value.text}`); $('run').disabled = value.running; $('query-fields').disabled = value.running; $('reset-page').disabled = value.running; }
document.querySelectorAll('nav button').forEach(node => { node.onclick = guarded(async () => { show(node.dataset.page); if (node.dataset.page === 'history') await reloadHistory(); }); });
document.querySelectorAll('[data-days]').forEach(node => { node.onclick = () => dates(Number(node.dataset.days)); });
$('query').onsubmit = event => { event.preventDefault(); guarded(async () => { error(''); await api.collect(Object.fromEntries(['type', 'value', 'match', 'country', 'shop', 'from', 'to'].map(key => [key, $(key).value.trim()]))); })(); };
$('record').onchange = () => { selected = Number($('record').value); renderRecord(); };
$('edit-query').onclick = () => { fill(bundle.summary.input, bundle.summary.dates); show('collect'); };
$('reset-page').onclick = resetPage;
$('go-collect').onclick = () => show('collect'); $('view-logs').onclick = () => show('logs');
$('open-results').onclick = guarded(() => api.openFolder('results')); $('open-data').onclick = guarded(() => api.openFolder('data'));
$('open-json').onclick = guarded(() => api.openJSON()); $('refresh-history').onclick = guarded(reloadHistory);
$('sort-sales').onclick = () => { variants.sort((a, b) => ((number(a.volume) ?? -Infinity) - (number(b.volume) ?? -Infinity)) * (sortDescending ? -1 : 1)); sortDescending = !sortDescending; table(); };
api.onLog(text => { $('log').textContent += text + '\n'; $('log').scrollTop = $('log').scrollHeight; });
api.onStatus(status); api.onError(message => { error(message); show('logs'); });
api.onResult(value => { renderResult(value); reloadHistory().catch(e => error(e.message)); });
dates(30); show('collect');
guarded(async () => {
  const state = await reloadHistory(); status({ running: state.running, text: state.status }); $('log').textContent = state.logs.join('\n'); $('open-data').title = state.dataRoot;
  $('countries').replaceChildren(...state.countries.map(country => { const option = document.createElement('option'); option.value = country; return option; }));
  if (state.history.length) renderResult(await api.readResult(state.history[0].name));
  window.__uiReady = true;
})();
