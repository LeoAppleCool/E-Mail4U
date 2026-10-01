import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test } from 'node:test';
import { Store } from '../src/db.js';
import { silentLogger } from '../src/log.js';
import { MailDelivery } from '../src/mail/deliver.js';
import { Access } from '../src/services/access.js';
import { LIMITS, buildRawMail } from './helpers.js';

const OWNER = '999999999999999999';
const USER = '111111111111111111';

let store; let forums; let delivery; let sent; let audits; let dataDir;

function fakeThread(id) {
  return {
    id,
    async send(message) {
      if (forums.failWith) {
        const err = forums.failWith;
        forums.failWith = null;
        throw err;
      }
      sent.push({ thread: id, message });
      return { id: `msg-${sent.length}` };
    },
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email4u-test-'));
  store = new Store(':memory:');
  sent = [];
  audits = [];
  forums = {
    failWith: null,
    threads: [],
    async ensureThread(address) {
      const id = address.thread_id ?? `thread-${address.id}`;
      if (!address.thread_id) store.updateAddress(address.id, { thread_id: id });
      this.threads.push(id);
      return fakeThread(id);
    },
    uploadLimits: () => LIMITS,
  };
  const domains = { get: (name) => (name === 'example.com' ? { id: 'z1', name } : null) };
  const access = new Access({ store, config: { ownerIds: [OWNER] } });
  delivery = new MailDelivery({
    store, forums, access, domains, log: silentLogger, audit: (t) => audits.push(t), isDiscordReady: () => true,
    config: { dataDir, mailRetentionDays: 30 },
  });
  store.insertAddress({
    address: 'netflix@example.com', localPart: 'netflix', domain: 'example.com', zoneId: 'z1',
    ruleId: 'r1', userId: USER, threadId: null, note: null,
  });
});

const meta = (id, to = 'netflix@example.com') => ({ id, from: 'noreply@shop.example', to, size: 0, receivedAt: Date.now() });

test('delivers the mail to the address thread, stores the original and counts it', async () => {
  await delivery.handle(meta('m1'), buildRawMail());
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.content.includes(`<@${USER}>`));
  const row = store.getMail('m1');
  assert.equal(row.status, 'delivered');
  assert.equal(row.message_id, 'msg-1');
  assert.ok(fs.existsSync(row.raw_path));
  assert.equal(store.findLiveAddress('netflix@example.com').mail_count, 1);

  // A duplicate delivery (e.g. a lost ack) is ignored
  await delivery.handle(meta('m1'), buildRawMail());
  assert.equal(sent.length, 1);
});

test('a muted address does not ping', async () => {
  const address = store.findLiveAddress('netflix@example.com');
  store.updateAddress(address.id, { muted: true });
  await delivery.handle(meta('m1'), buildRawMail());
  assert.ok(!sent[0].message.content.includes('<@'));
});

test('an unknown address of an own domain lands in the owner\'s catch-all thread', async () => {
  await delivery.handle(meta('m1', 'whatever@example.com'), buildRawMail({ to: 'whatever@example.com' }));
  const catchAll = store.findLiveAddress('*@example.com');
  assert.equal(catchAll.user_id, OWNER);
  assert.equal(catchAll.kind, 'catchall');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].message.content.includes(`<@${OWNER}>`));
});

test('paused address: mail arriving through a catch-all rule is dropped, not delivered', async () => {
  const address = store.findLiveAddress('netflix@example.com');
  store.updateAddress(address.id, { status: 'paused' });
  await delivery.handle(meta('m1'), buildRawMail());
  assert.equal(sent.length, 0);
  assert.equal(store.getMail('m1').status, 'dropped');
  assert.equal(store.findLiveAddress('*@example.com'), null, 'did not end up with the owner');
});

test('deleted address: late mails go neither to the former owner nor to the catch-all', async () => {
  const address = store.findLiveAddress('netflix@example.com');
  store.updateAddress(address.id, { status: 'deleted', deleted_at: Date.now() });
  await delivery.handle(meta('m1'), buildRawMail());
  assert.equal(sent.length, 0);
  assert.equal(store.getMail('m1').status, 'dropped');
  assert.equal(store.findLiveAddress('*@example.com'), null);
});

