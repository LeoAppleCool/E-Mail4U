import { ChannelType, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

/** Slash commands (registered for the server on startup). */
export function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('create')
      .setDescription('Create a new email address – incoming mail lands in your private forum')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((o) => o
        .setName('name')
        .setDescription('Part before the @, e.g. "netflix" → netflix@your-domain.com (incl. random suggestions)')
        .setRequired(true)
        .setAutocomplete(true)
        .setMaxLength(100))
      .addStringOption((o) => o
        .setName('domain')
        .setDescription('Domain of the address')
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((o) => o
        .setName('note')
        .setDescription('What is the address for? (optional, e.g. "Netflix account")')
        .setMaxLength(100)),

    new SlashCommandBuilder()
      .setName('delete')
      .setDescription('Delete one of your email addresses')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((o) => o
        .setName('address')
        .setDescription('Which address? (afterwards you can choose whether to keep the thread)')
        .setRequired(true)
        .setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('list')
      .setDescription('Show your email addresses')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((o) => o
        .setName('user')
        .setDescription('(Owner only) Show the addresses of another user')
        .setAutocomplete(true)),

    new SlashCommandBuilder()
      .setName('domains')
      .setDescription('Shows which domains you can create addresses for')
      .setContexts(InteractionContextType.Guild),

    new SlashCommandBuilder()
      .setName('perms')
      .setDescription('(Owner) Grant, revoke or show domain access for a user')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o
        .setName('user')
        .setDescription('Pick a user or paste a user ID – also works for people who are not on the server yet')
        .setRequired(true)
        .setAutocomplete(true))
      .addStringOption((o) => o
        .setName('domain')
        .setDescription('Domain or "All domains" – leave empty to see the current access')
        .setAutocomplete(true))
      .addStringOption((o) => o
        .setName('action')
        .setDescription('Grant or revoke access (default: grant)')
        .addChoices({ name: 'Grant access', value: 'add' }, { name: 'Revoke access', value: 'remove' })),

    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('(Owner) Set up the bot – without options it shows the status')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((o) => o
        .setName('category')
        .setDescription('Category in which the private forums are created')
        .addChannelTypes(ChannelType.GuildCategory))
      .addIntegerOption((o) => o
        .setName('limit')
        .setDescription('Maximum number of addresses per user (the owner is unlimited)')
        .setMinValue(1)
        .setMaxValue(1000))
      .addChannelOption((o) => o
        .setName('log')
        .setDescription('Channel for log messages (new/deleted addresses, access changes, errors)')
        .addChannelTypes(ChannelType.GuildText))
      .addBooleanOption((o) => o
        .setName('log_off')
        .setDescription('Turn log messages off')),

    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Short guide to E-Mail4U')
      .setContexts(InteractionContextType.Guild),
  ].map((command) => command.toJSON());
}
