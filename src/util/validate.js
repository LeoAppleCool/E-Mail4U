export const LOCAL_PART_MAX = 64;

/**
 * Names that only the bot owner may create.
 * Certificate authorities send domain-validation mail to admin@, hostmaster@, postmaster@,
 * webmaster@ … – whoever receives those could get TLS certificates issued for the domain.
 */
export const RESERVED_LOCAL_PARTS = new Set([
  'abuse', 'admin', 'administrator', 'hostmaster', 'postmaster', 'webmaster', 'root',
  'security', 'ssladmin', 'ssl-admin', 'sysadmin', 'noc', 'mailer-daemon', 'dmarc',
  'dmarc-reports', 'tls-reports', 'domains', 'dns', 'whois',
]);

// Autocomplete suggestions look like "netflix@example.com · ✅ available".
// Some Discord clients submit that displayed text instead of the choice value, so everything
// after " · " and any leading emoji/symbols are ignored when parsing input.
export const HINT_SEPARATOR = ' · ';
const LEADING_SYMBOLS = /^[\s\p{Extended_Pictographic}\p{So}\uFE0F\u200D]+/u;

function stripDecoration(input) {
  return String(input ?? '').split(HINT_SEPARATOR.trim())[0].replace(LEADING_SYMBOLS, '').trim();
}

/** " Netflix@example.com " (or "✅ netflix · available") → "netflix" */
export function normalizeLocalPart(input) {
  return stripDecoration(input).toLowerCase().split('@')[0].trim();
}

/** Returns an error message, or null if the name is valid. */
export function validateLocalPart(localPart) {
  if (!localPart) return 'Please enter a name.';
  if (localPart.length > LOCAL_PART_MAX) return `At most ${LOCAL_PART_MAX} characters.`;
  if (!/^[a-z0-9._-]+$/.test(localPart)) return 'Only a–z, 0–9, dot, hyphen and underscore are allowed.';
  if (!/^[a-z0-9]/.test(localPart) || !/[a-z0-9]$/.test(localPart)) {
    return 'Must start and end with a letter or digit.';
  }
  if (localPart.includes('..')) return 'Two dots in a row are not allowed.';
  return null;
}

export function isReservedLocalPart(localPart) {
  return RESERVED_LOCAL_PARTS.has(localPart);
}

/** " @Example.COM. " → "example.com", "x@example.com" → "example.com", "example.com · ⛔ …" → "example.com" */
export function normalizeDomain(input) {
  const token = stripDecoration(input).toLowerCase().split(/\s+/)[0] ?? '';
  return token.replace(/^.*@/, '').replace(/\.$/, '');
}

/** Domain option of /perms: "*" or "✱ All domains …" means every domain, otherwise the domain. */
export function parseDomainOption(input) {
  const raw = String(input ?? '').trim();
  if (raw === '*' || raw.startsWith('✱') || /^all domains/i.test(stripDecoration(raw))) return '*';
  return normalizeDomain(raw);
}

export function isSnowflake(value) {
  return /^\d{17,20}$/.test(String(value ?? ''));
}

/** Accepts "123…", "<@123…>", "<@!123…>" and displayed suggestions like "Leo (@leo) · 123…". */
export function parseUserId(input) {
  const text = String(input ?? '').trim();
  const exact = text.match(/^(?:<@!?)?(\d{17,20})>?$/);
  if (exact) return exact[1];
  return text.match(/(?<!\d)(\d{17,20})(?!\d)/)?.[1] ?? null;
}

/** Finds the email address in input like "netflix@example.com · note". */
export function extractAddress(input) {
  return String(input ?? '').toLowerCase().match(/[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/)?.[0] ?? null;
}
