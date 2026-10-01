import WebSocket from 'ws';

const MAX_RECONNECT_DELAY = 60_000;
const MAX_RETRY_DELAY = 5 * 60_000;

/**
 * Keeps an outbound WebSocket connection to the Cloudflare worker (Durable Object).
 * The worker buffers incoming mails; the bot fetches them one by one:
 *
 *   bot → worker:  {"t":"next"}              request the next (oldest) mail
 *                  {"t":"ack","id":"…"}      mail handled → delete it in the worker
 *                  "ping"                    keepalive (the worker answers "pong")
 *   worker → bot:  {"t":"mail",…,"chunks":n} followed by n binary frames (raw data)
 *                  {"t":"empty"}             nothing left
 *                  {"t":"notify"}            a new mail arrived
 */
export class RelayClient {
  constructor({ url, secret, onMail, log, pingIntervalMs = 30_000, retryBaseMs = 5000, reconnectBaseMs = 1000 }) {
    this.url = url;
    this.secret = secret;
    this.onMail = onMail;
    this.log = log;
    this.pingIntervalMs = pingIntervalMs;
    this.retryBaseMs = retryBaseMs;
    this.reconnectBaseMs = reconnectBaseMs;
    this.ws = null;
    this.stopped = true;
    this.reconnectAttempt = 0;
    this.retryDelay = 0;
    this.current = null;
    this.processing = false;
    this.waiting = false;
    this.retryScheduled = false;
    this.timers = new Set();
    this.state = {
      connected: false, connectedSince: null, disconnectedSince: Date.now(), pending: null, lastMailAt: null, lastError: null,
    };
  }

  get status() {
    return { ...this.state };
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    clearInterval(this.heartbeat);
    this.ws?.close(1000, 'shutdown');
  }

  later(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${this.secret}` },
      handshakeTimeout: 15_000,
      maxPayload: 8 * 1024 * 1024,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.state.connected = true;
      this.state.connectedSince = Date.now();
      this.state.disconnectedSince = null;
      this.state.lastError = null;
      this.log.info('Relay: connected to the Cloudflare worker');
      this.startHeartbeat(ws);
      if (!this.processing) this.requestNext();
    });
    ws.on('message', (data, isBinary) => {
      this.lastSeen = Date.now();
      this.handleMessage(data, isBinary);
    });
    ws.on('error', (err) => {
      this.state.lastError = err.message;
      this.log.warn(`Relay: ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      clearInterval(this.heartbeat);
      if (this.state.connected) this.state.disconnectedSince = Date.now();
      this.state.connected = false;
      this.current = null;
      this.waiting = false;
      if (this.stopped) return;
      const text = reason?.toString() || '';
      let delay;
      if (code === 4000) {
        delay = MAX_RECONNECT_DELAY;
        this.log.warn('Relay: another bot instance took over the connection. Is the bot running twice?');
      } else {
        delay = Math.min(this.reconnectBaseMs * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY)
          + Math.floor(Math.random() * this.reconnectBaseMs / 2);
        this.reconnectAttempt++;
        this.log.warn(`Relay: disconnected (${code}${text ? ` ${text}` : ''}), retrying in ${Math.round(delay / 1000)} s`);
      }
      this.later(() => this.connect(), delay);
    });
  }

  startHeartbeat(ws) {
    clearInterval(this.heartbeat);
    this.lastSeen = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > this.pingIntervalMs * 2 + 10_000) {
        this.log.warn('Relay: no response anymore – reconnecting');
        ws.terminate();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, this.pingIntervalMs);
  }

  send(message) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    return true;
  }

  requestNext({ retry = false } = {}) {
    if (retry) this.retryScheduled = false;
    // While waiting after an error, don't let new mails skip the delay.
    if (this.processing || this.waiting || this.retryScheduled) return;
    if (this.send({ t: 'next' })) this.waiting = true;
  }

  handleMessage(data, isBinary) {
    if (isBinary) {
      if (!this.current) return;
      this.current.parts.push(Buffer.from(data));
      if (this.current.parts.length >= this.current.meta.chunks) this.finish();
      return;
    }
    const text = data.toString();
    if (text === 'pong') return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.pending === 'number') this.state.pending = msg.pending;
    switch (msg.t) {
      case 'mail':
        this.current = { meta: msg, parts: [] };
        if (!msg.chunks) this.finish();
        break;
      case 'empty':
        this.waiting = false;
        break;
      case 'notify':
        this.requestNext();
        break;
      default:
        break;
    }
  }

  async finish() {
    const { meta, parts } = this.current;
    this.current = null;
    this.waiting = false;
    this.processing = true;
    const raw = Buffer.concat(parts);
    try {
      if (raw.length !== meta.size) throw new Error(`Incomplete transfer (${raw.length}/${meta.size} bytes)`);
      await this.onMail(meta, raw);
      this.retryDelay = 0;
      this.state.lastMailAt = Date.now();
      this.processing = false;
      this.send({ t: 'ack', id: meta.id });
      this.requestNext();
    } catch (err) {
      this.processing = false;
      this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : this.retryBaseMs, MAX_RETRY_DELAY);
      this.log.error(`Relay: mail ${meta.id} could not be processed – retrying in ${Math.round(this.retryDelay / 1000)} s:`, err);
      this.retryScheduled = true;
      this.later(() => this.requestNext({ retry: true }), this.retryDelay);
    }
  }
}
