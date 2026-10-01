import { MessageFlags, PermissionsBitField } from 'discord.js';
import { UserError } from '../../errors.js';
import { truncate } from '../../mail/format.js';
import { ALL_DOMAINS } from '../../services/access.js';
import { BOT_CHANNEL_PERMISSIONS, REQUIRED_GUILD_PERMISSIONS } from '../forums.js';
import { COLORS, respond, simpleEmbed, ts } from '../ui.js';
import { requireOwner } from './perms.js';

const PERMISSION_NAMES = {
  ViewChannel: 'View Channels',
  ManageChannels: 'Manage Channels',
  SendMessages: 'Send Messages',
  SendMessagesInThreads: 'Send Messages in Threads',
  ManageThreads: 'Manage Threads',
  EmbedLinks: 'Embed Links',
  AttachFiles: 'Attach Files',
  ReadMessageHistory: 'Read Message History',
  AddReactions: 'Add Reactions',
};

function missing(have, required) {
  return new PermissionsBitField(required).toArray()
    .filter((name) => !have?.has(PermissionsBitField.Flags[name]))
    .map((name) => PERMISSION_NAMES[name] ?? name);
}

function missingPermissions(channel, member, required) {
  return missing(channel.permissionsFor(member), required);
}

function routingBadge(zone) {
  const { enabled, status } = zone.routing ?? {};
  if (enabled === null || enabled === undefined) return '❔';
  if (!enabled) return '⛔';
  return status && status !== 'ready' ? '⚠️' : '✅';
}

function cloudflareLine(app, zoneCount, routed) {
  const { ready, error } = app.cloudflare ?? {};
  if (ready === false && error) return `⚠️ ${truncate(error, 500)}\n-# The bot retries every 5 minutes.`;
  if (ready === false) return '⏳ connecting …';
  return `${zoneCount} domain(s), ${routed} with Email Routing · worker \`${app.config.workerName}\``;
}

export function statusEmbed(app) {
  const { store, relay, domains } = app;
  const category = store.getSetting('category_id');
  const logChannel = store.getSetting('log_channel_id');
  const relayState = relay.status;
  const stats = store.stats();
  const zones = domains.list();
  const routed = zones.filter((z) => z.routing?.enabled).length;

  const relayLine = relayState.connected
    ? `🟢 connected ${ts(relayState.connectedSince, 'R')}${relayState.pending ? ` · ${relayState.pending} mail(s) queued` : ''}`
    : `🔴 not connected${relayState.lastError ? ` – ${truncate(relayState.lastError, 150)}` : ''}`;

  return simpleEmbed(COLORS.info, [
    `**Category:** ${category ? `<#${category}>` : '⚠️ not set yet – `/setup category:`'}`,
    `**Limit:** ${app.addresses.limit()} addresses per user`,
    `**Log channel:** ${logChannel ? `<#${logChannel}>` : 'off'}`,
    `**Owner:** ${app.access.ownerIds().map((id) => `<@${id}>`).join(', ') || '–'}`,
    '',
    `**Relay worker:** ${relayLine}`,
    `**Cloudflare:** ${cloudflareLine(app, zones.length, routed)}`,
    `**Stats:** ${stats.addresses} address(es) of ${stats.users} user(s) · ${stats.mails} mail(s) delivered`
      + (stats.last_mail_at ? ` · last ${ts(stats.last_mail_at, 'R')}` : ''),
  ].join('\n'), '⚙️ E-Mail4U – Status');
}

