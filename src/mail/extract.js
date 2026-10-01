// Heuristics for verification codes and confirmation links (English and German mails).
// Better to miss a code than to show a customer number as one.

const CODE_KEYWORDS = /(code|kode|verif|otp|\bpin\b|passcode|one[- ]?time|einmal|bestätigung|bestaetigung|sicherheits|security|anmelde|login|sign[- ]?in|zugangs|token|2fa|two[- ]factor|zwei[- ]faktor|authenti|tan\b)/i;
const NUMERIC_CODE = /(?<![\w.,:/@#+%€$-])(\d{3}[ -]\d{3}|\d{4,8})(?![\w%€$]|[.,:/-]\d)/g;
const ALNUM_CODE = /(?<![\w-])(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8}(?![\w-])/g;

/** Replaces things that look like codes but aren't (URLs, dates, prices …) with spaces of equal length. */
function maskNoise(text) {
  let out = text;
  const mask = (re) => {
    out = out.replace(re, (m) => ' '.repeat(m.length));
  };
  mask(/https?:\/\/\S+/gi);
  mask(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g);
  mask(/\+\d[\d\s()/-]{6,}\d/g);
  mask(/\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g);
  mask(/\b\d{4}-\d{2}-\d{2}\b/g);
  mask(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g);
  mask(/[$€£]\s?\d[\d.,]*|\d[\d.,]*\s?(?:€|eur\b|usd\b|chf\b|\$|£)/gi);
  mask(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g); // IBAN
  mask(/\b[A-Z]-(?=\d{4,8}\b)/g); // prefix as in "G-123456"
  return out;
}

function lengthScore(digits) {
  if (digits.length === 6) return 2;
  return 1;
}

function scan(source, inSubject, candidates) {
  const text = maskNoise(source);

  for (const match of text.matchAll(NUMERIC_CODE)) {
    const digits = match[1].replace(/[ -]/g, '');
    let score = lengthScore(digits);
    if (/^(19|20)\d{2}$/.test(digits)) score -= 3;
    const before = text.slice(Math.max(0, match.index - 80), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
    if (CODE_KEYWORDS.test(before)) score += 3;
    else if (CODE_KEYWORDS.test(after)) score += 2;
    if (inSubject) score += 1;
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    if (text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim() === match[0]) score += 1;
    candidates.push({ code: digits, score, order: candidates.length });
  }

  for (const match of text.matchAll(ALNUM_CODE)) {
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    if (!CODE_KEYWORDS.test(before)) continue;
    candidates.push({ code: match[0], score: 4 + (inSubject ? 1 : 0), order: candidates.length });
  }
}

/** Finds a likely verification code in the subject or text, otherwise null. */
export function findVerificationCode(subject, text) {
  const candidates = [];
  scan(String(subject ?? ''), true, candidates);
  scan(String(text ?? '').slice(0, 20_000), false, candidates);
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  const best = candidates[0];
  return best && best.score >= 4 ? best.code : null;
}

const LINK_POSITIVE = /(verif|confirm|bestätig|bestaetig|activate|aktivier|freischalt|validat|reset|zurücksetz|passwort|password|magic|sign[ -]?in|log[ -]?in|anmeld|einlogg|registrierung abschließen|complete (?:your )?registration)/i;
const LINK_NEGATIVE = /(unsubscribe|abmelden|abbestell|newsletter|privacy|datenschutz|impressum|imprint|terms|agb|nutzungsbedingung|preferences|einstellungen|help|hilfe|support|facebook|twitter|instagram|linkedin|youtube|tiktok|app ?store|google play|browser|online ansehen|view (?:it )?online|not you|nicht du|nicht angefordert|didn'?t request)/i;
const GENERIC_LABEL = /^(hier|here|klicken|click|click here|hier klicken|link|button|jetzt|now|öffnen|open)?$/i;

function safeDecode(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Picks up to `max` links that look like "confirm your email", "reset password" and the like.
 * @param {{text: string, url: string}[]} links
 */
export function findActionLinks(links, max = 3) {
  const seen = new Set();
  const scored = [];
  links.forEach(({ text, url }, order) => {
    if (!/^https?:\/\//i.test(url ?? '') || url.length > 512 || seen.has(url)) return;
    seen.add(url);
    const label = String(text ?? '').replace(/\s+/g, ' ').trim();
    const path = safeDecode(url.replace(/^https?:\/\/[^/]+/i, ''));
    if (LINK_NEGATIVE.test(label) || LINK_NEGATIVE.test(path.split('?')[0])) return;
    let score = 0;
    if (LINK_POSITIVE.test(label)) score += 3;
    if (LINK_POSITIVE.test(path)) score += GENERIC_LABEL.test(label) ? 3 : 1;
    if (score >= 3) scored.push({ label, url, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .map(({ label, url }) => ({ label, url }));
}
