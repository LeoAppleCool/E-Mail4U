import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  user_id    TEXT PRIMARY KEY,
  tag        TEXT,
  forum_id   TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  user_id    TEXT NOT NULL,
  domain     TEXT NOT NULL,          -- lower-case domain, or '*' for all domains
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, domain)
);

CREATE TABLE IF NOT EXISTS addresses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  address      TEXT NOT NULL,
  local_part   TEXT NOT NULL,
  domain       TEXT NOT NULL,
  zone_id      TEXT NOT NULL,
  rule_id      TEXT,
  user_id      TEXT NOT NULL,
  thread_id    TEXT,
  note         TEXT,
  kind         TEXT NOT NULL DEFAULT 'address',  -- 'address' | 'catchall'
  status       TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'paused' | 'deleted'
  muted        INTEGER NOT NULL DEFAULT 0,
  mail_count   INTEGER NOT NULL DEFAULT 0,
  last_mail_at INTEGER,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS addresses_live ON addresses(address) WHERE status != 'deleted';
CREATE INDEX IF NOT EXISTS addresses_user ON addresses(user_id);
CREATE INDEX IF NOT EXISTS addresses_thread ON addresses(thread_id);

CREATE TABLE IF NOT EXISTS mails (
  id           TEXT PRIMARY KEY,       -- ID assigned by the Cloudflare relay
  address_id   INTEGER,
  rcpt         TEXT,
  mail_from    TEXT,
  subject      TEXT,
  size         INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | failed | dropped | deleted
  thread_id    TEXT,
  message_id   TEXT,
  raw_path     TEXT,
  received_at  INTEGER,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS mails_message ON mails(message_id);
`;

const ADDRESS_COLUMNS = new Set([
  'rule_id', 'thread_id', 'note', 'status', 'muted', 'deleted_at', 'user_id', 'zone_id',
]);
const MAIL_COLUMNS = new Set([
  'address_id', 'subject', 'status', 'thread_id', 'message_id', 'raw_path', 'processed_at',
]);

const now = () => Date.now();
const nil = (value) => (value === undefined ? null : value);

export class Store {
  /** @param {string} file path to the SQLite file, or ':memory:' */
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.statements = new Map();
    this.migrate();
  }

  migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get();
    if (version >= SCHEMA_VERSION) return;
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close() {
    this.db.close();
  }

  stmt(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql, ...params) {
    return this.stmt(sql).run(...params.map(nil));
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...params.map(nil)) ?? null;
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...params.map(nil));
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- Settings ----------

  getSetting(key, fallback = null) {
    return this.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;
  }

  setSetting(key, value) {
    if (value === null || value === undefined) this.run('DELETE FROM settings WHERE key = ?', key);
    else this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
  }

  // ---------- Users ----------

  upsertUser(userId, tag) {
    this.run(
      `INSERT INTO users (user_id, tag, created_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET tag = COALESCE(excluded.tag, users.tag)`,
      userId, tag, now(),
    );
  }

  getUser(userId) {
    return this.get('SELECT * FROM users WHERE user_id = ?', userId);
  }

  setForum(userId, forumId) {
    this.upsertUser(userId, null);
    this.run('UPDATE users SET forum_id = ? WHERE user_id = ?', forumId, userId);
  }

  /** A forum was deleted in Discord: drop the links to it. Returns the affected user ID. */
  forgetForum(forumId) {
    const user = this.get('SELECT user_id FROM users WHERE forum_id = ?', forumId);
    if (!user) return null;
    this.transaction(() => {
      this.run('UPDATE users SET forum_id = NULL WHERE user_id = ?', user.user_id);
      this.run('UPDATE addresses SET thread_id = NULL WHERE user_id = ?', user.user_id);
    });
    return user.user_id;
  }

  searchUsers(query, limit = 25) {
    const like = `%${String(query ?? '').toLowerCase()}%`;
    return this.all(
      `SELECT * FROM users WHERE lower(COALESCE(tag, '')) LIKE ? OR user_id LIKE ?
       ORDER BY tag LIMIT ?`,
      like, like, limit,
    );
  }

  // ---------- Domain grants ----------

  addGrant(userId, domain, grantedBy) {
    const result = this.run(
      'INSERT OR IGNORE INTO grants (user_id, domain, granted_by, granted_at) VALUES (?, ?, ?, ?)',
      userId, domain, grantedBy, now(),
    );
    return result.changes > 0;
  }

  removeGrant(userId, domain) {
    return this.run('DELETE FROM grants WHERE user_id = ? AND domain = ?', userId, domain).changes > 0;
  }

  grantsOf(userId) {
    return this.all('SELECT domain FROM grants WHERE user_id = ? ORDER BY domain', userId).map((r) => r.domain);
  }

  allGrants() {
    return this.all('SELECT * FROM grants ORDER BY domain, user_id');
  }

  // ---------- Addresses ----------

  insertAddress(a) {
    const result = this.run(
      `INSERT INTO addresses (address, local_part, domain, zone_id, rule_id, user_id, thread_id, note, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.address, a.localPart, a.domain, a.zoneId, a.ruleId, a.userId, a.threadId, a.note,
      a.kind ?? 'address', a.status ?? 'active', a.createdAt ?? now(),
    );
    return this.getAddress(Number(result.lastInsertRowid));
  }

  getAddress(id) {
    return this.get('SELECT * FROM addresses WHERE id = ?', id);
  }

  findLiveAddress(address) {
    return this.get("SELECT * FROM addresses WHERE address = ? AND status != 'deleted'", String(address).toLowerCase());
  }

  /** Did this address exist before (and has since been deleted)? */
  wasDeleted(address) {
    return Boolean(this.get("SELECT 1 AS x FROM addresses WHERE address = ? AND status = 'deleted' LIMIT 1", String(address).toLowerCase()));
  }

  liveAddressesOf(userId) {
    return this.all("SELECT * FROM addresses WHERE user_id = ? AND status != 'deleted' ORDER BY address", userId);
  }

  addressesByZone(zoneId) {
    return this.all("SELECT * FROM addresses WHERE zone_id = ? AND status != 'deleted'", zoneId);
  }

  allLiveAddresses() {
    return this.all("SELECT * FROM addresses WHERE status != 'deleted' ORDER BY address");
  }

  searchLiveAddresses(query, limit = 25) {
    return this.all(
      `SELECT * FROM addresses WHERE status != 'deleted' AND kind = 'address'
       AND (address LIKE ? OR lower(COALESCE(note, '')) LIKE ?) ORDER BY address LIMIT ?`,
      `%${query}%`, `%${String(query).toLowerCase()}%`, limit,
    );
  }

  countLiveAddresses(userId) {
    return this.get(
      "SELECT COUNT(*) AS n FROM addresses WHERE user_id = ? AND status != 'deleted' AND kind = 'address'",
      userId,
    ).n;
  }

  addressByThread(threadId) {
    return this.get('SELECT * FROM addresses WHERE thread_id = ? ORDER BY id DESC', threadId);
  }

  updateAddress(id, patch) {
    const keys = Object.keys(patch).filter((k) => ADDRESS_COLUMNS.has(k));
    if (!keys.length) return this.getAddress(id);
    const values = keys.map((k) => (typeof patch[k] === 'boolean' ? Number(patch[k]) : patch[k]));
    this.run(`UPDATE addresses SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...values, id);
    return this.getAddress(id);
  }

  /** Only used to roll back a failed /create. */
  deleteAddressRow(id) {
    this.run('DELETE FROM addresses WHERE id = ?', id);
  }

  forgetThread(threadId) {
    return this.run('UPDATE addresses SET thread_id = NULL WHERE thread_id = ?', threadId).changes;
  }

  countMail(addressId, at = now()) {
    this.run('UPDATE addresses SET mail_count = mail_count + 1, last_mail_at = ? WHERE id = ?', at, addressId);
  }

  // ---------- Mails ----------

  getMail(id) {
    return this.get('SELECT * FROM mails WHERE id = ?', id);
  }

  /** Creates the row or counts one more delivery attempt. Returns the updated row. */
  beginMail({ id, rcpt, from, size, receivedAt }) {
    this.run(
      `INSERT INTO mails (id, rcpt, mail_from, size, received_at, attempts, first_attempt_at) VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET attempts = attempts + 1`,
      id, rcpt, from, size, receivedAt, now(),
    );
    return this.getMail(id);
  }

  /** Temporary failure: don't count this attempt. */
  releaseAttempt(id) {
    this.run('UPDATE mails SET attempts = MAX(attempts - 1, 0) WHERE id = ?', id);
  }

  updateMail(id, patch) {
    const keys = Object.keys(patch).filter((k) => MAIL_COLUMNS.has(k));
    if (!keys.length) return;
    this.run(`UPDATE mails SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => patch[k]), id);
  }

  mailByMessage(messageId) {
    return this.get('SELECT * FROM mails WHERE message_id = ?', messageId);
  }

  mailsWithRawBefore(timestamp) {
    return this.all('SELECT id, raw_path FROM mails WHERE raw_path IS NOT NULL AND received_at < ?', timestamp);
  }

  stats() {
    return this.get(`SELECT
      (SELECT COUNT(*) FROM addresses WHERE status != 'deleted' AND kind = 'address') AS addresses,
      (SELECT COUNT(DISTINCT user_id) FROM addresses WHERE status != 'deleted' AND kind = 'address') AS users,
      (SELECT COUNT(*) FROM mails WHERE status = 'delivered') AS mails,
      (SELECT MAX(processed_at) FROM mails WHERE status = 'delivered') AS last_mail_at`);
  }
}
