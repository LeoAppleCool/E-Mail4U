import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CloudflareClient, CloudflareError } from '../src/cloudflare/client.js';
import { DomainDirectory, literalAddress, pointsToWorker } from '../src/cloudflare/domains.js';
import { deployRelay, resolveAccountId } from '../src/cloudflare/relay-deploy.js';
import { Store } from '../src/db.js';
import { silentLogger } from '../src/log.js';

const ok = (result, resultInfo) => new Response(JSON.stringify({ success: true, errors: [], result, result_info: resultInfo }), {
  headers: { 'Content-Type': 'application/json' },
});
const fail = (status, code, message) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });

/** Fake-fetch: routes = [[method, pathRegex, handler(url, init, match)]] */
function fakeCloudflare(routes) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    requests.push({ method: init.method, path: u.pathname.replace('/client/v4', ''), query: Object.fromEntries(u.searchParams), init });
    for (const [method, pattern, handler] of routes) {
      const match = u.pathname.replace('/client/v4', '').match(pattern);
      if (method === init.method && match) return handler(u, init, match);
    }
    return fail(404, 7003, 'No route');
  };
  return { cf: new CloudflareClient({ token: 't0k3n', log: silentLogger, fetchImpl }), requests };
}

test('loads all zones page by page plus their Email Routing status', async () => {
  const zones = Array.from({ length: 60 }, (_, i) => ({ id: `z${i}`, name: `Domain${i}.de`, status: i === 59 ? 'pending' : 'active' }));
  const { cf, requests } = fakeCloudflare([
    ['GET', /^\/zones$/, (u) => {
      const page = Number(u.searchParams.get('page'));
      return ok(zones.slice((page - 1) * 50, page * 50), { page, per_page: 50, total_pages: 2, total_count: 60 });
    }],
    ['GET', /^\/zones\/(z\d+)\/email\/routing$/, (u, init, [, id]) => (id === 'z3'
      ? fail(403, 10000, 'Authentication error')
      : ok({ enabled: id !== 'z1', status: id === 'z1' ? 'unconfigured' : 'ready' }))],
  ]);
  const dir = new DomainDirectory({ cf, accountId: 'acc1', workerName: 'email4u-relay', log: silentLogger });
  const list = await dir.refresh();
  assert.equal(list.length, 59);
  assert.equal(dir.get('DOMAIN0.de').routing.enabled, true);
  assert.equal(dir.get('domain1.de').routing.enabled, false);
  assert.equal(dir.get('domain3.de').routing.enabled, null, 'without read permission: unknown instead of an error');
  assert.equal(requests[0].query['account.id'], 'acc1');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer t0k3n');
});

test('rules: pages without total_pages, create, update with the full body, delete', async () => {
  const rules = Array.from({ length: 55 }, (_, i) => ({
    id: `r${i}`, name: '', enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: `a${i}@example.com` }],
    actions: [{ type: 'forward', value: ['x@y.z'] }],
  }));
  let created;
  let updated;
  const { cf, requests } = fakeCloudflare([
    ['GET', /^\/zones\/z1\/email\/routing\/rules$/, (u) => {
      const page = Number(u.searchParams.get('page'));
      return ok(rules.slice((page - 1) * 50, page * 50), { page, per_page: 50, count: 5, total_count: 55 });
    }],
    ['POST', /^\/zones\/z1\/email\/routing\/rules$/, (u, init) => {
      created = JSON.parse(init.body);
      return ok({ id: 'new1', tag: 'new1', ...created });
    }],
    ['GET', /^\/zones\/z1\/email\/routing\/rules\/new1$/, () => ok({ id: 'new1', ...created, priority: 0 })],
    ['GET', /^\/zones\/z1\/email\/routing\/rules\/gone$/, () => fail(404, 2020, 'Not found')],
    ['PUT', /^\/zones\/z1\/email\/routing\/rules\/new1$/, (u, init) => {
      updated = JSON.parse(init.body);
      return ok({ id: 'new1', ...updated });
    }],
    ['DELETE', /^\/zones\/z1\/email\/routing\/rules\/new1$/, () => ok({ id: 'new1' })],
    ['DELETE', /^\/zones\/z1\/email\/routing\/rules\/gone$/, () => fail(404, 2020, 'Not found')],
  ]);
  const dir = new DomainDirectory({ cf, accountId: 'acc1', workerName: 'email4u-relay', log: silentLogger });

  assert.equal((await dir.listRules('z1')).length, 55);
  assert.equal((await dir.findRuleFor('z1', 'a54@example.com')).id, 'r54');

  const rule = await dir.createRule('z1', { address: 'netflix@example.com', name: 'E-Mail4U · leo (1)' });
  assert.equal(rule.id, 'new1');
  assert.deepEqual(created, {
    name: 'E-Mail4U · leo (1)', enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: 'netflix@example.com' }],
    actions: [{ type: 'worker', value: ['email4u-relay'] }],
  });
  assert.equal(literalAddress(rule), 'netflix@example.com');
  assert.equal(pointsToWorker(rule, 'email4u-relay'), true);

  await dir.updateRule('z1', 'new1', { address: 'netflix@example.com', enabled: false });
  assert.deepEqual(updated, { ...created, enabled: false, priority: 0 });
  assert.equal(await dir.updateRule('z1', 'gone', { enabled: false }), null);

  assert.equal(await dir.deleteRule('z1', 'new1'), true);
  assert.equal(await dir.deleteRule('z1', 'gone'), false);
  assert.equal(requests.filter((r) => r.method === 'POST').length, 1);
});

