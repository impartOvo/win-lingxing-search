'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PRIVATE, RESULTS, PAGE_URL, DATA_HOSTS, args, validate, mkdirs, saveJson, businessHash, summary } = require('./shared');

async function choosePeriod(page, period) {
  await page.getByPlaceholder('开始日期').click();
  const popover = page.locator('.el-popover:visible').filter({ hasText: period }).first();
  await popover.getByText(period, { exact: true }).click();
  await page.waitForTimeout(400);
  const dates = await page.locator('input[placeholder="开始日期"], input[placeholder="结束日期"]').evaluateAll(els => els.map(el => el.value));
  if (dates.length !== 2 || dates.some(x => !x)) throw new Error('日期没有成功应用');
  return dates;
}

async function chooseDates(page, from, to) {
  await page.getByPlaceholder('开始日期').click();
  const picker = page.locator('.el-date-range-picker:visible').first();
  await picker.waitFor({ state: 'visible' });
  const targetMonth = date => Number(date.slice(0,4)) * 12 + Number(date.slice(5,7)) - 1;
  const panelMonth = async side => {
    const label = await picker.locator(`.${side} .el-date-range-picker__header div`).innerText();
    const match = label.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (!match) throw new Error(`无法识别日期面板月份：${label}`);
    return Number(match[1]) * 12 + Number(match[2]) - 1;
  };
  for (let n = 0; n < 120 && await panelMonth('is-left') !== targetMonth(from); n++) {
    if (await panelMonth('is-left') > targetMonth(from)) await picker.locator('.is-left .el-date-range-picker__header button.arrow-left.ak-rotate-90').click();
    else await picker.locator('.is-right .el-date-range-picker__header button.arrow-right.ak-rotate-270').click();
  }
  if (await panelMonth('is-left') !== targetMonth(from)) throw new Error('无法定位开始月份');
  const selectDay = async (side, date) => {
    const day = Number(date.slice(8,10));
    await picker.locator(`.${side} .el-date-table td.available:not(.prev-month):not(.next-month)`)
      .filter({ hasText: new RegExp(`^\\s*${day}\\s*$`) }).first().click();
  };
  await selectDay('is-left', from);
  for (let n = 0; n < 120; n++) {
    const left = await panelMonth('is-left');
    const right = await panelMonth('is-right');
    if (targetMonth(to) === left || targetMonth(to) === right) break;
    if (targetMonth(to) < right) {
      await picker.locator('.is-left .el-date-range-picker__header button.arrow-right.ak-rotate-270').click();
    } else {
      await picker.locator('.is-right .el-date-range-picker__header button.arrow-right.ak-rotate-270').click();
    }
  }
  const endSide = targetMonth(to) === await panelMonth('is-left') ? 'is-left' : 'is-right';
  if (targetMonth(to) !== await panelMonth(endSide)) throw new Error('无法定位结束月份');
  await selectDay(endSide, to);
  const dates = await page.locator('input[placeholder="开始日期"], input[placeholder="结束日期"]').evaluateAll(els => els.map(el => el.value));
  if (dates[0] !== from || dates[1] !== to) throw new Error(`日期没有成功应用：${dates.join(' 至 ')}`);
  return dates;
}

async function resolveFnsku(page, fnsku, filters = {}) {
  await page.goto('https://xfg.lingxing.com/erp/listing', { waitUntil: 'domcontentloaded' });
  const search = page.locator('.ak-advanced-input__new').first();
  await search.locator('.field-select').first().waitFor({ state: 'visible', timeout: 60000 });
  await search.locator('.field-select').first().click();
  await page.locator('.el-select-dropdown:visible').getByText('FNSKU', { exact: true }).click();
  await search.locator('.search-input input').fill(fnsku);
  const responsePromise = page.waitForResponse(response => {
    if (!response.url().includes('/listing-api/api/product/showOnline')) return false;
    try {
      const body = JSON.parse(response.request().postData() || '{}');
      return body.search_field === 'fnsku' && body.search_value?.includes(fnsku);
    } catch { return false; }
  }, { timeout: 20000 });
  await search.locator('.lx_combo_search').click();
  const payload = await (await responsePromise).json();
  const normalize = value => String(value || '').replace(/\s+/g, '').toLowerCase();
  const matches = (payload.data?.list || []).filter(row => row.fnsku === fnsku &&
    (!filters.country || normalize(row.marketplace) === normalize(filters.country)) &&
    (!filters.shop || normalize(row.shop).includes(normalize(filters.shop))));
  if (matches.length !== 1) throw new Error(`FNSKU 在指定国家/店铺下匹配到 ${matches.length} 条 Listing；请改用 ASIN 或 MSKU 定位`);
  if (!matches[0].msku) throw new Error('Listing 未返回对应 MSKU');
  return { msku: matches[0].msku, asin: matches[0].asin, shop: matches[0].shop, marketplace: matches[0].marketplace };
}

