import { literalAddress, pointsToWorker, ruleIdOf } from '../cloudflare/domains.js';
import { userIdFromRuleName } from './addresses.js';

/**
 * Reconciles the database with the routing rules in Cloudflare:
 * - rules deleted in the dashboard → mark the address as deleted
 * - rules (de)activated in the dashboard → take over the status
 * - unknown rules that point to the worker → import them
 *   (assigned to the user from the rule name, otherwise to the owner)
 */
export async function syncWithCloudflare({ store, domains, forums, access, addresses, config, log, audit }) {
  const live = store.allLiveAddresses().filter((a) => a.kind === 'address');
  const byZone = new Map();
  for (const a of live) byZone.set(a.zone_id, [...(byZone.get(a.zone_id) ?? []), a]);
  const summary = { removed: 0, changed: 0, imported: 0 };

  for (const zone of domains.list()) {
    if (zone.routing?.enabled === false && !byZone.has(zone.id)) continue;
    let rules;
    try {
      rules = await domains.listRules(zone.id);
    } catch (err) {
      log.warn(`Sync: could not read the rules of ${zone.name}: ${err.message}`);
      continue;
    }
    const rulesById = new Map(rules.map((r) => [ruleIdOf(r), r]));

    for (const address of byZone.get(zone.id) ?? []) {
      const rule = rulesById.get(address.rule_id);
      let status = address.status;
      if (!rule) status = 'deleted';
      else if (rule.enabled === false) status = 'paused';
      else status = 'active';
      if (status === address.status) continue;

      const updated = store.updateAddress(address.id, { status, ...(status === 'deleted' ? { deleted_at: Date.now() } : {}) });
      await forums.refreshThread(updated).catch((err) => log.warn(`Sync: thread not updated: ${err.message}`));
      if (status === 'deleted') {
        summary.removed++;
        audit?.(`🧹 **${address.address}** was removed in Cloudflare and is now marked as deleted.`);
      } else {
        summary.changed++;
      }
    }

    for (const rule of rules) {
      const address = literalAddress(rule);
      if (!address || !pointsToWorker(rule, config.workerName) || store.findLiveAddress(address)) continue;
      if (addresses?.pending.has(address)) continue; // being created by /create right now
      const userId = userIdFromRuleName(rule.name) ?? access.primaryOwner();
      if (!userId) continue;
      const [localPart] = address.split('@');
      store.insertAddress({
        address, localPart, domain: zone.name, zoneId: zone.id, ruleId: ruleIdOf(rule), userId,
        threadId: null, note: null, status: rule.enabled === false ? 'paused' : 'active',
      });
      summary.imported++;
      log.info(`Sync: imported ${address} from Cloudflare (user ${userId})`);
      audit?.(`📥 **${address}** points to the worker in Cloudflare and was assigned to <@${userId}>.`);
    }
  }

  if (summary.removed || summary.changed || summary.imported) {
    log.info(`Sync: ${summary.removed} removed, ${summary.changed} status change(s), ${summary.imported} imported`);
  }
  return summary;
}
