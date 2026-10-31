import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { buildRoleAccessDashboard } from '../../services/roleAccessManagerPanelService.js';

function assertAccess(interaction) {
  if (!interaction.inGuild()) {
    throw new Error('This command can only be used inside a server.');
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Access denied. Manage Roles permission is required.');
  }
}

async function prepareGuild(guild) {
  await guild.members.fetchMe().catch(() => null);
  await guild.roles.fetch().catch(() => null);
  await guild.channels.fetch().catch(() => null);
}

export default {
  data: new SlashCommandBuilder()
    .setName('access')
    .setDescription('Manage which channels a Discord role can view.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(subcommand => subcommand
      .setName('panel')
      .setDescription('Open the SKAW role channel visibility manager')),

  async execute(interaction) {
    try {
      assertAccess(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await prepareGuild(interaction.guild);
      if (interaction.options.getSubcommand() !== 'panel') {
        throw new Error('Use /access panel to open the channel access manager.');
      }
      return interaction.editReply({
        ...buildRoleAccessDashboard(interaction.guild, 0),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const payload = {
        content: '❌ SKAW Access Manager: ' +
          String(error?.message || 'The request could not be completed.').slice(0, 1700),
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(payload).catch(() => null);
      }
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  },
};
