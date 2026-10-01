import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { silentLogger } from '../src/log.js';
import { RelayClient } from '../src/relay/client.js';

const CHUNK = 1000;

/** Re-implementation of the Durable Object protocol from worker/relay.js. */
function fakeRelay({ secret = 's3cret' } = {}) {
  const mails = [];
  const wss = new WebSocketServer({ port: 0 });
  const server = { mails, wss, connections: 0, acks: [], authHeaders: [] };
  wss.on('connection', (ws, req) => {
    server.connections++;
    server.authHeaders.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${secret}`) {
      ws.close(4001, 'unauthorized');
      return;
    }
    server.socket = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text === 'ping') return ws.send('pong');
      const msg = JSON.parse(text);
      if (msg.t === 'ack') {
        server.acks.push(msg.id);
        const index = mails.findIndex((m) => m.id === msg.id);
        if (index >= 0) mails.splice(index, 1);
      } else if (msg.t === 'next') {
        const mail = mails[0];
        if (!mail) return ws.send(JSON.stringify({ t: 'empty', pending: 0 }));
        const chunks = Math.max(1, Math.ceil(mail.raw.length / CHUNK));
        ws.send(JSON.stringify({ t: 'mail', id: mail.id, from: mail.from, to: mail.to, size: mail.raw.length, chunks, receivedAt: 1, pending: mails.length }));
        for (let i = 0; i < chunks; i++) ws.send(mail.raw.subarray(i * CHUNK, (i + 1) * CHUNK));
      }
      return undefined;
    });
  });
  server.add = (id, raw) => {
    mails.push({ id, from: 'a@b.example', to: 'x@example.com', raw });
    server.socket?.send(JSON.stringify({ t: 'notify', pending: mails.length }));
  };
  server.url = () => `ws://127.0.0.1:${wss.address().port}/ws`;
  return server;
}

function waitFor(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeout) return reject(new Error('Timeout'));
      return setTimeout(tick, 10);
    };
    tick();
  });
}

test('fetches buffered and new mails, reassembles chunks and acknowledges them', async (t) => {
  const server = fakeRelay();
  await once(server.wss, 'listening');
  const big = Buffer.from(Array.from({ length: 3500 }, (_, i) => i % 251));
  server.add('m1', Buffer.from('first mail'));
  server.add('m2', big);

  const received = [];
  const client = new RelayClient({
    url: server.url(), secret: 's3cret', log: silentLogger,
    onMail: async (meta, raw) => received.push({ id: meta.id, raw }),
  });
  t.after(() => { client.stop(); server.wss.close(); });
  client.start();

  await waitFor(() => received.length === 2);
  assert.equal(received[0].raw.toString(), 'first mail');
  assert.ok(received[1].raw.equals(big));
  await waitFor(() => server.acks.length === 2);
  assert.equal(server.authHeaders[0], 'Bearer s3cret');

  server.add('m3', Buffer.from('later'));
  await waitFor(() => received.length === 3);
  await waitFor(() => server.mails.length === 0);
  assert.equal(client.status.connected, true);
});

test('retries after an error and only acknowledges after success', async (t) => {
  const server = fakeRelay();
  await once(server.wss, 'listening');
  server.add('m1', Buffer.from('hello'));
  let attempts = 0;
  const client = new RelayClient({
    url: server.url(), secret: 's3cret', log: silentLogger, retryBaseMs: 20,
    onMail: async () => {
      attempts++;
      if (attempts < 3) throw new Error('Discord is down');
    },
  });
  t.after(() => { client.stop(); server.wss.close(); });
  client.start();
  await waitFor(() => server.acks.length === 1);
  assert.equal(attempts, 3);
  assert.deepEqual(server.acks, ['m1']);
});

test('new mails do not skip the delay after an error', async (t) => {
  const server = fakeRelay();
  await once(server.wss, 'listening');
  server.add('m1', Buffer.from('stuck'));
  const tries = [];
  const client = new RelayClient({
    url: server.url(), secret: 's3cret', log: silentLogger, retryBaseMs: 400,
    onMail: async () => {
      tries.push(Date.now());
      if (tries.length === 1) throw new Error('broken');
    },
  });
  t.after(() => { client.stop(); server.wss.close(); });
  client.start();
  await waitFor(() => tries.length === 1);
  server.add('m2', Buffer.from('new')); // sends "notify"
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(tries.length, 1, 'no immediate second attempt');
  await waitFor(() => server.acks.length === 2);
  assert.ok(tries[1] - tries[0] >= 350, 'the delay was respected');
});

test('reconnects after a disconnect and fetches unacknowledged mails again', async (t) => {
  const server = fakeRelay();
  await once(server.wss, 'listening');
  const seen = [];
  const client = new RelayClient({
    url: server.url(), secret: 's3cret', log: silentLogger, reconnectBaseMs: 20,
    onMail: async (meta) => { seen.push(meta.id); },
  });
  t.after(() => { client.stop(); server.wss.close(); });
  client.start();
  await waitFor(() => client.status.connected);
  server.socket.terminate();
  await waitFor(() => server.connections === 2 && client.status.connected);
  server.add('m1', Buffer.from('after the reconnect'));
  await waitFor(() => server.acks.includes('m1'));
  assert.deepEqual(seen, ['m1']);
});
