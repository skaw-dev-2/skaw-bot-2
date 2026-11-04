import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { openVerificationDashboard } from '../../services/skawVerificationDashboardService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('verification')
    .setDescription('Manage SKAW Group member verification')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('panel')
      .setDescription('Open the SKAW Verification management dashboard')),

  async execute(interaction, _guildConfig, client) {
    try {
      if (!interaction.inGuild?.() || !interaction.guild) {
        return interaction.reply({
          content: 'Dashboard Verification hanya dapat digunakan di dalam server.',
          flags: MessageFlags.Ephemeral,
        });
      }
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({
          content: 'Akses ditolak. Permission Manage Server diperlukan.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return openVerificationDashboard(interaction, client);
    } catch (error) {
      const payload = {
        content: '❌ SKAW Verification: ' + String(error?.message || 'Dashboard tidak dapat dibuka.').slice(0, 1500),
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  },
};
