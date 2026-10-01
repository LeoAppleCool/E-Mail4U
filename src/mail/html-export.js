// Turns the HTML part of a mail into a standalone file for viewing in a browser.
// A Content-Security-Policy blocks scripts, frames, forms and anything loaded from other servers
// (tracking pixels, fonts, CSS) – embedded images stay visible.

const CSP = [
  "default-src 'none'",
  'img-src data:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const fmt = (a) => (a.name ? `${a.name} <${a.address}>` : a.address);

export function exportHtml(mail) {
  let html = mail.html;
  // Inline embedded images (cid:) as data: URLs so the file works without the mail.
  for (const a of mail.attachments) {
    if (!a.cid || !a.content || a.size > 5 * 1024 * 1024) continue;
    const dataUrl = `data:${a.contentType};base64,${a.content.toString('base64')}`;
    html = html.split(`cid:${a.cid}`).join(dataUrl);
  }
  // http-equiv (e.g. meta refresh = automatic redirect) cannot be forbidden via CSP.
  // Attribute names don't support entities, so breaking the name itself is enough.
  html = html.replace(/http-equiv/gi, 'data-blocked');

  const rows = [
    ['From', fmt(mail.from)],
    ['To', [...mail.to, ...mail.cc].map(fmt).join(', ')],
    ['Subject', mail.subject],
    ['Date', mail.date ? mail.date.toUTCString() : ''],
  ].filter(([, value]) => value);
  const header = '<div style="font:13px system-ui,sans-serif;background:#f3f4f6;color:#111;border-bottom:1px solid #d1d5db;padding:10px 14px">'
    + rows.map(([k, v]) => `<div><b>${k}:</b> ${escapeHtml(v)}</div>`).join('')
    + '<div style="color:#6b7280;margin-top:4px">Exported by E-Mail4U – scripts, forms and external content (tracking) are blocked.</div></div>';

  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + `<meta name="referrer" content="no-referrer"><title>${escapeHtml(mail.subject || 'Email')}</title>${header}${html}`;
}
