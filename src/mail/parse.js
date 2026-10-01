import { simpleParser } from 'mailparser';

function flattenAddresses(field) {
  const objects = Array.isArray(field) ? field : field ? [field] : [];
  const out = [];
  for (const obj of objects) {
    for (const entry of obj.value ?? []) {
      if (entry.group) out.push(...entry.group.map((g) => ({ name: g.name ?? '', address: (g.address ?? '').toLowerCase() })));
      else out.push({ name: entry.name ?? '', address: (entry.address ?? '').toLowerCase() });
    }
  }
  return out.filter((a) => a.address || a.name);
}

/**
 * Reads the topmost Authentication-Results header – but only if Cloudflare added it.
 * Senders can include their own, forged headers.
 */
export function parseAuthResults(headerLines = []) {
  const header = headerLines.find((h) => h.key === 'authentication-results');
  if (!header) return null;
  const value = header.line.replace(/^[^:]*:/, '').replace(/\s+/g, ' ').trim();
  const authservId = value.split(';')[0].trim().toLowerCase();
  if (!authservId.includes('cloudflare')) return null;
  const result = {};
  for (const [, method, verdict] of value.matchAll(/\b(spf|dkim|dmarc)=([a-z]+)/gi)) {
    const key = method.toLowerCase();
    if (!result[key] || verdict.toLowerCase() === 'pass') result[key] = verdict.toLowerCase();
  }
  return Object.keys(result).length ? result : null;
}

/**
 * @param {Buffer} raw the complete email (RFC 822)
 */
export async function parseMail(raw) {
  const parsed = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
  const from = flattenAddresses(parsed.from)[0] ?? { name: '', address: '' };
  const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;

  return {
    subject: (parsed.subject ?? '').trim(),
    from,
    replyTo: flattenAddresses(parsed.replyTo),
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    date,
    messageId: parsed.messageId ?? null,
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    attachments: (parsed.attachments ?? []).map((a, i) => ({
      filename: a.filename || `attachment-${i + 1}${guessExtension(a.contentType)}`,
      contentType: a.contentType || 'application/octet-stream',
      size: a.size ?? a.content?.length ?? 0,
      content: a.content,
      cid: a.cid ?? null,
      related: Boolean(a.related),
    })),
    auth: parseAuthResults(parsed.headerLines),
  };
}

function guessExtension(contentType = '') {
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'text/calendar': '.ics', 'message/rfc822': '.eml',
  };
  return map[contentType.toLowerCase()] ?? '.bin';
}
