'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const core = require('../monitoring/core.cjs');
const { execute } = require('../monitoring/cli.cjs');
const providers = require('../monitoring/providers.cjs');
function root(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsarfetch-monitor-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const config = extras => ({ enabled: true, inventoryIntervalMinutes: 30, mail: { enabled: true, intervalMinutes: 5, repeatMinutes: 120 },
  inventoryRules: [{ id: 'sample-rule', name: '示例库存', enabled: true, type: 'MSKU', value: 'SAMPLE-SKU', country: '加拿大', shop: '示例店铺', threshold: 10, cooldownMinutes: 60 }], ...extras });
const now = minute => new Date(Date.UTC(2030, 0, 1, 0, minute));
const stock = quantity => [{ identity: 'sample-identity', quantity, sid: '101', seller_sku: 'SAMPLE-SKU', fnsku: 'SAMPLE-FN', group_by_sid: '101,102', share_type: 2 }];
function fixture(quantity = 9, pending = 1, overdue = 0) { return { inventory: async () => stock(quantity), mail: async () => [{ id: 'sample-store', name: '示例店铺', pending, overdue }] }; }
const kind = (snapshot, value) => snapshot.events.filter(event => event.kind === value);

test('defaults, normalized aliases and schedule use minimum active interval', async t => {
  const dir = root(t);
  assert.deepEqual(core.getSchedule(dir), { enabled: false, intervalMinutes: 30 });
  let saved = await core.save(dir, config());
  assert.deepEqual(core.getSchedule(dir), { enabled: true, intervalMinutes: 5 });
  saved.config.mail.enabled = false; saved.config.inventoryRules[0].country = 'CA'; saved.config.inventoryRules[0].type = 'msku';
  saved = await core.save(dir, saved.config);
  assert.equal(saved.config.inventoryRules[0].country, '加拿大');
  assert.equal(saved.config.inventoryRules[0].type, 'MSKU');
  assert.deepEqual(core.getSchedule(dir), { enabled: true, intervalMinutes: 30 });
  saved.config.enabled = false; await core.save(dir, saved.config);
  assert.equal(core.getSchedule(dir).enabled, false);
});

test('invalid config/path/RPC arguments fail before persistence', async t => {
  const dir = root(t); await core.save(dir, config());
  const before = fs.readFileSync(core.paths(dir).config, 'utf8');
  for (const invalid of [config({ inventoryIntervalMinutes: 4 }), config({ enabled: 'true' }), config({ mail: { intervalMinutes: 0 } }),
    config({ inventoryRules: [{ ...config().inventoryRules[0], threshold: null }] }), config({ inventoryRules: [{ ...config().inventoryRules[0], threshold: -1 }] }),
    config({ inventoryRules: [config().inventoryRules[0], config().inventoryRules[0]] })]) await assert.rejects(core.save(dir, invalid));
  assert.equal(fs.readFileSync(core.paths(dir).config, 'utf8'), before);
  await assert.rejects(execute({ action: 'save' }, dir));
  await assert.rejects(execute({ action: 'tick', force: 'yes' }, dir));
  assert.throws(() => core.snapshot('../relative'));
});

test('strict stock threshold preserves zero; equality and above do not alarm', async t => {
  const dir = root(t); await core.save(dir, config({ mail: { enabled: false } }));
  let result = await core.tick(dir, { now: now(0), providers: fixture(11) }); assert.equal(kind(result, 'inventory').length, 0);
  result = await core.tick(dir, { now: now(30), providers: fixture(10) }); assert.equal(kind(result, 'inventory').length, 0);
  result = await core.tick(dir, { now: now(60), providers: fixture(0) });
  assert.equal(kind(result, 'inventory')[0].inventory.quantity, 0); assert.equal(kind(result, 'inventory')[0].state, 'active');
});

test('cooldown, delivered ack, unread, snooze, recovery and reopen are independent', async t => {
  const dir = root(t); await core.save(dir, config({ mail: { enabled: false } }));
  let result = await core.tick(dir, { now: now(0), providers: fixture() });
  let event = kind(result, 'inventory')[0], id = event.id;
  assert.equal(event.notifyVersion, 1); assert.equal(result.pendingNotifications.length, 1);
  result = await execute({ action: 'mark-read', ids: [id] }, dir, { now: now(1) });
  assert.equal(result.events[0].unread, false); assert.equal(result.pendingNotifications.length, 1);
  result = await execute({ action: 'ack-notifications', ids: [id] }, dir, { now: now(2) });
  assert.equal(result.pendingNotifications.length, 0); assert.equal(result.events[0].unread, false);
  result = await core.tick(dir, { now: now(30), providers: fixture() }); assert.equal(result.events[0].notifyVersion, 1);
  result = await core.tick(dir, { now: now(60), providers: fixture() }); assert.equal(result.events[0].notifyVersion, 2);
  result = await execute({ action: 'ack-notifications', ids: [id], versions: { [id]: 1 } }, dir, { now: now(61) });
  assert.equal(result.pendingNotifications.length, 1, 'stale delivery must not acknowledge the newer alert');
  result = await execute({ action: 'snooze', ids: [id], minutes: 30 }, dir, { now: now(62) }); assert.equal(result.pendingNotifications.length, 0);
  assert.equal(core.snapshot(dir, now(91)).pendingNotifications.length, 0);
  assert.equal(core.snapshot(dir, now(92)).pendingNotifications.length, 1);
  result = await core.tick(dir, { now: now(120), providers: fixture(10) }); assert.equal(result.events[0].state, 'resolved'); assert.equal(result.pendingNotifications.length, 0);
  result = await core.tick(dir, { now: now(150), providers: fixture(5) });
  assert.equal(result.events[0].id, id); assert.equal(result.events[0].state, 'active'); assert.equal(result.events[0].unread, true); assert.equal(result.events[0].notifyVersion, 4);
});

test('each provider has its own interval and force performs immediate check', async t => {
  const dir = root(t); await core.save(dir, config());
  let inventoryCalls = 0, mailCalls = 0;
  const fakes = { inventory: async () => { inventoryCalls++; return stock(20); }, mail: async () => { mailCalls++; return []; } };
  await core.tick(dir, { now: now(0), providers: fakes }); await core.tick(dir, { now: now(5), providers: fakes });
  assert.equal(inventoryCalls, 1); assert.equal(mailCalls, 2);
  await execute({ action: 'tick', force: true }, dir, { now: now(6), providers: fakes });
  assert.equal(inventoryCalls, 2); assert.equal(mailCalls, 3);
});

test('unknown/null/failed stock keeps existing alarm and emits distinct error', async t => {
  const dir = root(t); await core.save(dir, config({ mail: { enabled: false } }));
  let result = await core.tick(dir, { now: now(0), providers: fixture() });
  for (const [minute, rows] of [[30, stock(null)], [60, []], [90, [stock(1)[0], stock(1)[0]]]]) {
    result = await core.tick(dir, { now: now(minute), providers: { inventory: async () => rows } });
    assert.equal(kind(result, 'inventory')[0].state, 'active'); assert.equal(kind(result, 'error')[0].state, 'active'); assert.equal(result.errors.length, 1);
  }
  result = await core.tick(dir, { now: now(120), providers: { inventory: async () => { throw new Error('Bearer PRIVATE-SECRET EMAIL_C1'); } } });
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SECRET')); assert.ok(!JSON.stringify(result).includes('EMAIL_C1'));
  result = await core.tick(dir, { now: now(150), providers: fixture(15) }); assert.equal(result.errors.length, 0); assert.equal(kind(result, 'error')[0].state, 'resolved');
});

test('mail pending/overdue authoritative counts ignore unread and replied thread flags', async t => {
  const dir = root(t); await core.save(dir, config({ inventoryRules: [] }));
  const bodies = status => ({ code: 1, total: 1, list: [{ store_id: 101, store_name: '示例店铺', mail_count: 1, is_seen: 1, is_done: status }] });
  const stores = providers.normalizeDashboards(bodies(2), { code: 1, total: 0, list: [] });
  let result = await core.tick(dir, { now: now(0), providers: { mail: async () => stores } });
  assert.equal(kind(result, 'mail')[0].state, 'active'); assert.match(kind(result, 'mail')[0].message, /待回复 1 封/);
  assert.equal(kind(result, 'mail')[0].target, providers.MAIL_URL);
  result = await core.tick(dir, { now: now(5), providers: { mail: async () => [{ id: '101', name: '示例店铺', pending: 0, overdue: 2, is_seen: 0, is_done: 4 }] } });
  assert.equal(kind(result, 'mail')[0].state, 'active'); assert.match(kind(result, 'mail')[0].message, /超时 2 封/);
  result = await core.tick(dir, { now: now(10), providers: { mail: async () => [] } }); assert.equal(kind(result, 'mail')[0].state, 'resolved');
  result = await core.tick(dir, { now: now(15), providers: { mail: async () => stores } }); assert.equal(kind(result, 'mail')[0].notifyVersion, 2);
  assert.ok(!JSON.stringify(result).includes('is_done'));
});

test('malformed or failed mail response cannot resolve active notifications', async t => {
  const dir = root(t); await core.save(dir, config({ inventoryRules: [] }));
  await core.tick(dir, { now: now(0), providers: fixture() });
  let result = await core.tick(dir, { now: now(5), providers: { mail: async () => undefined } });
  assert.equal(kind(result, 'mail')[0].state, 'active'); assert.equal(result.errors.length, 1);
  assert.throws(() => providers.normalizeDashboards({ code: 1, total: 1, list: [] }, { code: 1, total: 0, list: [] }));
  assert.throws(() => providers.normalizeDashboards({ code: 0, total: 0, list: [] }, { code: 1, total: 0, list: [] }));
  assert.throws(() => providers.normalizeDashboards({ code: 1, total: 0, list: [{ store_id: 1, store_name: '示例', mail_count: null }] }, { code: 1, total: 0, list: [] }));
});

test('overlapping ticks and config mutations cannot duplicate an event or lose acknowledgement', async t => {
  const dir = root(t); await core.save(dir, config({ mail: { enabled: false } }));
  let resume; const blocked = new Promise(resolve => { resume = resolve; });
  const first = core.tick(dir, { now: now(0), providers: { inventory: async () => { await blocked; return stock(1); } } });
  await assert.rejects(core.tick(dir, { now: now(0), providers: fixture() }), /正在运行/);
  await assert.rejects(core.save(dir, config()), /正在运行/);
  resume(); const result = await first;
  assert.equal(kind(result, 'inventory').length, 1); assert.equal(fs.existsSync(core.paths(dir).lock), false);
});

test('OS-owned lock admits one simultaneous process and recovers immediately after owner crash', { timeout: 15000 }, async t => {
  const dir = root(t); await core.save(dir, config({ mail: { enabled: false } }));
  // A legacy dead-PID sentinel must neither prevent checks nor be deleted by a contender.
  const legacy = JSON.stringify({ pid: 2147483647 }); fs.writeFileSync(core.paths(dir).lock, legacy);
  const childCode = `
    const core = require(${JSON.stringify(path.join(__dirname, '..', 'monitoring', 'core.cjs'))});
    process.on('message', async message => {
      if (message !== 'start') return;
      try {
        await core.tick(process.argv[1], { force:true, providers:{inventory:async()=>{
          process.send('entered'); await new Promise(()=>{}); return [];
        }} });
      } catch { process.send('busy'); process.disconnect(); }
    });
    process.send('ready');
  `;
  function contender() {
    const child = spawn(process.execPath, ['-e', childCode, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const messages = [], waiters = [];
    child.on('message', value => { messages.push(value); for (const waiter of [...waiters]) if (waiter.values.includes(value)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(value); } });
    const exited = new Promise(resolve => child.once('exit', resolve));
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    return { child, exited, wait: values => {
      const seen = messages.find(value => values.includes(value));
      return seen ? Promise.resolve(seen) : new Promise(resolve => waiters.push({ values, resolve }));
    } };
  }
  const a = contender(), b = contender();
  await Promise.all([a.wait(['ready']), b.wait(['ready'])]);
  a.child.send('start'); b.child.send('start');
  const outcomes = await Promise.all([a.wait(['entered', 'busy']), b.wait(['entered', 'busy'])]);
  assert.deepEqual([...outcomes].sort(), ['busy', 'entered']);
  let accidentalChecks = 0;
  await assert.rejects(core.tick(dir, { force: true, providers: { inventory: async () => { accidentalChecks++; return stock(1); } } }), /正在运行/);
  assert.equal(accidentalChecks, 0);
  const owner = outcomes[0] === 'entered' ? a : b; owner.child.kill('SIGKILL'); await owner.exited;
  const recovered = await core.tick(dir, { force: true, now: now(0), providers: fixture(1) });
  assert.equal(kind(recovered, 'inventory').length, 1);
  assert.equal(fs.readFileSync(core.paths(dir).lock, 'utf8'), legacy, 'no contender deletes even a legacy stale sentinel');
});

test('scope changes retire prior stock identity and disabling retires stale notifications', async t => {
  const dir = root(t); await core.save(dir, config()); await core.tick(dir, { now: now(0), providers: fixture() });
  let changed = config(); changed.inventoryRules[0].value = 'ANOTHER-SAMPLE';
  let result = await core.save(dir, changed); assert.equal(kind(result, 'inventory')[0].state, 'resolved'); assert.equal(result.lastCheck.inventory, null);
  result = await core.save(dir, config({ enabled: false })); assert.equal(result.pendingNotifications.length, 0); assert.ok(result.events.every(event => event.state === 'resolved'));
});

test('scheduled save rolls back exact config and active pending event state before restoring prior schedule', async t => {
  const dir = root(t); await core.save(dir, config());
  const initial = await core.tick(dir, { now: now(0), providers: fixture() });
  const p = core.paths(dir), before = [p.config, p.state].map(file => fs.readFileSync(file));
  let registrations = 0;
  await assert.rejects(execute({ action: 'save-scheduled', config: config({ enabled: false }) }, dir, {
    registerSchedule: async receivedRoot => {
      assert.equal(receivedRoot, dir); registrations++;
      if (registrations === 1) {
        const disabled = core.snapshot(dir, now(1));
        assert.equal(disabled.config.enabled, false); assert.equal(disabled.pendingNotifications.length, 0);
        assert.ok(disabled.events.every(event => event.state === 'resolved'));
        throw new Error('synthetic registration failure with PRIVATE-COMMAND-ARGUMENT');
      }
      assert.equal(core.getSchedule(dir).enabled, true);
      for (const [index, file] of [p.config, p.state].entries()) assert.deepEqual(fs.readFileSync(file), before[index]);
    }
  }), error => /系统调度同步失败/.test(error.message) && /已完整恢复/.test(error.message) && !error.message.includes('PRIVATE-COMMAND-ARGUMENT'));
  assert.equal(registrations, 2);
  const restored = core.snapshot(dir, now(1));
  assert.deepEqual(restored.events, initial.events); assert.deepEqual(restored.pendingNotifications, initial.pendingNotifications);
  for (const [index, file] of [p.config, p.state].entries()) assert.deepEqual(fs.readFileSync(file), before[index]);
});

test('scheduled save reports failed schedule rollback and preserves originally absent files', async t => {
  const dir = root(t); let calls = 0;
  await assert.rejects(core.saveScheduled(dir, config(), async () => { calls++; throw new Error('synthetic'); }), /原系统调度恢复失败/);
  assert.equal(calls, 2); assert.equal(fs.existsSync(core.paths(dir).config), false); assert.equal(fs.existsSync(core.paths(dir).state), false);
  await assert.rejects(execute({ action: 'save-scheduled', config: config() }, dir), /缺少系统调度同步回调/);
  assert.equal(fs.existsSync(core.paths(dir).config), false);
});

test('scheduled save holds the same lock as ticks, save and every event mutation through registration', async t => {
  const dir = root(t); await core.save(dir, config());
  const initial = await core.tick(dir, { now: now(0), providers: fixture() });
  const id = initial.events[0].id;
  let entered, release;
  const registered = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const saving = core.saveScheduled(dir, config(), async () => { entered(); await blocked; });
  await registered;
  let checks = 0;
  await assert.rejects(core.tick(dir, { force: true, providers: { inventory: async () => { checks++; return stock(1); } } }), /正在运行/);
  await assert.rejects(core.save(dir, config({ enabled: false })), /正在运行/);
  for (const action of ['mark-read', 'snooze', 'ack-notifications']) await assert.rejects(execute({ action, ids: [id], minutes: 60 }, dir), /正在运行/);
  assert.equal(checks, 0);
  release(); const saved = await saving;
  assert.equal(saved.events[0].unread, true); assert.equal(saved.events[0].deliveredVersion, 0); assert.equal(saved.events[0].snoozedUntil, undefined);
  const acknowledged = await execute({ action: 'ack-notifications', ids: [id] }, dir);
  assert.equal(acknowledged.events[0].deliveredVersion, acknowledged.events[0].notifyVersion);
});

test('FBA mapping deduplicates exact identity without adding shared pools, rejects null/conflict/foreign sid', () => {
  const row = { sid: 101, seller_sku: 'SAMPLE-SKU', fnsku: 'SAMPLE-FN', afn_fulfillable_quantity: 0, available_total: 999, unique_id: 'synthetic', group_by_sid: '101,102', share_type: 2 };
  const result = providers.normalizeInventory([row, row], new Set(['101']));
  assert.equal(result.length, 1); assert.equal(result[0].quantity, 0); assert.equal(result[0].share_type, 2); assert.equal(result[0].group_by_sid, '101,102');
  assert.throws(() => providers.normalizeInventory([{ ...row, afn_fulfillable_quantity: null }], new Set(['101'])));
  assert.throws(() => providers.normalizeInventory([row, { ...row, afn_fulfillable_quantity: 2 }], new Set(['101'])));
  assert.throws(() => providers.normalizeInventory([row], new Set(['102'])));
});

test('live inventory adapter uses verified MCP shape, paginates and closes connection', async () => {
  let closed = false, calls = [];
  const client = { connect: async () => {}, close: async () => { closed = true; }, call: async (id, params) => {
    calls.push([id, params]);
    if (id === 'customer_review_country_sellers') return { markets: [{ country: '加拿大', code: 'CA', country_id: 10 }], sellers: [{ sid: 101, country_id: 10, seller_simple_name: '示例店铺', currency_code: 'CAD' }] };
    assert.equal(params.sid, '101'); assert.equal(params.search_value, 'SAMPLE-SKU'); assert.equal(params.fulfillment_channel_type, 'FBA'); assert.equal(params.is_hide_zero_stock, '0');
    return { code: 1, total: 2, list: [{ sid: 101, seller_sku: 'SAMPLE-SKU', fnsku: 'SAMPLE-FN-' + params.offset, afn_fulfillable_quantity: params.offset }] };
  } };
  const result = await providers.inventory('/synthetic-unused', config().inventoryRules[0], { client });
  assert.equal(result.length, 2); assert.equal(result[0].quantity, 0); assert.equal(calls.length, 3); assert.equal(closed, true);
});

test('mail browser adapter reuses read-only auth, captures GET headers, requests status 1/2 and closes browser', async t => {
  const dir = root(t), priv = path.join(dir, '.private'); fs.mkdirSync(priv);
  fs.writeFileSync(path.join(priv, 'auth-state.json'), '{"cookies":[],"origins":[]}'); fs.writeFileSync(path.join(priv, 'session-storage.json'), '{"sample":"synthetic-session"}');
  const before = fs.readdirSync(priv).map(name => [name, fs.readFileSync(path.join(priv, name), 'utf8')]);
  let browserClosed = false, contextClosed = false, routeHandler, urls = [];
  const request = { url: () => 'https://gw.lingxingerp.com/api/webmail/after_sales/mailDashboard?mail_status=3&mids=old&sids=old', method: () => 'GET', allHeaders: async () => ({ 'auth-token': 'SYNTHETIC', 'x-unrelated': 'omit' }) };
  const context = { addInitScript: async () => {}, route: async (pattern, handler) => { routeHandler = handler; }, close: async () => { contextClosed = true; },
    newPage: async () => ({ waitForRequest: async predicate => { assert.equal(predicate(request), true); return request; }, goto: async url => { assert.equal(url, providers.MAIL_URL); }, url: () => providers.MAIL_URL }),
    request: { get: async (raw, options) => { const url = new URL(raw); urls.push(url); assert.equal(options.headers['auth-token'], 'SYNTHETIC'); assert.equal(options.headers['x-unrelated'], undefined); assert.equal(options.maxRedirects, 0); return { ok: () => true, json: async () => ({ code: 1, total: 0, list: [] }) }; } } };
  const chromium = { launch: async options => { assert.equal(options.headless, true); return { newContext: async options => { assert.equal(options.storageState, path.join(priv, 'auth-state.json')); return context; }, close: async () => { browserClosed = true; } }; } };
  assert.deepEqual(await providers.mail(dir, { chromium }), []);
  assert.deepEqual(urls.map(url => url.searchParams.get('mail_status')), ['1', '2']); assert.ok(urls.every(url => url.searchParams.get('mids') === '' && url.searchParams.get('sids') === ''));
  let aborted = false;
  await routeHandler({ request: () => ({ url: () => 'https://gw.lingxingerp.com/api/webmail/after_sales/send', method: () => 'POST' }), abort: async () => { aborted = true; }, continue: async () => { throw new Error('mutation allowed'); } });
  assert.equal(aborted, true); assert.equal(browserClosed, true); assert.equal(contextClosed, true);
  aborted = false;
  await routeHandler({ request: () => ({ url: () => 'https://gw.lingxingerp.com/api/webmail/after_sales/markRead', method: () => 'GET' }), abort: async () => { aborted = true; }, continue: async () => { throw new Error('unverified mailbox route allowed'); } });
  assert.equal(aborted, true);
  assert.deepEqual(fs.readdirSync(priv).map(name => [name, fs.readFileSync(path.join(priv, name), 'utf8')]), before);
});

test('CLI writes exactly one JSON snapshot, preserves unrelated auth/results files', t => {
  const dir = root(t); fs.mkdirSync(path.join(dir, '.private')); fs.mkdirSync(path.join(dir, 'results')); fs.writeFileSync(path.join(dir, '.private', 'auth-state.json'), 'synthetic-auth');
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'monitoring', 'cli.cjs'), '--data', dir], { input: JSON.stringify({ action: 'snapshot' }), encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).config.enabled, false); assert.equal(run.stderr, '');
  assert.equal(fs.readFileSync(path.join(dir, '.private', 'auth-state.json'), 'utf8'), 'synthetic-auth'); assert.deepEqual(fs.readdirSync(path.join(dir, 'results')), []);
});