export async function handleSetup(app, interaction) {
  requireOwner(app, interaction);
  const category = interaction.options.getChannel('category');
  const limit = interaction.options.getInteger('limit');
  const logChannel = interaction.options.getChannel('log');
  const logOff = interaction.options.getBoolean('log_off');
  const me = interaction.guild.members.me;
  const changes = [];

  if (category) {
    // Server level: the bot may only grant permissions in forum overwrites that it has itself.
    const onServer = missing(me.permissions, REQUIRED_GUILD_PERMISSIONS);
    if (onServer.length) {
      throw new UserError(`My bot role is missing these server permissions: ${onServer.join(', ')}. `
        + 'Grant them to the role in the server settings (or re-invite the bot with the link from the log).');
    }
    const inCategory = missingPermissions(category, me, BOT_CHANNEL_PERMISSIONS);
    if (inCategory.length) throw new UserError(`I'm missing these permissions in ${category}: ${inCategory.join(', ')}.`);
    app.store.setSetting('category_id', category.id);
    changes.push(`Category: ${category}`);
  }
  if (limit) {
    app.store.setSetting('address_limit', limit);
    changes.push(`Limit: ${limit} addresses per user`);
  }
  if (logChannel) {
    const { ViewChannel, SendMessages, EmbedLinks } = PermissionsBitField.Flags;
    const inLog = missingPermissions(logChannel, me, [ViewChannel, SendMessages, EmbedLinks]);
    if (inLog.length) throw new UserError(`I'm missing these permissions in ${logChannel}: ${inLog.join(', ')}.`);
    app.store.setSetting('log_channel_id', logChannel.id);
    changes.push(`Log channel: ${logChannel}`);
  } else if (logOff) {
    app.store.setSetting('log_channel_id', null);
    changes.push('Log channel: off');
  }

  const embeds = [];
  if (changes.length) embeds.push(simpleEmbed(COLORS.ok, changes.join('\n'), '✅ Saved'));
  embeds.push(statusEmbed(app));
  await respond(interaction, { embeds });
}

export async function handleDomains(app, interaction) {
  const owner = app.access.isOwner(interaction.user.id);
  if (!owner) {
    const zones = app.access.usableZones(interaction.user.id, app.domains.list()).filter((z) => z.routing?.enabled !== false);
    const text = zones.length
      ? `${zones.map((z) => `• **${z.name}**`).join('\n')}\n\nNew address: \`/create\``
      : 'You don\'t have access to any domain yet. The bot owner can grant it with `/perms`.';
    return respond(interaction, { embeds: [simpleEmbed(COLORS.info, truncate(text, 4000), '🌐 Your domains')] });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await app.domains.refresh().catch((err) => app.log.warn(`Could not refresh domains: ${err.message}`));
  const grants = app.store.allGrants();
  const byDomain = new Map();
  for (const g of grants) byDomain.set(g.domain, [...(byDomain.get(g.domain) ?? []), g.user_id]);
  const counts = new Map();
  for (const a of app.store.allLiveAddresses()) if (a.kind === 'address') counts.set(a.domain, (counts.get(a.domain) ?? 0) + 1);

  const lines = [];
  const everyone = byDomain.get(ALL_DOMAINS);
  if (everyone?.length) lines.push(`✱ **All domains:** ${everyone.map((id) => `<@${id}>`).join(', ')}`, '');
  for (const zone of app.domains.list()) {
    const users = byDomain.get(zone.name) ?? [];
    let line = `${routingBadge(zone)} **${zone.name}** · ${counts.get(zone.name) ?? 0} address(es)`;
    if (users.length) line += ` · ${users.map((id) => `<@${id}>`).join(', ')}`;
    if (zone.routing?.enabled && zone.routing.status && zone.routing.status !== 'ready') line += ` · status: ${zone.routing.status}`;
    lines.push(line);
  }
  if (!app.domains.list().length) lines.push('No active domains found in the Cloudflare account.');
  lines.push('', '-# ✅ Email Routing on · ⚠️ on, but DNS not correct · ⛔ off · ❔ unknown (token without "Zone Settings: Read")');
  await respond(interaction, { embeds: [simpleEmbed(COLORS.info, truncate(lines.join('\n'), 4096), '🌐 Domains')] });
}

export async function handleHelp(app, interaction) {
  const owner = app.access.isOwner(interaction.user.id);
  const lines = [
    '**E-Mail4U** creates email addresses via Cloudflare Email Routing. Everything sent to an address '
      + 'lands in your private forum – one post per address. (Receive only, sending is not possible.)',
    '',
    '`/create name domain [note]` – new address ("name" also suggests random names)',
    '`/list` – your addresses and how many mails they got',
    '`/delete address` – delete an address',
    '`/domains` – which domains you may use',
    '',
    'In the thread of each address: **Pause**, **Mute** (no pings), **Note**, **Delete**.',
    'Below each mail: **Original** (.eml/.html), **Delete** and – if detected – the verification code and link.',
  ];
  if (owner) {
    lines.push('', '**Owner:**', '`/perms user [domain] [action]` – grant/revoke/show domain access (also by user ID)',
      '`/setup` – category, limit, log channel and status', '`/list user` – addresses of another user');
  }
  await respond(interaction, { embeds: [simpleEmbed(COLORS.info, lines.join('\n'), '📖 Help')] });
}
