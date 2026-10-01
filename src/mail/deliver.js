import fs from 'node:fs/promises';
import path from 'node:path';
import { parseMail } from './parse.js';
import { buildMailMessage, withoutFiles } from './render.js';

const MAX_ATTEMPTS = 3;
// A mail that keeps failing with temporary errors for this long is given up (and saved to disk),
// so it doesn't block every mail queued behind it.
const MAX_TRANSIENT_MS = 24 * 60 * 60 * 1000;
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);
const REQUEST_TOO_LARGE = 40005;
const INVALID_FORM_BODY = 50035;

export class TransientError extends Error {}

const isTooLarge = (err) => err?.code === REQUEST_TOO_LARGE || err?.status === 413;
const isTimeout = (err) => err?.name === 'AbortError' || err?.name === 'TimeoutError';

/** Network/server problems → retry later without counting it as a failed attempt. */
export function isTransient(err) {
  if (err instanceof TransientError) return true;
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  if (TRANSIENT_CODES.has(err?.code) || TRANSIENT_CODES.has(err?.cause?.code)) return true;
  const status = err?.status ?? err?.httpStatus;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * Handles a mail coming from the relay: find the address, make sure its thread exists, post it.
 */
export class MailDelivery {
  constructor({ store, forums, access, domains, config, log, audit, isDiscordReady }) {
    this.store = store;
    this.forums = forums;
    this.access = access;
    this.domains = domains;
    this.config = config;
    this.log = log;
    this.audit = audit;
    this.isDiscordReady = isDiscordReady;
    this.mailDir = path.join(config.dataDir, 'mails');
    this.failedDir = path.join(config.dataDir, 'failed');
  }

  rawPath(id) {
    return path.join(this.mailDir, `${id}.eml`);
  }

  async handle(meta, raw) {
    if (!this.isDiscordReady()) throw new TransientError('Discord is not connected right now');
    const known = this.store.getMail(meta.id);
    if (known && known.status !== 'pending') return; // already handled (e.g. the ack got lost)

    const rcpt = String(meta.to ?? '').toLowerCase();
    const row = this.store.beginMail({
      id: meta.id, rcpt, from: meta.from, size: raw.length, receivedAt: meta.receivedAt ?? Date.now(),
    });
    try {
      if (row.attempts > MAX_ATTEMPTS) {
        await this.quarantine(meta, raw, `given up after ${MAX_ATTEMPTS} failed attempts`);
        return;
      }
      await this.deliver(meta, rcpt, raw);
    } catch (err) {
      if (isTransient(err)) {
        this.store.releaseAttempt(meta.id);
        if (Date.now() - row.first_attempt_at > MAX_TRANSIENT_MS) {
          await this.quarantine(meta, raw, `undeliverable for more than 24 hours (${err.message})`);
          return;
        }
        throw err;
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        await this.quarantine(meta, raw, err.message);
        return;
      }
      throw err;
    }
  }

  /** Finds the address a mail belongs to – or the reason it is dropped. */
  resolve(rcpt) {
    // Subaddressing: Cloudflare delivers name+tag@domain through the rule for name@domain.
    const base = rcpt.replace(/\+[^@]*@/, '@');
    const address = this.store.findLiveAddress(rcpt) ?? (base !== rcpt ? this.store.findLiveAddress(base) : null);
    // Paused means paused – even if a catch-all rule still routes the mail to the worker.
    if (address?.status === 'paused') return { drop: 'address is paused' };
    if (address) return { address };
    // Mail for deleted addresses belongs neither to the former owner nor in the catch-all.
    if (this.store.wasDeleted(rcpt) || this.store.wasDeleted(base)) return { drop: 'address was deleted' };
    const catchAll = this.catchAllFor(rcpt);
    return catchAll ? { address: catchAll } : { drop: 'unknown address', unknown: true };
  }

  async deliver(meta, rcpt, raw) {
    const { address, drop, unknown } = this.resolve(rcpt);
    if (!address) {
      this.store.updateMail(meta.id, { status: 'dropped', processed_at: Date.now() });
      this.log.info(`Mail to ${rcpt} dropped: ${drop}`);
      if (unknown) this.audit?.(`⚠️ Mail to the unknown address \`${rcpt}\` from \`${meta.from}\` was dropped.`);
      return;
    }

    const mail = await parseMail(raw);
    let rawPath = null;
    if (this.config.mailRetentionDays > 0) {
      rawPath = this.rawPath(meta.id);
      await fs.mkdir(this.mailDir, { recursive: true });
      await fs.writeFile(rawPath, raw);
    }

    const thread = await this.forums.ensureThread(address);
    const limits = this.forums.uploadLimits();
    const message = buildMailMessage({
      mail,
      rcpt,
      mailId: meta.id,
      receivedAt: meta.receivedAt,
      limits,
      mentionUserId: address.muted ? null : address.user_id,
      originalAvailable: Boolean(rawPath),
    });

    const sent = await this.send(thread, message);
    for (const extra of message.extra) {
      await thread.send(extra).catch((err) => this.log.warn(`Additional attachments not sent: ${err.message}`));
    }

    this.store.updateMail(meta.id, {
      address_id: address.id,
      subject: mail.subject.slice(0, 300),
      status: 'delivered',
      thread_id: thread.id,
      message_id: sent.id,
      raw_path: rawPath,
      processed_at: Date.now(),
    });
    this.store.countMail(address.id);
    this.log.info(`Mail to ${rcpt} delivered (thread ${thread.id})`);
  }

  /** Sends the message; on problems first without attachments, then as a plain version. */
  async send(thread, message) {
    let payload = message.main;
    for (;;) {
      try {
        return await thread.send(payload);
      } catch (err) {
        if (payload.files?.length && (isTooLarge(err) || isTimeout(err))) {
          this.log.warn(`Attachments too large or upload too slow (${err.message}) – sending without attachments`);
          payload = withoutFiles(payload, 'The attachments were too large for Discord (or the upload took too long) and are missing here.');
          continue;
        }
        if (err.code === INVALID_FORM_BODY && payload !== message.fallback) {
          this.log.warn(`Discord rejected the message (${err.message}) – sending a simplified version`);
          payload = message.fallback;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Mail for unregistered addresses (e.g. catch-all → worker) goes to the owner,
   * into one collection thread per domain.
   */
  catchAllFor(rcpt) {
    const domain = rcpt.split('@')[1];
    const zone = domain ? this.domains.get(domain) : null;
    const ownerId = this.access.primaryOwner();
    if (!zone || !ownerId) return null;
    const existing = this.store.findLiveAddress(`*@${zone.name}`);
    if (existing) return existing;
    return this.store.insertAddress({
      address: `*@${zone.name}`, localPart: '*', domain: zone.name, zoneId: zone.id,
      ruleId: null, userId: ownerId, threadId: null, note: null, kind: 'catchall',
    });
  }

  async quarantine(meta, raw, reason) {
    await fs.mkdir(this.failedDir, { recursive: true });
    const file = path.join(this.failedDir, `${meta.id}.eml`);
    await fs.writeFile(file, raw);
    await fs.rm(this.rawPath(meta.id), { force: true });
    this.store.updateMail(meta.id, { status: 'failed', raw_path: file, processed_at: Date.now() });
    this.log.error(`Mail ${meta.id} to ${meta.to} could not be delivered (${reason}) – saved to ${file}`);
    this.audit?.(`❌ Mail to \`${meta.to}\` from \`${meta.from}\` could not be delivered: ${reason}\nSaved to \`${file}\`.`);
  }

  /** Deletes stored original mails older than the retention period. */
  async cleanup() {
    const days = this.config.mailRetentionDays;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const row of this.store.mailsWithRawBefore(cutoff)) {
      if (row.raw_path.startsWith(this.failedDir)) continue;
      await fs.rm(row.raw_path, { force: true });
      this.store.updateMail(row.id, { raw_path: null });
      removed++;
    }
    if (removed) this.log.info(`Deleted ${removed} old original mail(s)`);
  }
}
