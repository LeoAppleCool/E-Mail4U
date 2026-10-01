import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectLinks, escapeMarkdown, htmlToSegments, normalizeText, renderSegments, segmentsToPlain, truncate,
} from '../src/mail/format.js';

test('escapeMarkdown escapes markdown and mentions but keeps URLs intact', () => {
  const out = escapeMarkdown('*bold* _italic_ @everyone <@123456789012345678> https://a.com/x_y_z [a](b)');
  assert.ok(out.includes('\\*bold\\*'));
  assert.ok(out.includes('\\_italic\\_'));
  assert.ok(out.includes('@\u200beveryone'));
  assert.ok(out.includes('<\u200b@123456789012345678>'));
  assert.ok(out.includes('https://a.com/x_y_z'));
  assert.ok(out.includes('\\[a\\](b)'));
});

test('escapeMarkdown neutralizes headings at the start of a line', () => {
  assert.equal(escapeMarkdown('# Title\n-# small'), '\\# Title\n\\-# small');
});

test('normalizeText removes invisible filler characters and extra blank lines', () => {
  assert.equal(normalizeText('Hello\u200c\u034f\u00a0world\r\n\r\n\r\n\r\nBye  '), 'Hello world\n\nBye');
});

const HTML = `<html><head><style>p{color:red}</style></head><body>
<a href="https://shop.example/logo"><img src="logo.png" alt=""></a>
<h1>Welcome!</h1>
<p>Please <a href="https://example.com/verify?t=a(1)">confirm your email</a>.</p>
<p>Code: <b>482913</b></p>
<a href="https://example.com/btn"><img src="b.png" alt="Activate now"></a>
<p><a href="mailto:x@y.example">Mail</a> · <a href="https://example.com/u">Unsubscribe</a></p>
<script>alert(1)</script></body></html>`;

test('htmlToSegments produces text and link segments', () => {
  const segments = htmlToSegments(HTML);
  const links = segments.filter((s) => s.type === 'link');
  assert.deepEqual(links.map((l) => l.text), ['', 'confirm your email', 'Activate now', 'Unsubscribe']);
  const plain = segmentsToPlain(segments);
  assert.ok(plain.includes('Welcome!'));
  assert.ok(!plain.includes('alert(1)'));
  assert.ok(!plain.includes('color:red'));
  assert.equal(collectLinks(segments).length, 4);
});

test('renderSegments builds masked links and encodes parentheses in URLs', () => {
  const { text, truncated } = renderSegments(htmlToSegments(HTML), 4000);
  assert.equal(truncated, false);
  assert.ok(text.includes('[confirm your email](https://example.com/verify?t=a%281%29)'));
  assert.ok(text.includes('[Activate now](https://example.com/btn)'));
  assert.ok(!text.includes('shop.example/logo'), 'links without text are dropped');
});

test('renderSegments respects the limit and reports truncation', () => {
  const segments = [{ type: 'text', value: 'Word '.repeat(2000) }];
  const { text, truncated } = renderSegments(segments, 500);
  assert.equal(truncated, true);
  assert.ok(text.length <= 500);
});

test('renderSegments does not cut in the middle of an escape', () => {
  const segments = [{ type: 'text', value: `${'a'.repeat(9)}*${'b'.repeat(100)}` }];
  const { text } = renderSegments(segments, 10);
  assert.ok(!text.endsWith('\\'));
});

test('truncate', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('ab😀cd', 4), 'ab…', 'does not split an emoji');
});