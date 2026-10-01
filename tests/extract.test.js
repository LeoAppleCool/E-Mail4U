import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findActionLinks, findVerificationCode } from '../src/mail/extract.js';

test('detects typical verification codes (English and German mails)', () => {
  const cases = [
    ['Your code', 'Dein Bestätigungscode lautet: 482913', '482913'],
    ['Verify', 'Your verification code is 739201. It expires in 10 minutes.', '739201'],
    ['592013 is your Google verification code', 'G-592013 is your Google verification code.', '592013'],
    ['Sign-in', 'Sicherheitscode: 482 913', '482913'],
    ['Login', 'Use this code to sign in:\n\n8841\n\nIf you did not request this, ignore it.', '8841'],
    ['Microsoft account security code', 'Security code: 1234567', '1234567'],
    ['Code', 'Your one-time code: K7XQ2P', 'K7XQ2P'],
  ];
  for (const [subject, text, expected] of cases) {
    assert.equal(findVerificationCode(subject, text), expected, `${subject} / ${text}`);
  }
});

test('does not mistake order numbers, prices, dates or phone numbers for codes', () => {
  const cases = [
    ['Your order', 'Order #12345678 has shipped. Total: 1299 €'],
    ['Invoice', 'Invoice date 12.03.2026, amount 49,99 EUR, customer number 482913'],
    ['Newsletter', 'Call us: +49 1234 567890 or visit https://example.com/123456'],
    ['Welcome', 'Great to have you with us since 2024!'],
    ['Appointment', 'Your appointment is at 14:30 on 2026-10-01.'],
  ];
  for (const [subject, text] of cases) {
    assert.equal(findVerificationCode(subject, text), null, `${subject} / ${text}`);
  }
});

test('picks confirmation links and ignores unsubscribe/social links', () => {
  const links = [
    { text: '', url: 'https://example.com/logo' },
    { text: 'Confirm email address', url: 'https://example.com/confirm?t=abc' },
    { text: 'Unsubscribe', url: 'https://example.com/unsubscribe' },
    { text: 'Facebook', url: 'https://facebook.com/example' },
    { text: 'Click here', url: 'https://example.com/verify-email?token=xyz' },
    { text: 'Our blog', url: 'https://example.com/blog' },
    { text: 'Privacy', url: 'https://example.com/privacy' },
  ];
  const result = findActionLinks(links);
  assert.deepEqual(result.map((l) => l.url), ['https://example.com/confirm?t=abc', 'https://example.com/verify-email?token=xyz']);
});

test('ignores links that are too long for Discord buttons', () => {
  const url = `https://example.com/verify?t=${'x'.repeat(600)}`;
  assert.deepEqual(findActionLinks([{ text: 'Verify email', url }]), []);
});
