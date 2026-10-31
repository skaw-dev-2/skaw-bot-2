import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  buildMemberAccessPanel,
  buildRoleAccessDashboard,
  buildRoleAccessRoleDetail,
} from '../../services/roleAccessManagerPanelService.js';

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
    .setDescription('Inspect and manage SKAW Discord role permissions and channel access.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption(option => option
      .setName('role')
      .setDescription('Open the permission profile for a role')
      .setRequired(false))
    .addUserOption(option => option
      .setName('member')
      .setDescription('Inspect the combined channel access of a member')
      .setRequired(false)),

  async execute(interaction) {
    try {
      assertAccess(interaction);
      await prepareGuild(interaction.guild);

      const role = interaction.options.getRole('role', false);
      const user = interaction.options.getUser('member', false);

      if (role && user) {
        throw new Error('Choose either a role or a member, not both.');
      }

      if (user) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) throw new Error('That member is not in this server.');
        return interaction.editReply({
          ...buildMemberAccessPanel(interaction.guild, member, 0),
          allowedMentions: { parse: [] },
        });
      }

      const payload = role
        ? buildRoleAccessRoleDetail(interaction.guild, role)
        : buildRoleAccessDashboard(interaction.guild, 0);

      return interaction.reply({
        ...payload,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const payload = {
        content: '❌ Role Access Manager: ' +
          String(error?.message || 'The request could not be completed.').slice(0, 1700),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) {
        return interaction.followUp(payload).catch(() => null);
      }
      return interaction.reply(payload).catch(() => null);
    }
  },
};
