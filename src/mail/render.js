import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { findActionLinks, findVerificationCode } from './extract.js';
import {
  collectLinks, escapeMarkdown, htmlToSegments, renderSegments, segmentsToPlain, textToSegments, truncate,
} from './format.js';

export const MAIL_COLOR = 0x5865f2;
export const WARN_COLOR = 0xed4245;
const DESCRIPTION_BUDGET = 3500;
// Room within the upload limit for the JSON payload, embed etc.
const PAYLOAD_RESERVE = 256 * 1024;
const MAX_FILES = 10;

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** For most mails HTML is the "real" version; plain text is only used if there is no HTML. */
export function bodySegments(mail) {
  if (mail.html) {
    const segments = htmlToSegments(mail.html);
    if (segments.length || !mail.text) return segments;
  }
  return textToSegments(mail.text);
}

function sanitizeFilename(name) {
  const clean = String(name || 'attachment').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'attachment';
  if (clean.length <= 100) return clean;
  const dot = clean.lastIndexOf('.');
  const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
  return clean.slice(0, 100 - ext.length) + ext;
}

function authFooter(auth) {
  if (!auth) return null;
  const mark = (v) => (v === 'pass' ? '✓' : !v || v === 'none' ? '–' : '✗');
  return ['spf', 'dkim', 'dmarc'].map((k) => `${k.toUpperCase()} ${mark(auth[k])}`).join(' · ');
}

function recipientsField(mail, rcpt) {
  const list = [...mail.to, ...mail.cc].filter((a) => a.address);
  const includesRcpt = list.some((a) => a.address === rcpt);
  if (includesRcpt && list.length === 1) return null;
  const fmt = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);
  const shown = list.slice(0, 8).map(fmt).join(', ') + (list.length > 8 ? ` … (+${list.length - 8})` : '');
  const text = escapeMarkdown(shown || '(not specified)');
  return includesRcpt ? text : `${text}\n-# You received this mail as a blind copy (BCC) or via a mailing list.`;
}

/**
 * Spreads attachments over the main message and, if needed, follow-up messages
 * (upload limit, at most 10 files per message).
 */
export function planAttachments(attachments, { perFile, perMessage, firstUsed = 0, firstSlots = MAX_FILES }) {
  const groupBudget = perMessage - PAYLOAD_RESERVE;
  const maxSize = Math.min(perFile, groupBudget);
  const groups = [{ items: [], size: firstUsed, slots: firstSlots }];
  const skipped = [];
  for (const a of attachments) {
    if (!a.content || a.size > maxSize) {
      skipped.push(a);
      continue;
    }
    let group = groups.find((g) => g.items.length < g.slots && g.size + a.size <= groupBudget);
    if (!group) {
      group = { items: [], size: 0, slots: MAX_FILES };
      groups.push(group);
    }
    group.items.push(a);
    group.size += a.size;
  }
  return { first: groups[0].items, rest: groups.slice(1).map((g) => g.items).filter((g) => g.length), skipped };
}

function toFile(a) {
  return new AttachmentBuilder(a.content, { name: sanitizeFilename(a.filename) });
}

function linkButton(label, url) {
  try {
    // href is normalized (spaces etc. encoded) – Discord rejects sloppy URLs otherwise.
    const { href, protocol } = new URL(url);
    if (!/^https?:$/.test(protocol) || href.length > 512) return null;
    return new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(href)
      .setEmoji('🔗')
      .setLabel(truncate(label || 'Open link', 80));
  } catch {
    return null;
  }
}

function mailButtons(mailId, originalAvailable) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`m:orig:${mailId}`)
      .setEmoji('📄')
      .setLabel('Original')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!originalAvailable),
    new ButtonBuilder().setCustomId(`m:del:${mailId}`).setEmoji('🗑️').setLabel('Delete').setStyle(ButtonStyle.Secondary),
  );
}

/**
 * Builds the Discord message(s) for an incoming email.
 * @returns {{ main: object, fallback: object, extra: object[], code: string|null }}
 */