async function chooseSearchType(page, type) {
  const search = page.locator('.ak-advanced-input__new').first();
  await search.locator('.field-select').first().click();
  await page.locator('.el-select-dropdown:visible').getByText(type, { exact: true }).click();
  return search;
}

async function resetReport(page) {
  await page.getByText('重置', { exact: true }).first().click();
  await page.waitForFunction(() => {
    const country = document.querySelector('.el-cascader[searchmemorylabel="国家"]');
    const shop = document.querySelector('.el-select[searchmemorylabel="店铺"]');
    const selected = country?.getAttribute('selectedarr');
    return country && shop && (!selected || selected === '[]') && shop.textContent?.includes('全部店铺');
  }, null, { timeout: 5000 });
}

async function chooseMatchMode(page, match) {
  const control = page.locator('.search-mode-select').first();
  await control.click();
  await page.locator('.el-select-dropdown:visible').filter({ hasText: '精确' }).first()
    .getByText(match, { exact: true }).click();
  const selected = await control.locator('input.el-input__inner').inputValue();
  if (selected !== match) throw new Error(`搜索方式未成功切换为${match}`);
  return selected;
}

async function chooseCountry(page, country) {
  if (!country) return null;
  const control = page.locator('.el-cascader[searchmemorylabel="国家"]').first();
  await control.click();
  const popup = page.locator('.el-cascader__dropdown:visible').first();
  await popup.waitFor({ state: 'visible' });
  const findItem = async menu => {
    const labels = await menu.locator('li[role="menuitem"]').evaluateAll(items =>
      items.map(item => item.querySelector('.cascader-item-label:not(.cascader-item-alllabel)')?.textContent?.trim() || ''));
    const index = labels.indexOf(country);
    return index < 0 ? null : menu.locator('li[role="menuitem"]').nth(index);
  };
  const firstMenu = popup.locator('.el-cascader-menu').first();
  let item = await findItem(firstMenu);
  if (!item) {
    const branches = firstMenu.locator('li[aria-haspopup="true"]');
    for (let i = 0, count = await branches.count(); i < count; i++) {
      await branches.nth(i).hover();
      const subMenu = popup.locator('.el-cascader-menu').nth(1);
      if (await subMenu.isVisible()) item = await findItem(subMenu);
      if (item) break;
    }
  }
  if (!item) throw new Error(`领星国家选项中未找到：${country}`);
  await item.hover();
  await item.locator('.select-tag').click({ force: true });
  await popup.waitFor({ state: 'hidden', timeout: 5000 });
  const selected = await control.innerText();
  if (!selected.includes(country)) throw new Error(`国家筛选未成功应用：${country}`);
  return selected;
}

async function chooseShop(page, shop) {
  if (!shop) return null;
  const control = page.locator('.el-select[searchmemorylabel="店铺"]').first();
  await control.click();
  const dropdown = page.locator('.el-select-dropdown:visible').first();
  await dropdown.waitFor({ state: 'visible' });
  const items = dropdown.locator('li.el-select-dropdown__item[title]');
  const titles = await items.evaluateAll(els => els.map(el => el.getAttribute('title')));
  const exact = titles.map((title, index) => ({ title, index })).filter(x => x.title.toLowerCase() === shop.toLowerCase());
  const matches = exact.length ? exact : titles.map((title, index) => ({ title, index }))
    .filter(x => x.title.toLowerCase().includes(shop.toLowerCase()));
  if (matches.length !== 1) throw new Error(`店铺“${shop}”匹配到 ${matches.length} 个选项；请填写完整店铺名或唯一片段`);
  const item = items.nth(matches[0].index);
  await item.hover();
  await item.locator('.select-tag').click({ force: true });
  const selected = await control.innerText();
  if (!selected.includes(matches[0].title)) throw new Error(`店铺筛选未成功应用：${matches[0].title}`);
  return matches[0].title;
}

