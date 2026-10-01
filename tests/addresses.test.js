import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Store } from '../src/db.js';
import { UserError } from '../src/errors.js';
import { silentLogger } from '../src/log.js';
import { Access } from '../src/services/access.js';
import { AddressService, ruleName, userIdFromRuleName } from '../src/services/addresses.js';

const OWNER = '999999999999999999';
const USER = '111111111111111111';
const user = (id, username) => ({ id, username });

let store; let domains; let forums; let service; let calls;

beforeEach(() => {
  store = new Store(':memory:');
  calls = [];
  const rules = new Map();
  let nextRule = 1;
  domains = {
    zones: [{ id: 'z1', name: 'example.com', routing: { enabled: true } }, { id: 'z2', name: 'off.example', routing: { enabled: false } }],
    get(name) { return this.zones.find((z) => z.name === name) ?? null; },
    async findRuleFor(zoneId, address) { return [...rules.values()].find((r) => r.address === address) ?? null; },
    async createRule(zoneId, { address, name }) {
      const rule = { id: `r${nextRule++}`, zoneId, address, name, enabled: true };
      rules.set(rule.id, rule);
      calls.push(['createRule', address, name]);
      return rule;
    },
    async updateRule(zoneId, ruleId, patch) {
      const rule = rules.get(ruleId);
      if (!rule) return null;
      Object.assign(rule, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      calls.push(['updateRule', ruleId, patch]);
      return rule;
    },
    async deleteRule(zoneId, ruleId) {
      calls.push(['deleteRule', ruleId]);
      return rules.delete(ruleId);
    },
    rules,
  };
  forums = {
    failThread: null,
    failForum: null,
    async ensureForum(userId) {
      if (this.failForum) throw this.failForum;
      return { id: `forum-${userId}` };
    },
    async ensureThread(address) {
      if (this.failThread) throw this.failThread;
      calls.push(['ensureThread', address.address]);
      store.updateAddress(address.id, { thread_id: `thread-${address.id}` });
      return { id: `thread-${address.id}`, toString: () => `<#thread-${address.id}>` };
    },
    async refreshThread(address) { calls.push(['refreshThread', address.status]); },
    async deleteThread(threadId) { calls.push(['deleteThread', threadId]); },
  };
  const access = new Access({ store, config: { ownerIds: [OWNER] } });
  service = new AddressService({ store, domains, forums, access, log: silentLogger });
  store.addGrant(USER, 'example.com', OWNER);
});

test('creates the address in Cloudflare, the database and Discord', async () => {
  const { address, thread } = await service.create({ user: user(USER, 'leo'), name: ' Netflix ', domain: 'example.com', note: 'Streaming' });
  assert.equal(address.address, 'netflix@example.com');
  assert.equal(address.thread_id, thread.id);
  assert.equal(address.rule_id, 'r1');
  assert.equal(address.note, 'Streaming');
  assert.deepEqual(calls[0], ['createRule', 'netflix@example.com', ruleName('leo', USER, 'Streaming')]);
  assert.equal(userIdFromRuleName(calls[0][2]), USER);
});

test('user ID from the rule name: an ID inside the note does not count', () => {
  assert.equal(userIdFromRuleName(ruleName('leo', USER, `for (${OWNER})`)), USER);
  assert.equal(userIdFromRuleName('Some other rule (123456789012345678)'), null);
});

test('rolls everything back if the thread cannot be created', async () => {
  forums.failThread = new Error('Discord broken');
  await assert.rejects(service.create({ user: user(USER, 'leo'), name: 'netflix', domain: 'example.com' }), /Discord broken/);
  assert.equal(domains.rules.size, 0);
  assert.equal(store.findLiveAddress('netflix@example.com'), null);
});

test('missing Discord permissions give a clear message and nothing is created in Cloudflare', async () => {
  forums.failForum = Object.assign(new Error('Missing Permissions'), { code: 50013 });
  await assert.rejects(service.create({ user: user(USER, 'leo'), name: 'netflix', domain: 'example.com' }), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /missing server permissions/);
    return true;
  });
  assert.equal(domains.rules.size, 0);
});

