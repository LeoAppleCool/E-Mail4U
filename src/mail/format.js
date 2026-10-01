import { convert } from 'html-to-text';

// Control characters used to mark links in the html-to-text output.
const LINK_OPEN = '\u0001';
const LINK_SEP = '\u0002';
const LINK_CLOSE = '\u0003';
const LINK_RE = /\u0001(\d+)\u0002([^\u0001-\u0003]*)\u0003/g;
const STRAY_MARKERS = /[\u0001-\u0003]/g;

// Invisible filler characters (newsletter preheaders) and bidi control characters (spoofing).
const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/g;
const ODD_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000\t]/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Normalizes line breaks and whitespace and removes invisible characters. */
export function normalizeText(text) {
  return String(text ?? '')
    .toWellFormed()
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE, '')
    .replace(ODD_SPACES, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n +/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Escapes Discord markdown and mentions, but leaves URLs untouched so they stay clickable.
 */
export function escapeMarkdown(text) {
  let out = '';
  let last = 0;
  for (const match of String(text ?? '').matchAll(URL_RE)) {
    const url = match[0].replace(/[)\].,;:!?]+$/, '');
    out += escapePlain(text.slice(last, match.index)) + url;
    last = match.index + url.length;
  }
  return out + escapePlain(String(text ?? '').slice(last));
}

function escapePlain(text) {
  return text
    .replace(/[\\*_~`|[\]]/g, '\\$&')
    .replace(/^([ \t]*)(#{1,3} |-# )/gm, '$1\\$2')
    .replace(/<(?=[@#/])/g, '<\u200b')
    .replace(/@(?=everyone|here)/gi, '@\u200b');
}

function formatDiscordLink(elem, walk, builder) {
  const href = (elem.attribs?.href ?? '').trim();
  if (!/^https?:\/\//i.test(href)) {
    walk(elem.children, builder);
    return;
  }
  const index = builder.metadata.links.push(href) - 1;
  builder.addInline(`${LINK_OPEN}${index}${LINK_SEP}`, { noWordTransform: true });
  walk(elem.children, builder);
  builder.addInline(LINK_CLOSE, { noWordTransform: true });
}

/** Images are dropped – unless their alt text is the label of a link. */
function formatImage(elem, walk, builder) {
  const alt = (elem.attribs?.alt ?? '').trim();
  if (!alt) return;
  for (let node = elem.parent; node; node = node.parent) {
    if (node.name === 'a') {
      builder.addInline(alt);
      return;
    }
  }
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({
  selector,
  options: { uppercase: false },
}));

const HTML_OPTIONS = {
  wordwrap: false,
  preserveNewlines: false,
  selectors: [
    { selector: 'a', format: 'discordLink' },
    { selector: 'img', format: 'discordImage' },
    { selector: 'hr', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'ul', options: { itemPrefix: '• ' } },
    ...HEADINGS,
  ],
  formatters: { discordLink: formatDiscordLink, discordImage: formatImage },
};

/**
 * Splits HTML into text and link segments:
 * [{ type: 'text', value }, { type: 'link', text, url }, …]
 */
export function htmlToSegments(html) {
  const metadata = { links: [] };
  let text;
  try {
    text = convert(String(html ?? ''), HTML_OPTIONS, metadata);
  } catch {
    text = String(html ?? '').replace(/<[^>]*>/g, ' ');
  }
  text = normalizeText(text);

  const segments = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    if (match.index > last) segments.push({ type: 'text', value: text.slice(last, match.index) });
    const url = metadata.links[Number(match[1])];
    segments.push({ type: 'link', text: match[2].replace(/\s+/g, ' ').trim(), url });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });

  return segments
    .map((seg) => (seg.type === 'text' ? { ...seg, value: seg.value.replace(STRAY_MARKERS, '') } : seg))
    .filter((seg) => seg.type === 'link' || seg.value.length > 0);
}

export function textToSegments(text) {
  const value = normalizeText(text);
  return value ? [{ type: 'text', value }] : [];
}

function sanitizeUrl(url) {
  return url.replace(/[()\s]/g, (c) => ({ '(': '%28', ')': '%29' })[c] ?? '%20');
}

function renderLink({ text, url }) {
  if (!text) return '';
  const safeUrl = sanitizeUrl(url);
  const label = text.replace(/[[\]]/g, '').trim();
  if (!label) return '';
  if (/^https?:\/\//i.test(label) || label.replace(/\/$/, '') === url.replace(/\/$/, '')) return safeUrl;
  return `[${escapeMarkdown(label)}](${safeUrl})`;
}

/** Cuts at a word boundary and drops a dangling escape at the end. */
function cut(text, room) {
  if (room <= 0) return '';
  let out = text.slice(0, room);
  const boundary = out.search(/\s\S*$/);
  if (boundary > room * 0.6) out = out.slice(0, boundary);
  return out.replace(/\\+$/, (m) => (m.length % 2 ? m.slice(1) : m)).toWellFormed();
}

/**
 * Builds Discord text from segments, at most `limit` characters.
 * @returns {{ text: string, truncated: boolean }}
 */
export function renderSegments(segments, limit) {
  let out = '';
  for (const seg of segments) {
    const piece = seg.type === 'text' ? escapeMarkdown(seg.value) : renderLink(seg);
    if (out.length + piece.length <= limit) {
      out += piece;
      continue;
    }
    if (seg.type === 'text') {
      out += cut(piece, limit - out.length);
    } else {
      const label = escapeMarkdown(seg.text);
      if (out.length + label.length <= limit) out += label;
    }
    return { text: out.trim(), truncated: true };
  }
  return { text: out.trim(), truncated: false };
}

/** Plain text without markdown, e.g. for the .txt file or code detection. */
export function segmentsToPlain(segments) {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return seg.value;
      if (!seg.text) return '';
      return seg.text === seg.url ? seg.url : `${seg.text} (${seg.url})`;
    })
    .join('')
    .trim();
}

/** All links from the segments plus bare URLs in the text. */
export function collectLinks(segments) {
  const links = [];
  for (const seg of segments) {
    if (seg.type === 'link') links.push({ text: seg.text, url: seg.url });
    else for (const match of seg.value.matchAll(URL_RE)) links.push({ text: '', url: match[0].replace(/[)\].,;:!?]+$/, '') });
  }
  return links;
}

/** Truncates to `max` characters without splitting an emoji (surrogate pair). */
export function truncate(text, max) {
  const value = String(text ?? '').toWellFormed();
  if (value.length <= max) return value;
  let cutAt = max - 1;
  if (/[\uD800-\uDBFF]/.test(value[cutAt - 1] ?? '')) cutAt--;
  return `${value.slice(0, cutAt).trimEnd()}…`;
}