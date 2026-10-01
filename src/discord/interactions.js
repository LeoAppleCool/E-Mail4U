import { Events, MessageFlags } from 'discord.js';
import { UserError } from '../errors.js';
import { handleDomains, handleHelp, handleSetup } from './handlers/admin.js';
import {
  handleAddressButton, handleDelete, handleList, handleMailButton, handleNoteModal,
} from './handlers/addresses.js';
import { handleAutocomplete } from './handlers/autocomplete.js';
import { handleCreate } from './handlers/create.js';
import { handlePerms } from './handlers/perms.js';
import { COLORS, respond, simpleEmbed } from './ui.js';

const COMMANDS = {
  create: handleCreate,
  delete: handleDelete,
  list: handleList,
  domains: handleDomains,
  perms: handlePerms,
  setup: handleSetup,
  help: handleHelp,
};

function describe(interaction) {
  if (interaction.isChatInputCommand() || interaction.isAutocomplete()) return `/${interaction.commandName}`;
  return interaction.customId ?? interaction.type;
}

async function route(app, interaction) {
  if (interaction.isAutocomplete()) return handleAutocomplete(app, interaction);
  if (interaction.isChatInputCommand()) {
    const handler = COMMANDS[interaction.commandName];
    if (!handler) throw new UserError('Unknown command.');
    return handler(app, interaction);
  }
  if (interaction.isButton()) {
    const [scope, action, id, extra] = interaction.customId.split(':');
    if (scope === 'a') return handleAddressButton(app, interaction, action, id, extra);
    if (scope === 'm') return handleMailButton(app, interaction, action, id);
    if (scope === 'x' && action === 'cancel') {
      return interaction.update({ embeds: [simpleEmbed(COLORS.muted, 'Cancelled.')], components: [] });
    }
    throw new UserError('This button is outdated.');
  }
  if (interaction.isModalSubmit()) {
    const [scope, action, id] = interaction.customId.split(':');
    if (scope === 'a' && action === 'notesave') return handleNoteModal(app, interaction, id);
  }
  return undefined;
}

export function registerInteractions(app) {
  app.client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.guildId !== app.config.guildId) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot only works on its own server.', flags: MessageFlags.Ephemeral }).catch(() => {});
      }
      return;
    }
    try {
      await route(app, interaction);
    } catch (err) {
      if (interaction.isAutocomplete()) {
        if (!interaction.responded) await interaction.respond([]).catch(() => {});
        if (!(err instanceof UserError)) app.log.warn(`Autocomplete ${describe(interaction)}: ${err.message}`);
        return;
      }
      const expected = err instanceof UserError;
      if (!expected) {
        app.log.error(`Error in ${describe(interaction)}:`, err);
        app.audit?.(`❌ Error in \`${describe(interaction)}\` (by <@${interaction.user.id}>): ${err.message}`);
      }
      const embed = simpleEmbed(COLORS.error, expected ? err.message : 'Something went wrong – the error was logged. Please try again in a moment.');
      await respond(interaction, { embeds: [embed], components: [] }).catch(() => {});
    }
  });
}
