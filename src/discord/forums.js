import {
  ChannelType, ForumLayoutType, OverwriteType, PermissionFlagsBits as P, SortOrderType, ThreadAutoArchiveDuration,
} from 'discord.js';
import { UserError } from '../errors.js';
import { addressButtons, addressEmbed, threadName } from './ui.js';

/**
 * Permissions the bot needs in the category and the forums. (No "Manage Roles": only
 * administrators may set it in channel overwrites, and creating the forums doesn't need it.)
 */
export const BOT_CHANNEL_PERMISSIONS = [
  P.ViewChannel, P.ManageChannels, P.SendMessages, P.SendMessagesInThreads,
  P.ManageThreads, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory,
];

/**
 * Permissions the bot needs on the server: overwrites set while creating a channel may only
 * contain permissions the bot itself has on the server (incl. the ones it gives the user in the forum).
 */
export const REQUIRED_GUILD_PERMISSIONS = [...BOT_CHANNEL_PERMISSIONS, P.AddReactions];

// `legacy`: tag names of forums created by the first (German) version.
const TAGS = {
  active: { name: 'Active', emoji: '🟢', legacy: 'Aktiv' },
  paused: { name: 'Paused', emoji: '⏸️', legacy: 'Pausiert' },
  deleted: { name: 'Deleted', emoji: '🗑️', legacy: 'Gelöscht' },
};

const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

function forumName(user) {
  const slug = (user.username ?? 'user').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
  return `📬-${slug}`.slice(0, 100);
}

export class ForumManager {
  constructor({ client, store, config, log }) {
    this.client = client;
    this.store = store;
    this.config = config;
    this.log = log;
    this.forumLocks = new Map();
    this.threadLocks = new Map();
  }

  get guild() {
    const guild = this.client.guilds.cache.get(this.config.guildId);
    if (!guild) throw new Error(`The bot is not on the server ${this.config.guildId}.`);
    return guild;
  }

  /** Fetches a channel/thread; null if it doesn't exist (anymore). */
  async fetchChannel(id) {
    if (!id) return null;
    try {
      return await this.client.channels.fetch(id);
    } catch (err) {
      if (err.code === UNKNOWN_CHANNEL) return null;
      throw err;
    }
  }

  async category() {
    const id = this.store.getSetting('category_id');
    if (!id) throw new UserError('The bot isn\'t set up yet – the owner has to run `/setup category:` first.');
    const channel = await this.fetchChannel(id);
    if (!channel || channel.type !== ChannelType.GuildCategory) {
      throw new UserError('The configured category doesn\'t exist anymore – the owner has to run `/setup category:` again.');
    }
    return channel;
  }

  /** The user's private forum – created the first time it is needed. */
  async ensureForum(userId) {
    // Parallel calls for the same user must not create two forums.
    const running = this.forumLocks.get(userId);
    if (running) return running;
    const promise = this.#ensureForum(userId).finally(() => this.forumLocks.delete(userId));
    this.forumLocks.set(userId, promise);
    return promise;
  }

  async #ensureForum(userId) {
    const known = this.store.getUser(userId);
    if (known?.forum_id) {
      const existing = await this.fetchChannel(known.forum_id);
      if (existing?.type === ChannelType.GuildForum) return existing;
      this.store.forgetForum(known.forum_id);
    }

