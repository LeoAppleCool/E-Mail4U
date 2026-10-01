import { UserError } from '../errors.js';
import { isReservedLocalPart, normalizeLocalPart, validateLocalPart } from '../util/validate.js';
import { CloudflareError } from '../cloudflare/client.js';
import { ruleIdOf } from '../cloudflare/domains.js';

export const DEFAULT_ADDRESS_LIMIT = 25;
// Cloudflare: matcher values of a routing rule may be at most 90 characters long.
export const MAX_ADDRESS_LENGTH = 90;

/** Name of the rule in the Cloudflare dashboard. The user ID in it lets the sync restore ownership. */
export function ruleName(userTag, userId, note) {
  return `E-Mail4U · ${userTag} (${userId})${note ? ` · ${note}` : ''}`.slice(0, 256);
}

export function userIdFromRuleName(name) {
  // The first "(ID)" after the username – an ID inside the note doesn't count.
  return String(name ?? '').match(/^E-Mail4U · [^(]*\((\d{17,20})\)/)?.[1] ?? null;
}

const DISCORD_PERMISSION_ERRORS = new Set([50001, 50013]); // Missing Access / Missing Permissions

function friendlyDiscordError(err) {
  if (!DISCORD_PERMISSION_ERRORS.has(err?.code)) return err;
  return new UserError('I\'m missing server permissions to create your mailbox forum. '
    + 'The owner can check what is missing with `/setup`.');
}

/**
 * Creating, pausing and deleting addresses – keeps Cloudflare, the database and Discord consistent.
 */
export class AddressService {
  constructor({ store, domains, forums, access, log, audit }) {
    this.store = store;
    this.domains = domains;
    this.forums = forums;
    this.access = access;
    this.log = log;
    this.audit = audit;
    this.pending = new Set();
    this.creatingFor = new Set();
  }

  limit() {
    return Number(this.store.getSetting('address_limit', DEFAULT_ADDRESS_LIMIT));
  }

  /**
   * @param {{ user: import('discord.js').User, name: string, domain: string, note?: string }} input
   */
  async create(input) {
    // Only one /create per user at a time – otherwise parallel calls could bypass the limit.
    const userId = input.user.id;
    if (this.creatingFor.has(userId)) throw new UserError('One moment – an address is already being created for you.');
    this.creatingFor.add(userId);
    try {
      return await this.#create(input);
    } finally {
      this.creatingFor.delete(userId);
    }
  }

  async #create({ user, name, domain, note }) {
    const owner = this.access.isOwner(user.id);
    const localPart = normalizeLocalPart(name);
    const problem = validateLocalPart(localPart);
    if (problem) throw new UserError(`"${localPart || name}" doesn't work: ${problem}`);
    if (!owner && isReservedLocalPart(localPart)) {
      throw new UserError(`"${localPart}" is reserved (e.g. for domain administration and certificates). Please pick another name.`);
    }

    const zone = this.domains.get(domain);
    if (!zone || !this.access.canUseDomain(user.id, zone.name)) {
      throw new UserError('This domain doesn\'t exist or you have no access to it – please pick one from the suggestions.');
    }
    if (zone.routing?.enabled === false) {
      throw new UserError(`Email Routing is not enabled for **${zone.name}** in Cloudflare. The owner has to turn it on in the dashboard under "Email → Email Routing".`);
    }
    if (!owner) {
      const count = this.store.countLiveAddresses(user.id);
      const limit = this.limit();
      if (count >= limit) throw new UserError(`You already have ${count} addresses (limit: ${limit}). Delete one with \`/delete\` first.`);
    }

    const address = `${localPart}@${zone.name}`;
    if (address.length > MAX_ADDRESS_LENGTH) {
      throw new UserError(`The address is too long – Cloudflare allows at most ${MAX_ADDRESS_LENGTH} characters.`);
    }
    if (this.pending.has(address) || this.store.findLiveAddress(address)) throw new UserError(`**${address}** is already taken.`);

    this.pending.add(address);
    try {
      const existingRule = await this.domains.findRuleFor(zone.id, address);
      if (existingRule) throw new UserError(`**${address}** already exists as a custom address in Cloudflare.`);

      // Forum first – if that fails (e.g. missing permissions), nothing has been created in Cloudflare yet.
      await this.forums.ensureForum(user.id).catch((err) => { throw friendlyDiscordError(err); });
      const cleanNote = note?.trim().slice(0, 100) || null;
      const rule = await this.domains.createRule(zone.id, {
        address, name: ruleName(user.username, user.id, cleanNote),
      }).catch((err) => {
        if (!(err instanceof CloudflareError)) throw err;
        const detail = err.errors.map((e) => e.message).join('; ') || err.message;
        throw new UserError(`Cloudflare rejected the address: ${detail}`);
      });

      let row = null;
      try {
        row = this.store.insertAddress({
          address, localPart, domain: zone.name, zoneId: zone.id, ruleId: ruleIdOf(rule),
          userId: user.id, threadId: null, note: cleanNote,
        });
        // ensureThread locks per address – if the first mail arrives in parallel, no second thread is created.
        const thread = await this.forums.ensureThread(row).catch((err) => { throw friendlyDiscordError(err); });
        row = this.store.getAddress(row.id);
        this.log.info(`Created address ${address} for ${user.username} (${user.id})`);
        this.audit?.(`🆕 <@${user.id}> created **${address}**${cleanNote ? ` ("${cleanNote}")` : ''}.`);
        return { address: row, thread };
      } catch (err) {
        await this.domains.deleteRule(zone.id, ruleIdOf(rule)).catch((e) => this.log.error(`Rollback failed (${address}):`, e));
        if (row) this.store.deleteAddressRow(row.id);
        throw err;
      }
    } finally {
      this.pending.delete(address);
    }
  }

  /** Loads an address and checks that `actorId` may manage it. */
  manageable(addressId, actorId) {
    const address = this.store.getAddress(Number(addressId));
    if (!address) throw new UserError('This address doesn\'t exist (anymore).');
    if (address.user_id !== actorId && !this.access.isOwner(actorId)) throw new UserError('That is not your address.');
    return address;
  }

  async remove(addressId, actorId, { deleteThread = false } = {}) {
    const address = this.manageable(addressId, actorId);
    if (address.status === 'deleted') throw new UserError('This address is already deleted.');
    if (address.kind === 'address' && address.rule_id) await this.domains.deleteRule(address.zone_id, address.rule_id);

    let updated = this.store.updateAddress(address.id, { status: 'deleted', deleted_at: Date.now() });
    if (deleteThread && address.thread_id) {
      await this.forums.deleteThread(address.thread_id, `E-Mail4U: ${address.address} deleted`)
        .catch((err) => this.log.warn(`Thread ${address.thread_id} not deleted: ${err.message}`));
      updated = this.store.updateAddress(address.id, { thread_id: null });
    } else if (address.thread_id) {
      await this.forums.refreshThread(updated).catch((err) => this.log.warn(`Thread not updated: ${err.message}`));
    }
    this.log.info(`Deleted address ${address.address} (by ${actorId})`);
    this.audit?.(`🗑️ **${address.address}** (<@${address.user_id}>) was deleted by <@${actorId}>.`);
    return updated;
  }

  async setPaused(addressId, actorId, paused) {
    const address = this.manageable(addressId, actorId);
    if (address.kind !== 'address') throw new UserError('Catch-all threads can\'t be paused.');
    if (address.status === 'deleted') throw new UserError('This address is deleted.');
    const rule = address.rule_id
      ? await this.domains.updateRule(address.zone_id, address.rule_id, { address: address.address, enabled: !paused })
      : null;
    if (!rule) {
      const updated = this.store.updateAddress(address.id, { status: 'deleted', deleted_at: Date.now() });
      await this.forums.refreshThread(updated).catch(() => {});
      throw new UserError('This address no longer exists in Cloudflare (it was probably deleted in the dashboard) and is now marked as deleted.');
    }
    const updated = this.store.updateAddress(address.id, { status: paused ? 'paused' : 'active' });
    await this.forums.refreshThread(updated).catch((err) => this.log.warn(`Thread not updated: ${err.message}`));
    return updated;
  }

  async setMuted(addressId, actorId, muted) {
    this.manageable(addressId, actorId);
    const updated = this.store.updateAddress(Number(addressId), { muted });
    await this.forums.refreshThread(updated).catch((err) => this.log.warn(`Thread not updated: ${err.message}`));
    return updated;
  }

  async setNote(addressId, actorId, note) {
    const address = this.manageable(addressId, actorId);
    const cleanNote = note?.trim().slice(0, 100) || null;
    const updated = this.store.updateAddress(address.id, { note: cleanNote });
    if (address.kind === 'address' && address.rule_id && address.status !== 'deleted') {
      const tag = this.store.getUser(address.user_id)?.tag ?? address.user_id;
      await this.domains.updateRule(address.zone_id, address.rule_id, {
        address: address.address, name: ruleName(tag, address.user_id, cleanNote),
      }).catch((err) => this.log.warn(`Rule name not updated: ${err.message}`));
    }
    await this.forums.refreshThread(updated).catch((err) => this.log.warn(`Thread not updated: ${err.message}`));
    return updated;
  }
}
