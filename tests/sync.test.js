import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { Access } from '../src/services/access.js';
import { ruleName } from '../src/services/addresses.js';
import { syncWithCloudflare } from '../src/services/sync.js';

const OWNER = '999999999999999999';
const USER = '111111111111111111';
const WORKER = 'email4u-relay';

const rule = (id, address, { enabled = true, name = '', worker = WORKER } = {}) => ({
  id, name, enabled,
  matchers: [{ type: 'literal', field: 'to', value: address }],
  actions: [{ type: 'worker', value: [worker] }],
});

test('takes over dashboard changes and imports unknown rules that point to the worker', async () => {
  const store = new Store(':memory:');
  const add = (address, ruleId) => store.insertAddress({
    address, localPart: address.split('@')[0], domain: 'example.com', zoneId: 'z1', ruleId, userId: USER, threadId: `t-${ruleId}`, note: null,
  });
  const kept = add('keep@example.com', 'r1');
  const paused = add('paused@example.com', 'r2');
  const gone = add('gone@example.com', 'r3');

  const rules = [
    rule('r1', 'keep@example.com'),
    rule('r2', 'paused@example.com', { enabled: false }),
    rule('r4', 'new@example.com', { name: ruleName('leo', USER, null) }),
    rule('r5', 'manual@example.com'),
    rule('r6', 'foreign@example.com', { worker: 'another-worker' }),
    { id: 'r7', matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [WORKER] }] },
  ];
  const refreshed = [];
  const summary = await syncWithCloudflare({
    store,
    domains: { list: () => [{ id: 'z1', name: 'example.com', routing: { enabled: true } }], listRules: async () => rules },
    forums: { refreshThread: async (a) => refreshed.push([a.address, a.status]) },
    access: new Access({ store, config: { ownerIds: [OWNER] } }),
    addresses: { pending: new Set() },
    config: { workerName: WORKER },
    log: silentLogger,
  });

  assert.deepEqual(summary, { removed: 1, changed: 1, imported: 2 });
  assert.equal(store.getAddress(kept.id).status, 'active');
  assert.equal(store.getAddress(paused.id).status, 'paused');
  assert.equal(store.getAddress(gone.id).status, 'deleted');
  assert.deepEqual(refreshed.sort(), [['gone@example.com', 'deleted'], ['paused@example.com', 'paused']]);
  assert.equal(store.findLiveAddress('new@example.com').user_id, USER);
  assert.equal(store.findLiveAddress('manual@example.com').user_id, OWNER);
  assert.equal(store.findLiveAddress('foreign@example.com'), null);
});
