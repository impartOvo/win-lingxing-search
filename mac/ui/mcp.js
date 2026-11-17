'use strict';
titles.mcp = ['连接设置', '配置领星连接，让软件独立读取产品表现'];
let mcpBusy = false;
function renderMcp(state) {
  $('m-url').value = state.url; $('m-header').value = state.header; $('m-transport').value = state.transport;
  set('m-saved', state.configured ? '已保存密钥（不回显）。密钥框留空表示保留已保存密钥。' : '尚未配置；浏览器采集可继续使用。');
}
async function requestMcp(action) {
  if (mcpBusy) return;
  mcpBusy = true;
  const buttons = ['m-save', 'm-import', 'm-test'].map($); buttons.forEach(b => { b.disabled = true; });
  try {
    set('m-notice', '正在处理…');
    const request = action === 'save' ? { action, url: $('m-url').value, key: $('m-key').value, header: $('m-header').value, transport: $('m-transport').value } : { action };
    const state = await api.mcp(request);
    $('m-key').value = ''; renderMcp(state);
    set('m-notice', action === 'test' ? `连接成功 · 国家 ${state.countries} · 店铺 ${state.shops} · 产品表现查询已就绪` : '连接已保存，原任务通道保持不变。');
  } catch (error) { set('m-notice', error.message); throw error;
  } finally { mcpBusy = false; buttons.forEach(b => { b.disabled = false; }); }
}
$('m-form').onsubmit = event => { event.preventDefault(); guarded(() => requestMcp('save'))(); };
$('m-save').onclick = guarded(() => requestMcp('save'));
$('m-import').onclick = guarded(() => requestMcp('import-codex'));
$('m-test').onclick = guarded(() => requestMcp('test'));
document.querySelector('[data-page=mcp]').addEventListener('click', guarded(async () => { if (!mcpBusy) renderMcp(await api.mcp({ action: 'status' })); }));
