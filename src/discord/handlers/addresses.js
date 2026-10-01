import fs from 'node:fs/promises';
import {
  AttachmentBuilder, LabelBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { UserError } from '../../errors.js';
import { truncate } from '../../mail/format.js';
import { exportHtml } from '../../mail/html-export.js';
import { parseMail } from '../../mail/parse.js';
import { extractAddress, parseUserId } from '../../util/validate.js';
import { COLORS, STATUS, deferUpdate, deleteConfirmation, respond, simpleEmbed, ts } from '../ui.js';

function resolveAddress(app, actorId, input) {
  const value = String(input ?? '').trim();
  const typed = extractAddress(value);
  const address = /^\d+$/.test(value) ? app.store.getAddress(Number(value)) : typed ? app.store.findLiveAddress(typed) : null;
  if (!address || address.status === 'deleted' || address.kind !== 'address') {
    throw new UserError('Address not found – please pick one from the suggestions.');
  }
  if (address.user_id !== actorId && !app.access.isOwner(actorId)) throw new UserError('That is not your address.');
  return address;
}

export async function handleDelete(app, interaction) {
  const address = resolveAddress(app, interaction.user.id, interaction.options.getString('address', true));
  await respond(interaction, deleteConfirmation(address));
}

export async function handleList(app, interaction) {
  let userId = interaction.user.id;
  const target = interaction.options.getString('user');
  if (target) {
    if (!app.access.isOwner(interaction.user.id)) throw new UserError('Only the bot owner can view other users\' addresses.');
    userId = parseUserId(target);
    if (!userId) throw new UserError('Invalid user ID.');
  }
  const self = userId === interaction.user.id;
  const rows = app.store.liveAddressesOf(userId);
  if (!rows.length) {
    const text = self ? 'You don\'t have any addresses yet – create one with `/create`!' : `<@${userId}> has no addresses.`;
    return respond(interaction, { embeds: [simpleEmbed(COLORS.info, text, '📭 No addresses')] });
  }

  const lines = [];
  let length = 0;
  for (const a of rows) {
    const label = a.thread_id ? `<#${a.thread_id}>` : `**${a.kind === 'catchall' ? `*@${a.domain}` : a.address}**`;
    const parts = [`${STATUS[a.status]?.emoji ?? '•'} ${label}`];
    if (a.note) parts.push(a.note);
    parts.push(`${a.mail_count} ✉️`);
    if (a.last_mail_at) parts.push(`last ${ts(a.last_mail_at, 'R')}`);
    if (a.muted) parts.push('🔕');
    const line = parts.join(' · ');
    if (length + line.length > 3800) {
      lines.push(`… and ${rows.length - lines.length} more`);
      break;
    }
    lines.push(line);
    length += line.length + 1;
  }
  const count = rows.filter((a) => a.kind === 'address').length;
  const limitText = app.access.isOwner(userId) ? 'unlimited' : `${app.addresses.limit()}`;
  const embed = simpleEmbed(COLORS.info, lines.join('\n'), self ? '📬 Your addresses' : '📬 Addresses')
    .setFooter({ text: `${count} address(es) · limit: ${limitText}` });
  if (!self) embed.setDescription(`<@${userId}>\n\n${embed.data.description}`.slice(0, 4096));
  return respond(interaction, { embeds: [embed] });
}

/** Buttons on the starter message of an address thread and in the delete dialog. */
export async function handleAddressButton(app, interaction, action, id, extra) {
  const actorId = interaction.user.id;
  switch (action) {
    case 'pause':
    case 'resume':
      await deferUpdate(interaction);
      await app.addresses.setPaused(id, actorId, action === 'pause');
      return;
    case 'mute':
    case 'unmute':
      await deferUpdate(interaction);
      await app.addresses.setMuted(id, actorId, action === 'mute');
      return;
    case 'note': {
      const address = app.addresses.manageable(id, actorId);
      const input = new TextInputBuilder()
        .setCustomId('note')
        .setPlaceholder('e.g. Netflix account')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(100);
      if (address.note) input.setValue(address.note);
      const modal = new ModalBuilder()
        .setCustomId(`a:notesave:${address.id}`)
        .setTitle('Edit note')
        .addLabelComponents(new LabelBuilder()
          .setLabel('What is this address for?')
          .setDescription(truncate(address.address, 100))
          .setTextInputComponent(input));
      await interaction.showModal(modal);
      return;
    }
    case 'del': {
      const address = app.addresses.manageable(id, actorId);
      if (address.status === 'deleted') throw new UserError('This address is already deleted.');
      await respond(interaction, deleteConfirmation(address));
      return;
    }
    case 'delok': {
      await interaction.update({ embeds: [simpleEmbed(COLORS.muted, 'Deleting …')], components: [] });
      const deleted = await app.addresses.remove(id, actorId, { deleteThread: extra === 'drop' });
      await interaction.editReply({ embeds: [simpleEmbed(COLORS.ok, `**${deleted.address}** was deleted.`, '🗑️ Deleted')] })
        .catch(() => {}); // the reply may have lived in the thread that was just deleted
      return;
    }
    default:
      throw new UserError('Unknown action.');
  }
}

export async function handleNoteModal(app, interaction, id) {
  const note = interaction.fields.getTextInputValue('note');
  await deferUpdate(interaction);
  await app.addresses.setNote(id, interaction.user.id, note);
}

/** Buttons below a delivered mail. */
export async function handleMailButton(app, interaction, action, value) {
  if (action === 'code') {
    // Only the code, so it is easy to copy (especially on mobile).
    await interaction.reply({ content: value, flags: MessageFlags.Ephemeral });
    return;
  }

  const mail = app.store.getMail(value);
  const address = mail?.address_id ? app.store.getAddress(mail.address_id) : app.store.addressByThread(interaction.channelId);
  if (!address || (address.user_id !== interaction.user.id && !app.access.isOwner(interaction.user.id))) {
    throw new UserError('That is not your mail.');
  }

  if (action === 'del') {
    await deferUpdate(interaction);
    // Nothing can be deleted in an auto-archived thread otherwise.
    if (interaction.channel?.isThread() && interaction.channel.archived && !interaction.channel.locked) {
      await interaction.channel.setArchived(false);
    }
    await interaction.message.delete();
    if (mail?.raw_path) await fs.rm(mail.raw_path, { force: true });
    if (mail) app.store.updateMail(mail.id, { status: 'deleted', raw_path: null });
    return;
  }

  if (action === 'orig') {
    const raw = mail?.raw_path ? await fs.readFile(mail.raw_path).catch(() => null) : null;
    if (!raw) {
      throw new UserError(`The original is no longer stored (originals are kept for ${app.config.mailRetentionDays} days).`);
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const { perFile, perMessage } = app.forums.uploadLimits();
    let budget = perMessage - 256 * 1024;
    const files = [];
    const add = (buffer, name) => {
      if (buffer.length > perFile || buffer.length > budget) return;
      files.push(new AttachmentBuilder(buffer, { name }));
      budget -= buffer.length;
    };
    add(raw, 'original.eml');
    const parsed = await parseMail(raw);
    if (parsed.html) add(Buffer.from(exportHtml(parsed), 'utf8'), 'mail.html');
    if (!files.length) throw new UserError('This mail is too large to be sent via Discord.');
    const names = files.map((f) => f.name);
    const lines = ['📄 **Original**'];
    if (names.includes('original.eml')) lines.push('`original.eml` opens in any mail client.');
    else lines.push('The .eml file is too large for Discord.');
    if (names.includes('mail.html')) {
      lines.push('`mail.html` shows the mail in your browser – scripts, forms and external images (tracking) are blocked.');
    }
    await interaction.editReply({ content: lines.join('\n'), files });
    return;
  }
  throw new UserError('Unknown action.');
}
