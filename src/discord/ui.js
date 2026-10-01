import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { escapeMarkdown, truncate } from '../mail/format.js';

export const COLORS = { ok: 0x57f287, info: 0x5865f2, warn: 0xfee75c, error: 0xed4245, muted: 0x99aab5 };

export const STATUS = {
  active: { emoji: '🟢', label: 'Active', color: COLORS.ok },
  paused: { emoji: '⏸️', label: 'Paused', color: COLORS.warn },
  deleted: { emoji: '🗑️', label: 'Deleted', color: COLORS.muted },
};

export const ts = (ms, style = 'f') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function threadName(address) {
  return truncate(address.kind === 'catchall' ? `✱ Catch-all @${address.domain}` : address.address, 100);
}

/** Embed of the starter message of an address thread. */
export function addressEmbed(address) {
  const status = STATUS[address.status] ?? STATUS.active;
  const lines = [`**Status:** ${status.emoji} ${status.label}${address.muted ? ' · 🔕 no pings' : ''}`];
  if (address.note) lines.push(`**Note:** ${escapeMarkdown(address.note)}`);
  lines.push(`**Created:** ${ts(address.created_at)}`, '');

  if (address.kind === 'catchall') {
    lines.push(`Mail to addresses of **${address.domain}** that aren't registered in the bot lands here `
      + '(e.g. when the catch-all rule in Cloudflare points to the worker).');
  } else if (address.status === 'active') {
    lines.push('Every email sent to this address shows up here. Replying or sending is not possible.');
  } else if (address.status === 'paused') {
    lines.push('Paused – Cloudflare currently doesn\'t accept mail for this address (or hands it to a catch-all rule, if there is one).');
  } else {
    lines.push('This address was deleted and no longer receives mail.');
  }

  return new EmbedBuilder()
    .setTitle(`📬 ${address.kind === 'catchall' ? `*@${address.domain}` : address.address}`)
    .setColor(status.color)
    .setDescription(lines.join('\n'));
}

/** Buttons of the starter message. */
export function addressButtons(address) {
  if (address.status === 'deleted') return [];
  const buttons = [];
  if (address.kind !== 'catchall') {
    buttons.push(address.status === 'paused'
      ? new ButtonBuilder().setCustomId(`a:resume:${address.id}`).setEmoji('▶️').setLabel('Resume').setStyle(ButtonStyle.Success)
      : new ButtonBuilder().setCustomId(`a:pause:${address.id}`).setEmoji('⏸️').setLabel('Pause').setStyle(ButtonStyle.Secondary));
  }
  buttons.push(
    address.muted
      ? new ButtonBuilder().setCustomId(`a:unmute:${address.id}`).setEmoji('🔔').setLabel('Unmute').setStyle(ButtonStyle.Secondary)
      : new ButtonBuilder().setCustomId(`a:mute:${address.id}`).setEmoji('🔕').setLabel('Mute').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`a:note:${address.id}`).setEmoji('✏️').setLabel('Note').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`a:del:${address.id}`).setEmoji('🗑️').setLabel('Delete').setStyle(ButtonStyle.Danger),
  );
  return [new ActionRowBuilder().addComponents(buttons)];
}

/** Confirmation dialog for deleting an address. */
export function deleteConfirmation(address) {
  const text = address.kind === 'catchall'
    ? `The collection thread for **${address.domain}** will be closed. As long as the catch-all rule in Cloudflare `
      + 'points to the worker, the next mail to an unknown address creates a new one.'
    : `**${address.address}** will be removed from Cloudflare and won't receive mail anymore.\n`
      + 'You can keep the thread as an archive or delete it completely.';
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.error)
      .setTitle(address.kind === 'catchall' ? 'Close the catch-all thread?' : 'Really delete this address?')
      .setDescription(text)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`a:delok:${address.id}:keep`).setEmoji('🗑️').setLabel('Delete, keep thread').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`a:delok:${address.id}:drop`).setEmoji('🔥').setLabel('Delete incl. thread').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('x:cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  };
}

export function simpleEmbed(color, description, title) {
  const embed = new EmbedBuilder().setColor(color).setDescription(truncate(description, 4096));
  if (title) embed.setTitle(truncate(title, 256));
  return embed;
}

const updateDeferred = new WeakSet();

/** Like interaction.deferUpdate(), but remembers that answers have to be sent as follow-ups. */
export async function deferUpdate(interaction) {
  updateDeferred.add(interaction);
  await interaction.deferUpdate();
}

/** Replies ephemerally – no matter whether the interaction was already answered or deferred. */
export async function respond(interaction, payload) {
  const data = typeof payload === 'string' ? { content: payload } : payload;
  const message = { allowedMentions: { parse: [] }, ...data };
  if (updateDeferred.has(interaction)) return interaction.followUp({ ...message, flags: MessageFlags.Ephemeral });
  if (interaction.deferred || interaction.replied) return interaction.editReply(message);
  return interaction.reply({ ...message, flags: MessageFlags.Ephemeral });
}
