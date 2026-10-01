import { truncate } from '../../mail/format.js';
import { randomLocalPart, randomSuffix } from '../../util/random.js';
import {
  HINT_SEPARATOR as SEP, isReservedLocalPart, normalizeDomain, normalizeLocalPart, parseUserId, validateLocalPart,
} from '../../util/validate.js';
import { ALL_DOMAINS } from '../../services/access.js';

export const NO_DOMAIN = '__none__';

// The displayed text is always "value · hint": if Discord submits the text instead of the value,
// normalizeLocalPart/normalizeDomain/parseUserId still turn it back into the value.
const choice = (name, value) => ({ name: truncate(name, 100), value: String(value).slice(0, 100) });

export function nameSuggestions(app, interaction, typed) {
  const userId = interaction.user.id;
  const domainInput = normalizeDomain(interaction.options.getString('domain') ?? '');
  // Only domains the user has access to – otherwise anyone could probe which names are taken elsewhere.
  const candidate = domainInput ? app.domains.get(domainInput) : null;
  const zone = candidate && app.access.canUseDomain(userId, candidate.name) ? candidate : null;
  const at = zone ? `@${zone.name}` : '';
  const choices = [];

  const localPart = normalizeLocalPart(typed);
  if (localPart) {
    const problem = validateLocalPart(localPart);
    if (problem) {
      choices.push(choice(`${localPart}${SEP}⚠️ ${problem}`, localPart));
    } else if (!app.access.isOwner(userId) && isReservedLocalPart(localPart)) {
      choices.push(choice(`${localPart}${SEP}⛔ reserved`, localPart));
    } else if (zone && app.store.findLiveAddress(`${localPart}${at}`)) {
      choices.push(choice(`${localPart}${at}${SEP}❌ already taken`, localPart));
      for (let i = 0; i < 2; i++) {
        const alt = `${localPart}.${randomSuffix()}`;
        if (alt.length <= 64) choices.push(choice(`${alt}${at}${SEP}🎲 with random suffix`, alt));
      }
    } else {
      choices.push(choice(`${localPart}${at}${SEP}${zone ? '✅ available' : '✅ valid'}`, localPart));
      const alt = `${localPart}.${randomSuffix()}`;
      if (alt.length <= 64) choices.push(choice(`${alt}${at}${SEP}🎲 with random suffix`, alt));
    }
  }
  for (let i = choices.length; i < 4; i++) {
    const random = randomLocalPart(10);
    choices.push(choice(`${random}${at}${SEP}🎲 random`, random));
  }
  return choices;
}

const zoneLabel = (zone) => (zone.routing?.enabled === false ? `${zone.name}${SEP}⛔ Email Routing off` : zone.name);

export function domainSuggestions(app, interaction, typed) {
  const query = normalizeDomain(typed);
  const zones = app.access.usableZones(interaction.user.id, app.domains.list());
  const owner = app.access.isOwner(interaction.user.id);
  const matches = zones
    .filter((z) => z.name.includes(query))
    .filter((z) => owner || z.routing?.enabled !== false)
    .slice(0, 25)
    .map((z) => choice(zoneLabel(z), z.name));
  if (matches.length) return matches;
  if (!zones.length) return [choice(`No domain granted${SEP}ask the bot owner`, NO_DOMAIN)];
  return [];
}

export function permsDomainSuggestions(app, typed) {
  const query = normalizeDomain(typed);
  const choices = [];
  if (!query || 'all domains'.includes(query) || query === ALL_DOMAINS) {
    choices.push(choice(`✱ All domains${SEP}including future ones`, ALL_DOMAINS));
  }
  for (const zone of app.domains.list()) {
    if (choices.length >= 25) break;
    if (zone.name.includes(query)) choices.push(choice(zoneLabel(zone), zone.name));
  }
  return choices;
}

export function addressSuggestions(app, interaction, typed) {
  const query = String(typed ?? '').split(SEP.trim())[0].trim().toLowerCase();
  const rows = app.access.isOwner(interaction.user.id)
    ? app.store.searchLiveAddresses(query, 25)
    : app.store.liveAddressesOf(interaction.user.id)
      .filter((a) => a.kind === 'address' && (a.address.includes(query) || (a.note ?? '').toLowerCase().includes(query)));
  return rows.slice(0, 25).map((a) => {
    const hints = [a.status === 'paused' ? '⏸️ paused' : null, a.note].filter(Boolean);
    return choice([a.address, ...hints].join(SEP), a.id);
  });
}

async function userSuggestions(app, interaction, typed) {
  const query = String(typed ?? '').split(SEP.trim())[0].trim();
  const choices = [];
  const seen = new Set();
  const add = (id, label) => {
    if (seen.has(id) || choices.length >= 25) return;
    seen.add(id);
    choices.push(choice(`${truncate(label, 70)}${SEP}${id}`, id));
  };

  const id = parseUserId(typed);
  if (id) {
    const user = await app.client.users.fetch(id).catch(() => null);
    if (user) add(id, `${user.username}${user.bot ? ' (bot)' : ''}`);
    else choices.push(choice(`⚠️ Unknown user ID${SEP}${id}`, id));
    return choices;
  }
  if (query && interaction.guild) {
    const members = await interaction.guild.members.search({ query, limit: 10 }).catch(() => null);
    for (const member of members?.values() ?? []) {
      if (!member.user.bot) add(member.id, `${member.displayName} (@${member.user.username})`);
    }
  }
  for (const user of app.store.searchUsers(query, 25)) add(user.user_id, user.tag ?? 'unknown');
  if (!choices.length && !query) choices.push(choice('Type a name or paste a user ID …', '0'));
  return choices;
}

export async function handleAutocomplete(app, interaction) {
  const focused = interaction.options.getFocused(true);
  let choices = [];
  switch (`${interaction.commandName}:${focused.name}`) {
    case 'create:name': choices = nameSuggestions(app, interaction, focused.value); break;
    case 'create:domain': choices = domainSuggestions(app, interaction, focused.value); break;
    case 'delete:address': choices = addressSuggestions(app, interaction, focused.value); break;
    case 'perms:user':
    case 'list:user':
      if (app.access.isOwner(interaction.user.id)) choices = await userSuggestions(app, interaction, focused.value);
      break;
    case 'perms:domain':
      if (app.access.isOwner(interaction.user.id)) choices = permsDomainSuggestions(app, focused.value);
      break;
    default: break;
  }
  await interaction.respond(choices.slice(0, 25));
}
