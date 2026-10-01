import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.js';
import {
  addressSuggestions, domainSuggestions, nameSuggestions, permsDomainSuggestions,
} from '../src/discord/handlers/autocomplete.js';
import { Access } from '../src/services/access.js';
import {
  extractAddress, normalizeDomain, normalizeLocalPart, parseDomainOption, parseUserId,
} from '../src/util/validate.js';

const OWNER = '999999999999999999';
const USER = '111111111111111111';

function setup() {
  const store = new Store(':memory:');
  const zones = [
    { id: 'z1', name: 'example.com', routing: { enabled: true } },
    { id: 'z2', name: 'off.example', routing: { enabled: false } },
  ];
  const app = {
    store,
    access: new Access({ store, config: { ownerIds: [OWNER] } }),
    domains: { list: () => zones, get: (name) => zones.find((z) => z.name === normalizeDomain(name)) ?? null },
  };
  store.addGrant(USER, 'example.com', OWNER);
  store.insertAddress({
    address: 'netflix@example.com', localPart: 'netflix', domain: 'example.com', zoneId: 'z1',
    ruleId: 'r1', userId: USER, threadId: null, note: 'Streaming · subscription',
  });
  return app;
}

const interaction = (userId, options = {}) => ({
  user: { id: userId },
  options: { getString: (name) => options[name] ?? null },
});

test('a displayed suggestion with an emoji in front still yields the plain name', () => {
  assert.equal(normalizeLocalPart('✅ test'), 'test');
  assert.equal(normalizeLocalPart('test@example.com · ✅ available'), 'test');
  assert.equal(normalizeLocalPart('🎲 x7k2m9qp · random'), 'x7k2m9qp');
  assert.equal(normalizeLocalPart('-abc'), '-abc', 'normal input stays unchanged');
});

test('name suggestions: the displayed text always maps back to the choice value', () => {
  const app = setup();
  const cases = [
    [USER, 'test', 'example.com'],
    [USER, '✅ test', 'example.com'],
    [USER, 'netflix', 'example.com'], // already taken
    [USER, 'admin', 'example.com'], // reserved
    [USER, 'Te st!', null], // invalid
    [USER, '', null], // random names only
    [OWNER, 'Info', 'off.example'],
  ];
  for (const [userId, typed, domain] of cases) {
    const choices = nameSuggestions(app, interaction(userId, { domain }), typed);
    assert.ok(choices.length >= 4, `${typed}: ${choices.length} suggestions`);
    for (const c of choices) {
      assert.ok(c.name.length <= 100 && c.value.length <= 100);
      if (!c.name.includes('⚠️')) assert.equal(normalizeLocalPart(c.name), c.value, `"${c.name}"`);
    }
  }
  const [first] = nameSuggestions(app, interaction(USER, { domain: 'example.com' }), 'test');
  assert.deepEqual(first, { name: 'test@example.com · ✅ available', value: 'test' });
});

test('domain suggestions (incl. "Email Routing off") map back to the domain', () => {
  const app = setup();
  for (const userId of [USER, OWNER]) {
    for (const c of domainSuggestions(app, interaction(userId), '')) {
      assert.equal(normalizeDomain(c.name), c.value, `"${c.name}"`);
    }
  }
  assert.deepEqual(domainSuggestions(app, interaction(USER), '').map((c) => c.value), ['example.com']);
});

test('/perms: "All domains" and domains survive the displayed text', () => {
  const app = setup();
  const choices = permsDomainSuggestions(app, '');
  assert.equal(choices[0].value, '*');
  for (const c of choices) assert.equal(parseDomainOption(c.name), c.value, `"${c.name}"`);
  assert.equal(parseDomainOption('*'), '*');
});

test('/delete: the address is recognized from the displayed text', () => {
  const app = setup();
  const [c] = addressSuggestions(app, interaction(USER), 'net');
  assert.equal(c.name, 'netflix@example.com · Streaming · subscription');
  assert.equal(app.store.findLiveAddress(extractAddress(c.name)).id, Number(c.value));
});

test('user suggestions: the ID is part of the displayed text', () => {
  assert.equal(parseUserId('Alex (@alex) · 123456789012345678'), '123456789012345678');
  assert.equal(parseUserId('alex · 123456789012345678'), '123456789012345678');
  assert.equal(parseUserId('alex'), null);
});