async function collectPages(page, firstResponse, queryValue) {
  let payload = await firstResponse.json();
  if (!Array.isArray(payload.data?.list)) throw new Error('商品响应没有列表数据');
  const total = Number(payload.data.total);
  if (!Number.isInteger(total) || total < 0) throw new Error('商品响应没有有效的总条数');
  let items = [...payload.data.list];
  let pageSize = Number(JSON.parse(firstResponse.request().postData() || '{}').length) || items.length;
  let pages = 1;
  const pager = page.locator('.el-pagination').first();
  if (total > items.length && pageSize < 500) {
    await pager.locator('.el-pagination__sizes .el-select').click();
    const largeResponse = page.waitForResponse(response => {
      try {
        const body = JSON.parse(response.request().postData() || '{}');
        return body.search_value === queryValue && Number(body.offset) === 0 && Number(body.length) === 500;
      } catch { return false; }
    }, { timeout: 20000 });
    await page.locator('.el-select-dropdown:visible').getByText('500条/页', { exact: true }).click();
    payload = await (await largeResponse).json();
    if (!Array.isArray(payload.data?.list)) throw new Error('切换每页500条后没有列表数据');
    items = [...payload.data.list];
    pageSize = 500;
  }
  while (items.length < total) {
    const next = pager.locator('button.btn-next');
    if (await next.getAttribute('disabled') !== null) throw new Error(`分页尚未采完：已取 ${items.length}/${total} 条`);
    const offset = items.length;
    const nextResponse = page.waitForResponse(response => {
      try {
        const body = JSON.parse(response.request().postData() || '{}');
        return body.search_value === queryValue && Number(body.offset) === offset && Number(body.length) === pageSize;
      } catch { return false; }
    }, { timeout: 20000 });
    await next.click();
    const nextPayload = await (await nextResponse).json();
    const list = nextPayload.data?.list;
    if (!Array.isArray(list) || !list.length) throw new Error(`第 ${pages + 1} 页没有返回商品数据`);
    items.push(...list);
    pages++;
  }
  if (items.length !== total) throw new Error(`分页条数不一致：采集 ${items.length} 条，报表显示 ${total} 条`);
  return { body: { ...payload, data: { ...payload.data, list: items } }, total, pageSize, pages };
}

