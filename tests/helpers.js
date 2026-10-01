// Helpers and sample mails for the tests.

export const MiB = 1024 * 1024;
export const LIMITS = { perFile: 20 * MiB, perMessage: 25 * MiB };

/** Builds a simple MIME mail (text + html + optional attachments). */
export function buildRawMail({
  from = 'Example Shop <noreply@shop.example>',
  to = 'netflix@example.com',
  subject = 'Please confirm your email',
  text = 'Your code: 482913',
  html = '<p>Your code: <b>482913</b></p><p><a href="https://shop.example/verify?t=1">Confirm email</a></p>',
  attachments = [],
  headers = [],
} = {}) {
  const boundary = 'b1_TESTBOUNDARY';
  const alt = 'b2_ALTBOUNDARY';
  const lines = [
    ...headers,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Date: Tue, 29 Sep 2026 10:00:00 +0200',
    'Message-ID: <test-1@shop.example>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${alt}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${alt}--`,
  ];
  for (const a of attachments) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${a.type ?? 'application/octet-stream'}; name="${a.name}"`,
      `Content-Disposition: attachment; filename="${a.name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(a.content).toString('base64').replace(/.{76}/g, '$&\r\n'),
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

export function embedLength(embed) {
  const d = embed.data ?? embed;
  return (d.title?.length ?? 0) + (d.description?.length ?? 0) + (d.author?.name?.length ?? 0)
    + (d.footer?.text?.length ?? 0)
    + (d.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0);
}
