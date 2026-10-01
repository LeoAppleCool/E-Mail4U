// E-Mail4U relay – uploaded to your Cloudflare account automatically by the bot.
//
// Email Routing hands mails to this worker. It stores them in a Durable Object (SQLite)
// until the bot fetches and acknowledges them over an outbound WebSocket connection.
// That way the bot needs no public endpoint, and no mail is lost while it is offline.

import { DurableObject } from 'cloudflare:workers';

const PROTOCOL_VERSION = 1;
const CHUNK_SIZE = 512 * 1024; // < 2 MB per SQLite value
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function relayStub(env) {
  return env.RELAY.get(env.RELAY.idFromName('relay'));
}

export default {
  async email(message, env) {
    // Stream the raw mail into the Durable Object – no buffering (and hardly any CPU) in this worker.
    const response = await relayStub(env).fetch('https://relay.internal/store', {
      method: 'POST',
      headers: {
        'x-mail-from': encodeURIComponent(message.from ?? ''),
        'x-rcpt-to': encodeURIComponent(message.to ?? ''),
      },
      body: message.raw,
    });
    if (!response.ok) {
      // Throw, so the mail is not lost silently.
      throw new Error(`E-Mail4U: storing the mail failed (${response.status} ${await response.text()})`);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if (!authorized(request, env)) return new Response('Unauthorized', { status: 401 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ ok: true, protocol: PROTOCOL_VERSION });
    }
    return relayStub(env).fetch(request);
  },
};

function authorized(request, env) {
  if (!env.RELAY_SECRET) return false;
  const encoder = new TextEncoder();
  const given = encoder.encode(request.headers.get('Authorization') ?? '');
  const expected = encoder.encode(`Bearer ${env.RELAY_SECRET}`);
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mails (
      id TEXT PRIMARY KEY,
      received_at INTEGER NOT NULL,
      mail_from TEXT,
      rcpt_to TEXT,
      size INTEGER NOT NULL,
      chunks INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chunks (
      mail_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (mail_id, idx)
    )`);
    // Answer keepalives without waking up the Durable Object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/store' && request.method === 'POST') {
      const raw = new Uint8Array(await request.arrayBuffer());
      const id = this.store(
        decodeURIComponent(request.headers.get('x-mail-from') ?? ''),
        decodeURIComponent(request.headers.get('x-rcpt-to') ?? ''),
        raw,
      );
      return Response.json({ id });
    }
    if (url.pathname === '/ws') return this.connect();
    return new Response('Not found', { status: 404 });
  }

  store(from, to, raw) {
    const id = crypto.randomUUID();
    const chunks = Math.max(1, Math.ceil(raw.byteLength / CHUNK_SIZE));
    this.ctx.storage.transactionSync(() => {
      const cutoff = Date.now() - MAX_AGE_MS;
      this.sql.exec('DELETE FROM chunks WHERE mail_id IN (SELECT id FROM mails WHERE received_at < ?)', cutoff);
      this.sql.exec('DELETE FROM mails WHERE received_at < ?', cutoff);
      this.sql.exec(
        'INSERT INTO mails (id, received_at, mail_from, rcpt_to, size, chunks) VALUES (?, ?, ?, ?, ?, ?)',
        id, Date.now(), from, to, raw.byteLength, chunks,
      );
      for (let i = 0; i < chunks; i++) {
        this.sql.exec(
          'INSERT INTO chunks (mail_id, idx, data) VALUES (?, ?, ?)',
          id, i, raw.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
        );
      }
    });
    const notice = JSON.stringify({ t: 'notify', pending: this.pendingCount() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(notice);
      } catch {
        // The connection is gone right now – the bot picks the mail up when it reconnects.
      }
    }
    return id;
  }

  connect() {
    // Only one bot connection at a time: replace older connections.
    for (const old of this.ctx.getWebSockets()) {
      try {
        old.close(4000, 'replaced');
      } catch {
        // already closed
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.t === 'ack' && typeof msg.id === 'string') {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM chunks WHERE mail_id = ?', msg.id);
        this.sql.exec('DELETE FROM mails WHERE id = ?', msg.id);
      });
    } else if (msg.t === 'next') {
      this.sendOldest(ws);
    }
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError() {}

  pendingCount() {
    return this.sql.exec('SELECT COUNT(*) AS n FROM mails').one().n;
  }

  sendOldest(ws) {
    const mail = this.sql.exec('SELECT * FROM mails ORDER BY received_at, id LIMIT 1').toArray()[0];
    const pending = this.pendingCount();
    if (!mail) {
      ws.send(JSON.stringify({ t: 'empty', pending }));
      return;
    }
    ws.send(JSON.stringify({
      t: 'mail',
      v: PROTOCOL_VERSION,
      id: mail.id,
      from: mail.mail_from,
      to: mail.rcpt_to,
      size: mail.size,
      chunks: mail.chunks,
      receivedAt: mail.received_at,
      pending,
    }));
    for (const row of this.sql.exec('SELECT data FROM chunks WHERE mail_id = ? ORDER BY idx', mail.id)) {
      ws.send(row.data);
    }
  }
}
