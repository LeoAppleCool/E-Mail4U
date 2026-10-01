export const ALL_DOMAINS = '*';

/**
 * Who may use which domains? The bot owner may always use every domain,
 * everybody else only the domains the owner granted with /perms.
 */
export class Access {
  constructor({ store, config }) {
    this.store = store;
    this.configuredOwners = config.ownerIds;
    this.owners = new Set(config.ownerIds);
  }

  /** Takes the owners from the Discord developer portal (unless OWNER_IDS is set). */
  setApplicationOwners(ids) {
    if (!this.configuredOwners.length) this.owners = new Set(ids.filter(Boolean));
  }

  isOwner(userId) {
    return this.owners.has(userId);
  }

  primaryOwner() {
    return [...this.owners][0] ?? null;
  }

  ownerIds() {
    return [...this.owners];
  }

  hasAllDomains(userId) {
    return this.isOwner(userId) || this.store.grantsOf(userId).includes(ALL_DOMAINS);
  }

  canUseDomain(userId, domain) {
    if (this.isOwner(userId)) return true;
    const grants = this.store.grantsOf(userId);
    return grants.includes(ALL_DOMAINS) || grants.includes(domain);
  }

  /** All zones the user may use. */
  usableZones(userId, zones) {
    if (this.hasAllDomains(userId)) return zones;
    const grants = new Set(this.store.grantsOf(userId));
    return zones.filter((z) => grants.has(z.name));
  }
}
