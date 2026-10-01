import { normalizeDomain } from '../util/validate.js';
import { CloudflareError } from './client.js';

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function ruleIdOf(rule) {
  return rule?.id ?? rule?.tag ?? null;
}

/** Address of a rule with a literal "to" matcher, otherwise null. */
export function literalAddress(rule) {
  const matcher = rule?.matchers?.find((m) => m.type === 'literal' && m.field === 'to');
  return matcher?.value ? String(matcher.value).toLowerCase() : null;
}

export function pointsToWorker(rule, workerName) {
  return rule?.actions?.some((a) => a.type === 'worker' && (a.value ?? []).includes(workerName)) ?? false;
}

/**
 * The account's domains (zones) incl. Email Routing status, plus their routing rules.
 */
export class DomainDirectory {
  constructor({ cf, accountId, workerName, log }) {
    this.cf = cf;
    this.accountId = accountId;
    this.workerName = workerName;
    this.log = log;
    this.zones = new Map();
    this.loadedAt = 0;
  }

  async refresh() {
    const zones = await this.cf.paginate('/zones', { 'account.id': this.accountId });
    const active = zones.filter((z) => z.status === 'active');
    const entries = await mapLimit(active, 5, async (zone) => {
      let routing;
      try {
        const settings = await this.cf.get(`/zones/${zone.id}/email/routing`);
        routing = { enabled: Boolean(settings?.enabled), status: settings?.status ?? null };
      } catch (err) {
        routing = { enabled: null, status: 'unknown' };
        this.log.debug(`Could not read the Email Routing status of ${zone.name}: ${err.message}`);
      }
      return { id: zone.id, name: zone.name.toLowerCase(), routing };
    });
    this.zones = new Map(entries.map((z) => [z.name, z]));
    this.loadedAt = Date.now();
    return this.list();
  }

  list() {
    return [...this.zones.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    return this.zones.get(normalizeDomain(name)) ?? null;
  }

  getById(zoneId) {
    return this.list().find((z) => z.id === zoneId) ?? null;
  }

  // ---------- Routing rules ----------

  listRules(zoneId) {
    return this.cf.paginate(`/zones/${zoneId}/email/routing/rules`);
  }

  async findRuleFor(zoneId, address) {
    const rules = await this.listRules(zoneId);
    return rules.find((r) => literalAddress(r) === address) ?? null;
  }

  async getRule(zoneId, ruleId) {
    try {
      return await this.cf.get(`/zones/${zoneId}/email/routing/rules/${ruleId}`);
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return null;
      throw err;
    }
  }

  ruleBody({ address, name, enabled = true }) {
    return {
      name: name.slice(0, 256),
      enabled,
      matchers: [{ type: 'literal', field: 'to', value: address }],
      actions: [{ type: 'worker', value: [this.workerName] }],
    };
  }

  createRule(zoneId, { address, name }) {
    return this.cf.post(`/zones/${zoneId}/email/routing/rules`, this.ruleBody({ address, name }));
  }

  /** Changes the name / enabled state of an existing rule (Cloudflare expects the full rule). */
  async updateRule(zoneId, ruleId, { address, name, enabled }) {
    const current = await this.getRule(zoneId, ruleId);
    if (!current) return null;
    const body = {
      name: (name ?? current.name ?? '').slice(0, 256),
      enabled: enabled ?? current.enabled,
      matchers: current.matchers ?? this.ruleBody({ address, name: '' }).matchers,
      actions: current.actions ?? this.ruleBody({ address, name: '' }).actions,
      ...(current.priority !== undefined ? { priority: current.priority } : {}),
    };
    return this.cf.put(`/zones/${zoneId}/email/routing/rules/${ruleId}`, body);
  }

  /** @returns {Promise<boolean>} false if the rule was already gone */
  async deleteRule(zoneId, ruleId) {
    try {
      await this.cf.delete(`/zones/${zoneId}/email/routing/rules/${ruleId}`);
      return true;
    } catch (err) {
      if (err instanceof CloudflareError && err.status === 404) return false;
      throw err;
    }
  }
}
