import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomLocalPart } from '../src/util/random.js';
import {
  isReservedLocalPart, normalizeDomain, normalizeLocalPart, parseUserId, validateLocalPart,
} from '../src/util/validate.js';

test('normalizeLocalPart trims, lower-cases and drops @domain', () => {
  assert.equal(normalizeLocalPart('  Netflix '), 'netflix');
  assert.equal(normalizeLocalPart('Max.Muster@example.com'), 'max.muster');
  assert.equal(normalizeLocalPart(null), '');
});

test('validateLocalPart accepts valid names', () => {
  for (const ok of ['a', 'netflix', 'max.muster', 'shop-2026', 'a_b', 'x1y2z3', 'a'.repeat(64)]) {
    assert.equal(validateLocalPart(ok), null, ok);
  }
});

test('validateLocalPart rejects invalid names', () => {
  for (const bad of ['', '.abc', 'abc.', '-abc', 'abc-', 'a..b', 'a b', 'äöü', 'a+b', 'a@b', 'a'.repeat(65), 'a/b']) {
    assert.notEqual(validateLocalPart(bad), null, bad);
  }
});

test('reserved names', () => {
  assert.equal(isReservedLocalPart('postmaster'), true);
  assert.equal(isReservedLocalPart('admin'), true);
  assert.equal(isReservedLocalPart('netflix'), false);
});

test('parseUserId understands IDs and mentions', () => {
  assert.equal(parseUserId('123456789012345678'), '123456789012345678');
  assert.equal(parseUserId('<@123456789012345678>'), '123456789012345678');
  assert.equal(parseUserId('<@!123456789012345678>'), '123456789012345678');
  assert.equal(parseUserId(' 123456789012345678 '), '123456789012345678');
  assert.equal(parseUserId('1234'), null);
  assert.equal(parseUserId('leo'), null);
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain(' @Example.COM. '), 'example.com');
});

test('random names are valid', () => {
  for (let i = 0; i < 200; i++) {
    const name = randomLocalPart(10);
    assert.equal(name.length, 10);
    assert.equal(validateLocalPart(name), null, name);
  }
});
