import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import {
  buildAbsenceDatePickerPayload,
  openStaffRequestModal,
  canSubmitStaffRequest,
  getStaffRequestSettings,
  openStaffRequestSetup,
} from '../../services/staffRequestService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('staffrequest')
    .setDescription('Submit employee absence or resignation requests to SKAW Management.')
    .addSubcommand(subcommand => subcommand
      .setName('absence')
      .setDescription('Submit an absence request for Management approval.'))
    .addSubcommand(subcommand => subcommand
      .setName('resign')
      .setDescription('Submit a resignation request for Management approval.'))
    .addSubcommand(subcommand => subcommand
      .setName('setup')
      .setDescription('Configure separate Absence and Resignation channels and Management approvers.')),

  async execute(interaction, _guildConfig, client) {
    try {
      if (!interaction.inGuild?.() || !interaction.guild) {
        return interaction.reply({
          content: 'Staff Request hanya dapat digunakan di dalam server SKAW.',
          flags: MessageFlags.Ephemeral,
        });
      }

      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'setup') {
        return openStaffRequestSetup(interaction, client);
      }

      const member = interaction.member?.roles?.cache
        ? interaction.member
        : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const settings = await getStaffRequestSettings(client, interaction.guildId);
      if (!member?.roles?.cache || !canSubmitStaffRequest([...member.roles.cache.keys()], settings.managementRoleIds)) {
        return interaction.reply({
          content: 'Fitur ini hanya dapat digunakan oleh anggota Company Staff atau Management SKAW.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (subcommand === 'absence') {
        return interaction.reply({
          ...buildAbsenceDatePickerPayload(interaction.user.id),
          flags: MessageFlags.Ephemeral,
        });
      }
      if (subcommand === 'resign') {
        return openStaffRequestModal(interaction, client, 'resignation');
      }

      return interaction.reply({
        content: 'Subcommand Staff Request tidak dikenal.',
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      const payload = {
        content: '❌ Staff Request: ' + String(error?.message || 'Terjadi kesalahan.').slice(0, 1200),
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
