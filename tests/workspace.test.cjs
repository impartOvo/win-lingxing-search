'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execute } = require('../workspace.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('monitor settings report success only after schedule registration; failed registration restores previous settings', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-workspace-'));
  t.after(() => { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const implementations = {
    automation: () => { if (++calls === 1) throw new Error('registration unavailable'); }
  };
  const packet = { module: 'monitoring', request: { action: 'save', config: { enabled: true } } };
  await assert.rejects(execute(packet, root, implementations), /恢复/);
  assert.equal((await execute({ module: 'monitoring', request: { action: 'snapshot' } }, root)).config.enabled, false);
  assert.equal(calls, 2);
  const saved = await execute(packet, root, implementations);
  assert.equal(saved.config.enabled, true);
  assert.equal(calls, 3);
});