test('subaddressing: name+tag@domain lands in the thread of name@domain', async () => {
  await delivery.handle(meta('m1', 'netflix+newsletter@example.com'), buildRawMail({ to: 'netflix+newsletter@example.com' }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].thread, `thread-${store.findLiveAddress('netflix@example.com').id}`);
});

test('invalid data (50035) → a plain version is sent instead of blocking the mail', async () => {
  forums.failWith = Object.assign(new Error('Invalid Form Body'), { code: 50035, status: 400 });
  await delivery.handle(meta('m1'), buildRawMail());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.embeds, undefined);
  assert.ok(sent[0].message.content.includes('could not be displayed in full'));
  assert.equal(store.getMail('m1').status, 'delivered');
});

test('upload timeout with attachments → retried without attachments', async () => {
  forums.failWith = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  await delivery.handle(meta('m1'), buildRawMail({ attachments: [{ name: 'large.bin', content: 'x' }] }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.files.length, 0);
});

test('after 24 hours of temporary errors the mail is saved instead of blocking forever', async () => {
  forums.failWith = Object.assign(new Error('Service Unavailable'), { status: 503 });
  await assert.rejects(delivery.handle(meta('m1'), buildRawMail()));
  store.run('UPDATE mails SET first_attempt_at = ? WHERE id = ?', Date.now() - 25 * 60 * 60 * 1000, 'm1');
  forums.failWith = Object.assign(new Error('Service Unavailable'), { status: 503 });
  await delivery.handle(meta('m1'), buildRawMail());
  const row = store.getMail('m1');
  assert.equal(row.status, 'failed');
  assert.ok(row.raw_path.includes('failed'));
  assert.equal(fs.existsSync(path.join(dataDir, 'mails', 'm1.eml')), false, 'no copy left in the normal folder');
});

test('mail for a foreign domain is dropped and logged', async () => {
  await delivery.handle(meta('m1', 'x@foreign.example'), buildRawMail({ to: 'x@foreign.example' }));
  assert.equal(sent.length, 0);
  assert.equal(store.getMail('m1').status, 'dropped');
  assert.equal(audits.length, 1);
});

test('a message that is too large is sent again without attachments', async () => {
  forums.failWith = Object.assign(new Error('Request entity too large'), { code: 40005, status: 413 });
  await delivery.handle(meta('m1'), buildRawMail({ attachments: [{ name: 'a.bin', content: 'x' }] }));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.files.length, 0);
  assert.ok(sent[0].message.embeds[0].data.fields.some((f) => f.name.includes('Note')));
});

test('temporary errors are not counted as failed attempts, permanent ones are (quarantine after 3)', async () => {
  forums.failWith = Object.assign(new Error('Service Unavailable'), { status: 503 });
  await assert.rejects(delivery.handle(meta('m1'), buildRawMail()));
  assert.equal(store.getMail('m1').attempts, 0);

  for (let i = 0; i < 2; i++) {
    forums.failWith = Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
    await assert.rejects(delivery.handle(meta('m1'), buildRawMail()));
  }
  forums.failWith = Object.assign(new Error('Missing Permissions'), { status: 403, code: 50013 });
  await delivery.handle(meta('m1'), buildRawMail()); // 3rd failed attempt → quarantine, no error anymore
  const row = store.getMail('m1');
  assert.equal(row.status, 'failed');
  assert.ok(fs.existsSync(row.raw_path));
  assert.ok(audits.some((a) => a.includes('could not be delivered')));
});

test('nothing is processed without a Discord connection', async () => {
  delivery.isDiscordReady = () => false;
  await assert.rejects(delivery.handle(meta('m1'), buildRawMail()), /not connected/);
  assert.equal(store.getMail('m1'), null);
});

test('cleanup deletes old originals', async () => {
  await delivery.handle(meta('m1'), buildRawMail());
  const { raw_path: rawPath } = store.getMail('m1');
  store.run('UPDATE mails SET received_at = 0 WHERE id = ?', 'm1');
  await delivery.cleanup();
  assert.equal(fs.existsSync(rawPath), false);
  assert.equal(store.getMail('m1').raw_path, null);
});
