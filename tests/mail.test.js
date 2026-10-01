import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportHtml } from '../src/mail/html-export.js';
import { parseAuthResults, parseMail } from '../src/mail/parse.js';
import { buildMailMessage, planAttachments } from '../src/mail/render.js';
import { LIMITS, MiB, buildRawMail, embedLength } from './helpers.js';

const render = (mail, extra = {}) => buildMailMessage({
  mail, rcpt: 'netflix@example.com', mailId: '0e1b6c1e-1111-4222-8333-944445555666', receivedAt: Date.now(),
  limits: LIMITS, mentionUserId: '123456789012345678', originalAvailable: true, ...extra,
});

test('parseMail reads sender, subject, text, HTML and attachments', async () => {
  const mail = await parseMail(buildRawMail({ attachments: [{ name: 'invoice.pdf', type: 'application/pdf', content: 'PDFDATA' }] }));
  assert.equal(mail.subject, 'Please confirm your email');
  assert.deepEqual(mail.from, { name: 'Example Shop', address: 'noreply@shop.example' });
  assert.equal(mail.to[0].address, 'netflix@example.com');
  assert.ok(mail.text.includes('482913'));
  assert.ok(mail.html.includes('<b>482913</b>'));
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].filename, 'invoice.pdf');
  assert.equal(mail.date.toISOString(), '2026-09-29T08:00:00.000Z');
});

test('Discord message: ping, code, confirmation button, attachment', async () => {
  const mail = await parseMail(buildRawMail({ attachments: [{ name: 'invoice.pdf', type: 'application/pdf', content: 'PDFDATA' }] }));
  const { main, extra, code } = render(mail);
  assert.equal(code, '482913');
  assert.ok(main.content.startsWith('<@123456789012345678> 📨 **Example Shop**'));
  assert.ok(main.content.includes('🔑 Code: **482913**'));
  assert.deepEqual(main.allowedMentions, { parse: [], users: ['123456789012345678'] });
  assert.equal(main.files.length, 1);
  assert.equal(extra.length, 0);

  const [embed] = main.embeds;
  assert.equal(embed.data.title, 'Please confirm your email');
  assert.ok(embed.data.description.includes('[Confirm email](https://shop.example/verify?t=1)'));
  assert.ok(embed.data.fields.some((f) => f.name.startsWith('📎 Attachments')));

  const rows = main.components.map((row) => row.toJSON());
  const buttons = rows.flatMap((r) => r.components);
  assert.ok(buttons.some((b) => b.custom_id === 'm:code:482913'));
  assert.ok(buttons.some((b) => b.url === 'https://shop.example/verify?t=1'));
  assert.ok(buttons.some((b) => b.custom_id?.startsWith('m:orig:')));
  assert.ok(buttons.every((b) => !b.custom_id || b.custom_id.length <= 100));
});

test('muted address: no ping', async () => {
  const mail = await parseMail(buildRawMail());
  const { main } = render(mail, { mentionUserId: null });
  assert.ok(main.content.startsWith('📨'));
  assert.deepEqual(main.allowedMentions, { parse: [], users: [] });
});

test('long mails are shortened, stay below 6000 characters and get the full text attached', async () => {
  const long = Array.from({ length: 800 }, (_, i) => `Paragraph ${i}: ${'Lorem ipsum dolor sit amet. '.repeat(3)}`).join('\n\n');
  const mail = await parseMail(buildRawMail({ text: long, html: '', to: `${'x'.repeat(40)}@example.com, ${Array.from({ length: 30 }, (_, i) => `person${i}@example.org`).join(', ')}` }));
  const { main } = render(mail);
  const [embed] = main.embeds;
  assert.ok(embedLength(embed) <= 6000, `embed is ${embedLength(embed)} characters long`);
  assert.ok(embed.data.description.length <= 4096);
  assert.ok(main.files.some((f) => f.name === 'message.txt'));
  assert.ok(embed.data.fields.some((f) => f.value.includes('shortened')));
});

test('a failed DMARC check shows a warning, forged headers are ignored', async () => {
  const cloudflare = 'Authentication-Results: mx.cloudflare.net; dkim=fail header.d=paypal.com; spf=softfail; dmarc=fail header.from=paypal.com';
  const mail = await parseMail(buildRawMail({ headers: [cloudflare] }));
  assert.deepEqual(mail.auth, { dkim: 'fail', spf: 'softfail', dmarc: 'fail' });
  const { main } = render(mail);
  assert.ok(main.embeds[0].data.fields.some((f) => f.name.includes('not verified')));
  assert.ok(main.embeds[0].data.footer.text.includes('DMARC ✗'));

  const forged = parseAuthResults([{ key: 'authentication-results', line: 'Authentication-Results: evil.example; dmarc=pass' }]);
  assert.equal(forged, null);
});

test('planAttachments spreads large attachments and skips oversized ones', () => {
  const file = (name, size) => ({ filename: name, size, content: Buffer.alloc(1) });
  const plan = planAttachments(
    [file('a', 15 * MiB), file('b', 15 * MiB), file('c', 30 * MiB), file('d', 1 * MiB)],
    { ...LIMITS, firstSlots: 10 },
  );
  assert.deepEqual(plan.first.map((a) => a.filename), ['a', 'd']);
  assert.deepEqual(plan.rest.map((g) => g.map((a) => a.filename)), [['b']]);
  assert.deepEqual(plan.skipped.map((a) => a.filename), ['c']);
});

test('HTML export blocks scripts, redirects and external content and embeds cid images', async () => {
  const mail = {
    subject: 'Test <script>', from: { name: '', address: 'a@b.example' }, to: [], cc: [], date: null,
    html: '<meta http-equiv="refresh" content="0;url=https://evil"><META HTTP-EQUIV="&#82;efresh" content="0;url=https://evil2">'
      + '<img src="cid:logo1"><img src="https://tracker.example/pixel.gif"><script>alert(1)</script>',
    attachments: [{ cid: 'logo1', content: Buffer.from('PNG'), contentType: 'image/png', size: 3 }],
  };
  const html = exportHtml(mail);
  const csp = html.match(/content="(default-src[^"]*)"/)[1];
  assert.ok(html.startsWith('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"'));
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes('img-src data:') && !csp.includes('https:'), 'no external images (tracking)');
  assert.equal(html.match(/http-equiv/gi).length, 1, 'only our own CSP meta tag');
  assert.ok(html.includes('src="data:image/png;base64,UE5H"'));
  assert.ok(html.includes('<title>Test &lt;script&gt;</title>'));
});

test('confirmation buttons get normalized URLs', async () => {
  const mail = await parseMail(buildRawMail({ html: '<a href="https://shop.example/verify email?t=a b">Confirm email</a>' }));
  const { main } = render(mail);
  const buttons = main.components.flatMap((row) => row.toJSON().components);
  const link = buttons.find((b) => b.url);
  assert.equal(link.url, 'https://shop.example/verify%20email?t=a%20b');
});