export function buildMailMessage({ mail, rcpt, mailId, receivedAt, limits, mentionUserId, originalAvailable }) {
  const segments = bodySegments(mail);
  const plain = segmentsToPlain(segments);
  const code = findVerificationCode(mail.subject, plain);
  const actions = findActionLinks(collectLinks(segments));

  const senderName = mail.from.name || mail.from.address || 'Unknown sender';
  const subject = mail.subject || '(no subject)';
  const dmarcFailed = Boolean(mail.auth?.dmarc && !['pass', 'none'].includes(mail.auth.dmarc));

  let content = `📨 **${escapeMarkdown(truncate(senderName, 80))}**: ${escapeMarkdown(truncate(subject, 200))}`;
  if (mentionUserId) content = `<@${mentionUserId}> ${content}`;
  if (code) content += `\n🔑 Code: **${code}**`;

  // Fields first, so the description gets whatever is left of the 6000 characters per embed.
  const fields = [];
  if (dmarcFailed) {
    fields.push({
      name: '⚠️ Sender not verified',
      value: 'The DMARC check failed – this mail may be forged. Be careful with links and attachments.',
    });
  }
  const recipients = recipientsField(mail, rcpt);
  if (recipients) fields.push({ name: 'To', value: truncate(recipients, 1024) });

  const realAttachments = mail.attachments.filter((a) => !a.related);
  const attachmentField = { name: `📎 Attachments (${realAttachments.length})`, value: '' };
  if (realAttachments.length) fields.push(attachmentField);

  const author = truncate(mail.from.name && mail.from.address ? `${mail.from.name} <${mail.from.address}>` : senderName, 256);
  const title = truncate(subject, 256);
  const footer = truncate([rcpt, authFooter(mail.auth)].filter(Boolean).join(' • '), 2048);
  const truncatedNote = { name: '\u200b', value: '-# The message was shortened – the full text is in `message.txt`.' };
  const fixed = author.length + title.length + footer.length + truncatedNote.value.length + 2
    + fields.reduce((sum, f) => sum + f.name.length + (f === attachmentField ? 1024 : f.value.length), 0);
  const { text: body, truncated } = renderSegments(segments, Math.max(500, Math.min(DESCRIPTION_BUDGET, 5900 - fixed)));

  const files = [];
  let firstUsed = 0;
  if (truncated) {
    const full = Buffer.from(`${plain}\n`, 'utf8');
    if (full.length <= Math.min(limits.perFile, limits.perMessage - PAYLOAD_RESERVE)) {
      files.push(new AttachmentBuilder(full, { name: 'message.txt' }));
      firstUsed = full.length;
    }
  }
  const plan = planAttachments(realAttachments, { ...limits, firstUsed, firstSlots: MAX_FILES - files.length });
  files.push(...plan.first.map(toFile));
  if (realAttachments.length) {
    const lines = realAttachments.map((a) => {
      const tooBig = plan.skipped.includes(a) ? ' – too large for Discord (see “Original”)' : '';
      return `${escapeMarkdown(truncate(a.filename, 80))} (${formatBytes(a.size)})${tooBig}`;
    });
    attachmentField.value = truncate(lines.join('\n'), 1024);
  }
  if (truncated) fields.push(truncatedNote);

  const embed = new EmbedBuilder()
    .setColor(dmarcFailed ? WARN_COLOR : MAIL_COLOR)
    .setAuthor({ name: author })
    .setTitle(title)
    .setDescription(body || '*(no text content)*')
    .setTimestamp(mail.date ?? new Date(receivedAt ?? Date.now()))
    .setFooter({ text: footer });
  if (fields.length) embed.addFields(fields);

  const components = [];
  const quick = [];
  if (code) {
    quick.push(new ButtonBuilder().setCustomId(`m:code:${code}`).setEmoji('🔑').setLabel(code).setStyle(ButtonStyle.Primary));
  }
  for (const action of actions) {
    const button = linkButton(action.label, action.url);
    if (button) quick.push(button);
  }
  if (quick.length) components.push(new ActionRowBuilder().addComponents(quick.slice(0, 5)));
  components.push(mailButtons(mailId, originalAvailable));

  const allowedMentions = { parse: [], users: mentionUserId ? [mentionUserId] : [] };
  return {
    main: { content: truncate(content, 2000), embeds: [embed], components, files, allowedMentions },
    // If Discord rejects the message (e.g. invalid data from the mail): a plain version.
    fallback: {
      content: truncate(`${content}\n-# This mail could not be displayed in full – open it via “Original”.`, 2000),
      components: [mailButtons(mailId, originalAvailable)],
      allowedMentions,
    },
    extra: plan.rest.map((group) => ({
      content: '📎 More attachments',
      files: group.map(toFile),
      allowedMentions: { parse: [] },
    })),
    code,
  };
}

/** Fallback when Discord rejects the message (e.g. because of its size). */
export function withoutFiles(message, note) {
  const [embed] = message.embeds;
  const copy = EmbedBuilder.from(embed);
  copy.addFields({ name: '⚠️ Note', value: note });
  return { ...message, embeds: [copy], files: [] };
}