test('parallel /create calls of the same user are rejected (the limit cannot be bypassed)', async () => {
  store.setSetting('address_limit', 1);
  const leo = user(USER, 'leo');
  const results = await Promise.allSettled([
    service.create({ user: leo, name: 'one', domain: 'example.com' }),
    service.create({ user: leo, name: 'two', domain: 'example.com' }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /One moment/);
  assert.equal(store.countLiveAddresses(USER), 1);
});

test('rejects domains without access, without Email Routing and duplicate addresses', async () => {
  const leo = user(USER, 'leo');
  await assert.rejects(service.create({ user: user('222222222222222222', 'x'), name: 'a', domain: 'example.com' }), UserError);
  await assert.rejects(service.create({ user: user(OWNER, 'boss'), name: 'a', domain: 'off.example' }), /not enabled/);
  await service.create({ user: leo, name: 'netflix', domain: 'example.com' });
  await assert.rejects(service.create({ user: leo, name: 'netflix', domain: 'example.com' }), /already taken/);
  domains.rules.set('manual', { id: 'manual', address: 'manual@example.com' });
  await assert.rejects(service.create({ user: leo, name: 'manual', domain: 'example.com' }), /already exists as a custom address/);
});

test('reserved names only for the owner, the limit only for normal users', async () => {
  await assert.rejects(service.create({ user: user(USER, 'leo'), name: 'postmaster', domain: 'example.com' }), /reserved/);
  await service.create({ user: user(OWNER, 'boss'), name: 'postmaster', domain: 'example.com' });

  store.setSetting('address_limit', 2);
  await service.create({ user: user(USER, 'leo'), name: 'a1', domain: 'example.com' });
  await service.create({ user: user(USER, 'leo'), name: 'a2', domain: 'example.com' });
  await assert.rejects(service.create({ user: user(USER, 'leo'), name: 'a3', domain: 'example.com' }), /limit: 2/);
  await service.create({ user: user(OWNER, 'boss'), name: 'b1', domain: 'example.com' });
  await service.create({ user: user(OWNER, 'boss'), name: 'b2', domain: 'example.com' });
});

test('addresses that are too long are rejected (Cloudflare: max. 90 characters)', async () => {
  const long = 'a-really-very-long-domain-name.example';
  domains.zones.push({ id: 'z3', name: long, routing: { enabled: true } });
  await assert.rejects(service.create({ user: user(OWNER, 'boss'), name: 'a'.repeat(64), domain: long }), /90 characters/);
  await service.create({ user: user(OWNER, 'boss'), name: 'a'.repeat(50), domain: long });
});

test('pause, resume and delete', async () => {
  const { address } = await service.create({ user: user(USER, 'leo'), name: 'netflix', domain: 'example.com' });
  const paused = await service.setPaused(address.id, USER, true);
  assert.equal(paused.status, 'paused');
  assert.equal(domains.rules.get('r1').enabled, false);
  const resumed = await service.setPaused(address.id, USER, false);
  assert.equal(resumed.status, 'active');

  await assert.rejects(service.remove(address.id, '222222222222222222'), /not your address/);
  const deleted = await service.remove(address.id, USER);
  assert.equal(deleted.status, 'deleted');
  assert.equal(domains.rules.size, 0);
  assert.deepEqual(calls.at(-1), ['refreshThread', 'deleted']);
});

test('delete incl. thread, as the owner', async () => {
  const { address } = await service.create({ user: user(USER, 'leo'), name: 'netflix', domain: 'example.com' });
  const deleted = await service.remove(address.id, OWNER, { deleteThread: true });
  assert.equal(deleted.thread_id, null);
  assert.ok(calls.some(([name]) => name === 'deleteThread'));
});

test('pausing an address deleted in the dashboard marks it as deleted', async () => {
  const { address } = await service.create({ user: user(USER, 'leo'), name: 'netflix', domain: 'example.com' });
  domains.rules.clear();
  await assert.rejects(service.setPaused(address.id, USER, true), /no longer exists in Cloudflare/);
  assert.equal(store.getAddress(address.id).status, 'deleted');
});

test('changing the note also updates the rule name', async () => {
  const { address } = await service.create({ user: user(USER, 'leo'), name: 'netflix', domain: 'example.com' });
  store.upsertUser(USER, 'leo');
  const updated = await service.setNote(address.id, USER, '  New note ');
  assert.equal(updated.note, 'New note');
  assert.equal(domains.rules.get('r1').name, ruleName('leo', USER, 'New note'));
});