test('POST is not retried on server errors (no duplicate rules), GET is', async () => {
  let posts = 0;
  let gets = 0;
  const { cf } = fakeCloudflare([
    ['POST', /^\/zones\/z1\/email\/routing\/rules$/, () => { posts++; return fail(502, 0, 'Bad gateway'); }],
    ['GET', /^\/accounts$/, () => { gets++; return gets < 2 ? fail(503, 0, 'busy') : ok([{ id: 'acc1', name: 'Example' }]); }],
  ]);
  const dir = new DomainDirectory({ cf, accountId: 'acc1', workerName: 'w', log: silentLogger });
  await assert.rejects(dir.createRule('z1', { address: 'a@b.c', name: 'x' }), CloudflareError);
  assert.equal(posts, 1);
  assert.equal(await resolveAccountId(cf, null), 'acc1');
  assert.equal(gets, 2);
});

test('worker upload: multipart with Durable Object, secret, and the migration only the first time', async () => {
  const store = new Store(':memory:');
  let script = null;
  const uploads = [];
  let subdomainCalls = 0;
  const { cf } = fakeCloudflare([
    ['GET', /^\/accounts\/acc1\/workers\/subdomain$/, () => ok({ subdomain: 'leo' })],
    ['GET', /^\/accounts\/acc1\/workers\/scripts$/, () => ok(script ? [script] : [])],
    ['PUT', /^\/accounts\/acc1\/workers\/scripts\/email4u-relay$/, async (u, init) => {
      const metadata = JSON.parse(await init.body.get('metadata').text());
      const module = init.body.get('relay.js');
      uploads.push({ metadata, moduleType: module.type, moduleName: module.name, source: await module.text() });
      script = { id: 'email4u-relay', migration_tag: metadata.migrations?.new_tag ?? script?.migration_tag };
      return ok(script);
    }],
    ['POST', /^\/accounts\/acc1\/workers\/scripts\/email4u-relay\/subdomain$/, (u, init) => {
      subdomainCalls++;
      assert.deepEqual(JSON.parse(init.body), { enabled: true, previews_enabled: false });
      return ok({ enabled: true });
    }],
  ]);

  const url = await deployRelay({ cf, store, accountId: 'acc1', workerName: 'email4u-relay', log: silentLogger });
  assert.equal(url, 'wss://email4u-relay.leo.workers.dev/ws');
  assert.equal(uploads.length, 1);
  const [first] = uploads;
  assert.equal(first.metadata.main_module, 'relay.js');
  assert.equal(first.moduleName, 'relay.js');
  assert.equal(first.moduleType, 'application/javascript+module');
  assert.ok(first.source.includes('export class Relay'));
  assert.deepEqual(first.metadata.migrations, { new_tag: 'v1', new_sqlite_classes: ['Relay'] });
  assert.deepEqual(first.metadata.bindings[0], { type: 'durable_object_namespace', name: 'RELAY', class_name: 'Relay' });
  assert.equal(first.metadata.bindings[1].type, 'secret_text');
  assert.equal(first.metadata.bindings[1].text, store.getSetting('relay_secret'));

  // Second start without changes: no new upload
  await deployRelay({ cf, store, accountId: 'acc1', workerName: 'email4u-relay', log: silentLogger });
  assert.equal(uploads.length, 1);

  // Changed secret → new upload, but without the migration (already applied)
  store.setSetting('relay_secret', 'neu');
  await deployRelay({ cf, store, accountId: 'acc1', workerName: 'email4u-relay', log: silentLogger });
  assert.equal(uploads.length, 2);
  assert.equal(uploads[1].metadata.migrations, undefined);
  assert.equal(uploads[1].metadata.bindings[1].text, 'neu');
  assert.equal(subdomainCalls, 3);
});

test('worker upload: clear error without a workers.dev subdomain', async () => {
  const { cf } = fakeCloudflare([
    ['GET', /^\/accounts\/acc1\/workers\/subdomain$/, () => fail(404, 10007, 'workers.dev subdomain not found')],
  ]);
  await assert.rejects(
    deployRelay({ cf, store: new Store(':memory:'), accountId: 'acc1', workerName: 'w', log: silentLogger }),
    /workers\.dev subdomain/,
  );
});

test('several accounts without CLOUDFLARE_ACCOUNT_ID → clear error message', async () => {
  const { cf } = fakeCloudflare([['GET', /^\/accounts$/, () => ok([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])]]);
  await assert.rejects(resolveAccountId(cf, null), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(await resolveAccountId(cf, 'fest'), 'fest');
});