    const category = await this.category();
    if (category.children.cache.size >= 50) {
      throw new UserError('The category is full (Discord allows at most 50 channels). The owner has to pick a new one with `/setup category:`.');
    }
    const user = await this.client.users.fetch(userId);
    const guild = this.guild;
    const forum = await guild.channels.create({
      name: forumName(user),
      type: ChannelType.GuildForum,
      parent: category.id,
      topic: `Private mailboxes of ${user.username}. Every address has its own post – create one with /create, see all with /list.`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
        {
          id: userId,
          type: OverwriteType.Member,
          allow: [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads, P.AddReactions],
          // In forums "Send Messages" means "Create Posts" – only the bot does that.
          deny: [P.SendMessages],
        },
        { id: this.client.user.id, type: OverwriteType.Member, allow: BOT_CHANNEL_PERMISSIONS },
      ],
      availableTags: Object.values(TAGS).map((t) => ({ name: t.name, emoji: { id: null, name: t.emoji }, moderated: true })),
      defaultAutoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      defaultSortOrder: SortOrderType.LatestActivity,
      defaultForumLayout: ForumLayoutType.ListView,
      reason: `E-Mail4U: private mailbox for ${user.username}`,
    });
    this.store.upsertUser(userId, user.tag ?? user.username);
    this.store.setForum(userId, forum.id);
    this.log.info(`Created forum ${forum.name} (${forum.id}) for ${user.username}`);
    return forum;
  }

  tagId(forum, status) {
    const tag = TAGS[status];
    if (!tag) return null;
    return forum?.availableTags?.find((t) => t.name === tag.name || t.name === tag.legacy)?.id ?? null;
  }

  /** The address's thread – (re)created if it is missing. */
  async ensureThread(address) {
    // Only one call per address at a time, otherwise e.g. /create plus the first mail would create two threads.
    const running = this.threadLocks.get(address.id);
    if (running) return running;
    const promise = this.#ensureThread(address.id).finally(() => this.threadLocks.delete(address.id));
    this.threadLocks.set(address.id, promise);
    return promise;
  }

  async #ensureThread(addressId) {
    const address = this.store.getAddress(addressId);
    if (address.thread_id) {
      const thread = await this.fetchChannel(address.thread_id);
      if (thread?.isThread()) return thread;
      this.store.forgetThread(address.thread_id);
    }
    const forum = await this.ensureForum(address.user_id);
    const thread = await this.createThread(forum, address);
    this.store.updateAddress(address.id, { thread_id: thread.id });
    return thread;
  }

  async createThread(forum, address) {
    const tag = this.tagId(forum, address.status);
    const thread = await forum.threads.create({
      name: threadName(address),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      appliedTags: tag ? [tag] : [],
      message: {
        embeds: [addressEmbed(address)],
        components: addressButtons(address),
        allowedMentions: { parse: [] },
      },
      reason: `E-Mail4U: ${address.address}`,
    });
    // As a thread member the user follows the thread and sees it in the channel list.
    await thread.members.add(address.user_id).catch((err) => this.log.debug(`Thread member: ${err.message}`));
    return thread;
  }

  /** Updates the starter message, tag and archive state after the address changed. */
  async refreshThread(address) {
    const thread = await this.fetchChannel(address.thread_id);
    if (!thread?.isThread()) return;
    const wasArchived = thread.archived;
    if (wasArchived || thread.locked) await thread.edit({ archived: false, locked: false });

    const starter = await thread.fetchStarterMessage().catch((err) => {
      if (err.code === UNKNOWN_MESSAGE) return null;
      throw err;
    });
    if (starter) await starter.edit({ embeds: [addressEmbed(address)], components: addressButtons(address) });

    const tag = this.tagId(thread.parent, address.status);
    const deleted = address.status === 'deleted';
    await thread.edit({
      ...(tag ? { appliedTags: [tag] } : {}),
      ...(deleted ? { locked: true, archived: true } : wasArchived ? { archived: true } : {}),
    });
  }

  async deleteThread(threadId, reason) {
    const thread = await this.fetchChannel(threadId);
    if (thread?.isThread()) await thread.delete(reason);
  }

  /**
   * Upload limits for bot messages: 20 MiB per file (Discord, since 09/2026), with boosts
   * level 2 → 50 MiB, level 3 → 100 MiB. UPLOAD_LIMIT_MB overrides this.
   */
  uploadLimits() {
    const MiB = 1024 * 1024;
    if (this.config.uploadLimitMb) {
      const bytes = this.config.uploadLimitMb * MiB;
      return { perFile: bytes, perMessage: bytes };
    }
    const tier = this.guild.premiumTier ?? 0;
    const perFile = (tier >= 3 ? 100 : tier === 2 ? 50 : 20) * MiB;
    return { perFile, perMessage: Math.max(perFile, 25 * MiB) };
  }
}
