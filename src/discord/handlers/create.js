import { MessageFlags } from 'discord.js';
import { UserError } from '../../errors.js';
import { COLORS, simpleEmbed } from '../ui.js';
import { NO_DOMAIN } from './autocomplete.js';

export async function handleCreate(app, interaction) {
  const name = interaction.options.getString('name', true);
  const domain = interaction.options.getString('domain', true);
  const note = interaction.options.getString('note');
  if (domain === NO_DOMAIN) {
    throw new UserError('You don\'t have access to any domain yet. The bot owner can grant it with `/perms`.');
  }
  if (app.cloudflare && !app.cloudflare.ready) {
    throw new UserError('The connection to Cloudflare isn\'t ready right now – the owner can see why under `/setup`.');
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  app.store.upsertUser(interaction.user.id, interaction.user.username);
  const { address, thread } = await app.addresses.create({ user: interaction.user, name, domain, note });

  const lines = [
    `**${address.address}** is ready.`,
    `From now on every mail to this address shows up in ${thread}.`,
  ];
  if (address.note) lines.push(`Note: ${address.note}`);
  lines.push('', '-# The address can only receive – sending is not possible with Cloudflare Email Routing.');
  await interaction.editReply({ embeds: [simpleEmbed(COLORS.ok, lines.join('\n'), '✅ Address created')] });
}
