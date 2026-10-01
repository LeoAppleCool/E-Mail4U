import { MessageFlags } from 'discord.js';
import { UserError } from '../../errors.js';
import { ALL_DOMAINS } from '../../services/access.js';
import { parseDomainOption, parseUserId } from '../../util/validate.js';
import { COLORS, respond, simpleEmbed } from '../ui.js';

export function requireOwner(app, interaction) {
  if (!app.access.isOwner(interaction.user.id)) throw new UserError('Only the bot owner can do that.');
}

const domainLabel = (domain) => (domain === ALL_DOMAINS ? '**all domains** (including future ones)' : `**${domain}**`);

function overview(app, user, onServer) {
  const grants = app.store.grantsOf(user.id);
  const addresses = app.store.liveAddressesOf(user.id).filter((a) => a.kind === 'address');
  const lines = [];
  if (app.access.isOwner(user.id)) lines.push('👑 Bot owner – automatically has access to all domains.');
  else if (!grants.length) lines.push('No domain granted yet.');
  for (const domain of grants) {
    const count = addresses.filter((a) => domain === ALL_DOMAINS || a.domain === domain).length;
    lines.push(`• ${domainLabel(domain)} – ${count} address(es)`);
  }
  if (!onServer) lines.push('', '-# Not on the server yet – `/create` works right after joining.');
  return simpleEmbed(COLORS.info, `<@${user.id}> (${user.username})\n\n${lines.join('\n')}`, '🔑 Domain access');
}

export async function handlePerms(app, interaction) {
  requireOwner(app, interaction);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const userId = parseUserId(interaction.options.getString('user', true));
  if (!userId) throw new UserError('Please pick a user from the list or paste a valid user ID (17–20 digits).');
  const user = await app.client.users.fetch(userId).catch(() => null);
  if (!user) throw new UserError(`There is no Discord user with the ID \`${userId}\`.`);
  if (user.bot) throw new UserError('Bots can\'t get addresses.');
  app.store.upsertUser(user.id, user.username);
  const onServer = Boolean(await interaction.guild.members.fetch(user.id).catch(() => null));

  const domainInput = interaction.options.getString('domain');
  if (!domainInput) return respond(interaction, { embeds: [overview(app, user, onServer)] });

  const domain = parseDomainOption(domainInput);
  const action = interaction.options.getString('action') ?? 'add';

  if (action === 'add') {
    if (domain !== ALL_DOMAINS && !app.domains.get(domain)) {
      throw new UserError(`The domain **${domain}** doesn't exist in your Cloudflare account (or isn't active).`);
    }
    if (app.access.isOwner(user.id)) throw new UserError('That is a bot owner – owners have access to all domains anyway.');
    const added = app.store.addGrant(user.id, domain, interaction.user.id);
    const notes = [];
    if (!added) notes.push('The access already existed.');
    if (domain !== ALL_DOMAINS && app.store.grantsOf(user.id).includes(ALL_DOMAINS)) {
      notes.push('Note: this user already has access to all domains.');
    }
    const zone = app.domains.get(domain);
    if (zone?.routing?.enabled === false) notes.push(`⚠️ Email Routing is not enabled for ${domain} in Cloudflare yet.`);
    if (added) {
      app.audit?.(`🔑 <@${interaction.user.id}> granted <@${user.id}> access to ${domainLabel(domain)}.`);
      await user.send(`🎉 You can now create email addresses with ${domainLabel(domain)} on **${interaction.guild.name}** – use \`/create\` there.`)
        .catch(() => notes.push('-# Couldn\'t DM the user (DMs closed or no shared server).'));
    }
    const text = `<@${user.id}> can now create addresses with ${domainLabel(domain)}.${notes.length ? `\n\n${notes.join('\n')}` : ''}`;
    return respond(interaction, { embeds: [simpleEmbed(COLORS.ok, text, '✅ Access granted'), overview(app, user, onServer)] });
  }

  const removed = app.store.removeGrant(user.id, domain);
  if (!removed) throw new UserError(`<@${user.id}> had no access to ${domainLabel(domain)}.`);
  app.audit?.(`🔒 <@${interaction.user.id}> revoked <@${user.id}>'s access to ${domainLabel(domain)}.`);
  const remaining = app.store.liveAddressesOf(user.id)
    .filter((a) => a.kind === 'address' && !app.access.canUseDomain(user.id, a.domain));
  const notes = remaining.length
    ? `\n\nThe user still has **${remaining.length}** address(es) on domains without access – they keep working. `
      + 'You can delete them with `/delete` (as the owner you see all addresses).'
    : '';
  return respond(interaction, {
    embeds: [simpleEmbed(COLORS.warn, `<@${user.id}> no longer has access to ${domainLabel(domain)}.${notes}`, '🔒 Access revoked'), overview(app, user, onServer)],
  });
}
