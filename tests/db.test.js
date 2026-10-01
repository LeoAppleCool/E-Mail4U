import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import { Access } from '../src/services/access.js';

const USER = '111111111111111111';
const OWNER = '999999999999999999';

function newAddress(store, overrides = {}) {
  return store.insertAddress({
    address: 'netflix@example.com', localPart: 'netflix', domain: 'example.com', zoneId: 'z1',
    ruleId: 'r1', userId: USER, threadId: null, note: null, ...overrides,
  });
}

test('settings can be stored and removed', () => {
  const store = new Store(':memory:');
  assert.equal(store.getSetting('x', 'fallback'), 'fallback');
  store.setSetting('x', 42);
  assert.equal(store.getSetting('x'), '42');
  store.setSetting('x', null);
  assert.equal(store.getSetting('x'), null);
});

test('grants: add, add twice, remove', () => {
  const store = new Store(':memory:');
  assert.equal(store.addGrant(USER, 'example.com', OWNER), true);
  assert.equal(store.addGrant(USER, 'example.com', OWNER), false);
  store.addGrant(USER, 'foo.example', OWNER);
  assert.deepEqual(store.grantsOf(USER), ['example.com', 'foo.example']);
  assert.equal(store.removeGrant(USER, 'foo.example'), true);
  assert.equal(store.removeGrant(USER, 'foo.example'), false);
});

test('access: the owner may use everything, others only what was granted', () => {
  const store = new Store(':memory:');
  const access = new Access({ store, config: { ownerIds: [] } });
  access.setApplicationOwners([OWNER]);
  const zones = [{ name: 'example.com' }, { name: 'foo.example' }];
  assert.equal(access.canUseDomain(OWNER, 'foo.example'), true);
  assert.equal(access.canUseDomain(USER, 'foo.example'), false);
  store.addGrant(USER, 'example.com', OWNER);
  assert.deepEqual(access.usableZones(USER, zones).map((z) => z.name), ['example.com']);
  store.addGrant(USER, '*', OWNER);
  assert.deepEqual(access.usableZones(USER, zones).map((z) => z.name), ['example.com', 'foo.example']);
  assert.equal(access.primaryOwner(), OWNER);
});

test('access: OWNER_IDS from the configuration take precedence', () => {
  const access = new Access({ store: new Store(':memory:'), config: { ownerIds: ['222222222222222222'] } });
  access.setApplicationOwners([OWNER]);
  assert.equal(access.isOwner(OWNER), false);
  assert.equal(access.isOwner('222222222222222222'), true);
});

test('an address can only be live once, deleted ones may be created again', () => {
  const store = new Store(':memory:');
  const first = newAddress(store);
  assert.throws(() => newAddress(store), /UNIQUE/);
  store.updateAddress(first.id, { status: 'deleted', deleted_at: Date.now() });
  const second = newAddress(store);
  assert.notEqual(second.id, first.id);
  assert.equal(store.findLiveAddress('NETFLIX@example.com').id, second.id);
  assert.equal(store.countLiveAddresses(USER), 1);
});

test('forgetting threads/forums and counting mails', () => {
  const store = new Store(':memory:');
  const address = newAddress(store, { threadId: 't1' });
  store.setForum(USER, 'f1');
  assert.equal(store.addressByThread('t1').id, address.id);
  assert.equal(store.forgetForum('f1'), USER);
  assert.equal(store.getAddress(address.id).thread_id, null);
  store.countMail(address.id, 1000);
  store.countMail(address.id, 2000);
  const counted = store.getAddress(address.id);
  assert.equal(counted.mail_count, 2);
  assert.equal(counted.last_mail_at, 2000);
});

test('counting and releasing delivery attempts', () => {
  const store = new Store(':memory:');
  const meta = { id: 'm1', rcpt: 'a@b.example', from: 'x@y.example', size: 10, receivedAt: 1 };
  const first = store.beginMail(meta);
  assert.equal(first.attempts, 1);
  assert.ok(first.first_attempt_at > 0);
  const second = store.beginMail(meta);
  assert.equal(second.attempts, 2);
  assert.equal(second.first_attempt_at, first.first_attempt_at, 'the first attempt is kept');
  store.releaseAttempt('m1');
  assert.equal(store.getMail('m1').attempts, 1);
  store.updateMail('m1', { status: 'delivered', message_id: 'msg1', raw_path: '/tmp/x.eml' });
  assert.equal(store.mailByMessage('msg1').id, 'm1');
  assert.equal(store.mailsWithRawBefore(5).length, 1);
});