async function capture(options) {
  mkdirs();
  const templatePath = path.join(PRIVATE, 'request-template.json');
  if (fs.existsSync(templatePath)) fs.unlinkSync(templatePath);
  const start = performance.now();
  const profile = path.join(PRIVATE, 'chrome-profile');
  const sessionPath = path.join(PRIVATE, 'session-storage.json');
  const authPath = path.join(PRIVATE, 'auth-state.json');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, acceptDownloads: true,
    viewport: { width: 1500, height: 900 }
  });
  try {
    if (fs.existsSync(authPath)) {
      const state = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      if (Array.isArray(state.cookies) && state.cookies.length) await context.addCookies(state.cookies);
    }
    if (fs.existsSync(sessionPath)) {
      const savedSession = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      await context.addInitScript(storage => {
        if (location.origin === 'https://xfg.lingxing.com') {
          for (const [key, value] of Object.entries(storage)) sessionStorage.setItem(key, value);
        }
      }, savedSession);
    }
    const page = context.pages()[0] || await context.newPage();
    const seen = [];
    let recording = false;
    let queryValue = options.value;
    page.on('response', async response => {
      try {
        if (!recording) return;
        const request = response.request();
        const url = request.url();
        if (!DATA_HOSTS.has(new URL(url).hostname) || !/json/i.test(response.headers()['content-type'] || '')) return;
        if (/login|logout|captcha|verify|token|password/i.test(new URL(url).pathname)) return;
        const body = await response.json();
        const postData = request.postData() || '';
        const responseText = JSON.stringify(body);
        if (!postData.includes(queryValue) && !url.includes(queryValue) && !responseText.includes(queryValue)) return;
        seen.push({
          request: { url, method: request.method(), headers: await request.allHeaders(), postData },
          response: { status: response.status(), body },
          capturedAt: new Date().toISOString()
        });
      } catch (error) { console.error('跳过无法解析的响应：', error.message); }
    });

    console.log('正在打开领星产品表现页…');
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    const productTab = page.getByRole('tab', { name: 'MSKU', exact: true });
    try {
      await productTab.waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      console.log('脚本专用 Chrome 尚未登录领星。请在打开的窗口完成登录，并进入「产品表现」；脚本会自动继续。');
      const loginTimeout = Number(process.env.LINGXING_LOGIN_TIMEOUT_MS || 600000);
      await productTab.waitFor({ state: 'visible', timeout: loginTimeout });
    }
    const resolved = options.type === 'FNSKU' ? await resolveFnsku(page, options.value, options) : null;
    const queryType = resolved ? 'MSKU' : options.type;
    const tabType = queryType === '品名' ? '父ASIN' : queryType;
    queryValue = resolved ? resolved.msku : options.value;
    if (resolved) await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    console.log('阶段：筛选与采集');
    await resetReport(page);
    await page.getByRole('tab', { name: tabType, exact: true }).click();
    await context.storageState({ path: authPath });
    const sessionStorageData = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    saveJson(sessionPath, sessionStorageData);
    const country = await chooseCountry(page, options.country);
    const shop = await chooseShop(page, options.shop);
    const dates = options.from ? await chooseDates(page, options.from, options.to) : await choosePeriod(page, options.period);
    const search = await chooseSearchType(page, queryType);
    const match = await chooseMatchMode(page, options.match);
    await search.locator('.search-input input').fill(queryValue);
    const matchingResponse = page.waitForResponse(response => {
      try {
        const request = response.request();
        const host = new URL(request.url()).hostname;
        if (!DATA_HOSTS.has(host)) return false;
        const body = JSON.parse(request.postData() || '{}');
        return body.search_value === queryValue || (Array.isArray(body.search_value) && body.search_value.includes(queryValue));
      } catch { return false; }
    }, { timeout: 20000 });
    recording = true;
    await search.locator('.lx_combo_search').click();
    const collected = await collectPages(page, await matchingResponse, queryValue);
    await page.waitForTimeout(500);

    const rows = await page.locator('.vxe-table table, .ak-table-list table').evaluateAll(tables => tables.flatMap(table =>
      [...table.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.innerText.trim()))
    ).filter(row => row.some(Boolean)));
    const visibleText = await page.locator('body').innerText();
    const relevant = seen.filter(x => x.request.postData.includes(queryValue) || x.request.url.includes(queryValue) || JSON.stringify(x.response.body).includes(queryValue));
    saveJson(path.join(PRIVATE, 'last-captures.json'), relevant);
    const candidates = relevant.filter(x => {
      try { const body = JSON.parse(x.request.postData); return body.search_value === queryValue || (Array.isArray(body.search_value) && body.search_value.includes(queryValue)); }
      catch { return false; }
    });
    const selected = candidates.filter(x => Array.isArray(x.response.body?.data?.list))
      .sort((a,b) => JSON.stringify(b.response.body).length - JSON.stringify(a.response.body).length)[0];
    const requestFilters = selected ? (() => {
      const body = JSON.parse(selected.request.postData);
      return { search_field: body.search_field, mids: body.mids, sids: body.sids, offset: body.offset, length: body.length };
    })() : null;
    if (selected && options.country && !requestFilters.mids) throw new Error('国家已选择，但商品请求未包含国家筛选');
    if (selected && options.shop && !requestFilters.sids) throw new Error('店铺已选择，但商品请求未包含店铺筛选');
    if (selected && !options.country && requestFilters.mids) throw new Error('未指定国家，但商品请求仍含有国家筛选');
    if (selected && !options.shop && requestFilters.sids) throw new Error('未指定店铺，但商品请求仍含有店铺筛选');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const resultPath = path.join(RESULTS, `browser-${stamp}.json`);
    const result = {
      method: 'browser', input: options, resolved, query: { type: queryType, value: queryValue, tab: tabType },
      appliedFilters: { country, shop, match }, requestFilters, page: PAGE_URL, dates,
      pagination: { total: collected.total, collected: collected.body.data.list.length, pageSize: collected.pageSize, pages: collected.pages },
      fetchedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), rows,
      pageResultCount: visibleText.match(/共\s*\d+\s*条/)?.[0] || null,
      responseSummary: selected ? summary(collected.body) : null,
      responseHash: selected ? businessHash(collected.body) : null,
      capturedRequests: relevant.length,
      status: selected ? 'ok' : 'unverified'
    };
    console.log('阶段：保存结果');
    saveJson(resultPath, result);
    if (selected) {
      saveJson(templatePath, {
        input: { ...options, type: queryType, value: queryValue }, dates, request: selected.request,
        baseline: { summary: summary(selected.response.body), hash: businessHash(selected.response.body), browserElapsedMs: result.elapsedMs },
        capturedAt: selected.capturedAt
      });
      saveJson(path.join(RESULTS, `browser-data-${stamp}.json`), collected.body);
    }
    console.log(JSON.stringify({ ...result, rows: `[${rows.length} rows]`, template: selected ? '已保存供爬虫复用' : '未捕获到商品数据请求' }, null, 2));
    console.log(`结果：${resultPath}`);
    if (!selected) throw new Error('未捕获到 search_value 等于商品标识的查询；直连版不会复用未经确认的请求');
  } finally { await context.close(); }
}

const options = args(process.argv.slice(2));
if (options.help) {
  console.log('用法：node browser.js --type asin|parent_asin|msku|sku|fnsku|name --value 商品标识或品名 [--match fuzzy|exact] [--country 德国] [--shop 店铺名] [--period prev30 | --from YYYY-MM-DD --to YYYY-MM-DD]');
} else {
  capture(validate(options)).catch(error => { console.error(`浏览器版失败：${error.message}`); process.exitCode = 1; });
}
