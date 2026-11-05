import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openRecruitmentDashboard } from '../../services/skawRecruitmentService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('recruitment')
    .setDescription('Manage SKAW Group Recruitment and Partnership')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(subcommand => subcommand
      .setName('panel')
      .setDescription('Open the SKAW Recruitment management dashboard')),

  async execute(interaction, _guildConfig, client) {
    if (!interaction.inGuild?.() || !interaction.guild) {
      return interaction.reply({
        content: 'Recruitment Manager hanya dapat digunakan di dalam server.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({
        content: 'Akses ditolak. Permission Manage Server diperlukan.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return openRecruitmentDashboard(interaction, client);
  },
};
