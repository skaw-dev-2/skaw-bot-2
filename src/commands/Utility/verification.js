import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  buildVerificationLogsEmbed,
  buildVerificationStatusEmbed,
  configureSkawVerification,
  getSkawVerificationConfig,
  getSkawVerificationLogs,
  publishSkawVerificationPanel,
  registerSkawMember,
  resetSkawVerification,
} from '../../services/skawVerificationService.js';

function assertAdministrator(interaction) {
  if (!interaction.inGuild?.() || !interaction.guild) {
    throw new Error('Command ini hanya dapat digunakan di dalam server.');
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('Akses ditolak. Permission Manage Server diperlukan.');
  }
}

export default {
  data: new SlashCommandBuilder()
    .setName('verification')
    .setDescription('Manage SKAW Group member verification')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub => sub
      .setName('setup')
      .setDescription('Configure the SKAW registration system')
      .addRoleOption(option => option.setName('verified-role').setDescription('Role assigned after successful registration').setRequired(true))
      .addRoleOption(option => option.setName('unverified-role').setDescription('Role assigned to new members before registration').setRequired(true))
      .addChannelOption(option => option.setName('channel').setDescription('Channel where the registration panel will be published').addChannelTypes(ChannelType.GuildText).setRequired(true))
      .addChannelOption(option => option.setName('log-channel').setDescription('Optional staff channel for registration logs').addChannelTypes(ChannelType.GuildText).setRequired(false)))
    .addSubcommand(sub => sub.setName('publish').setDescription('Publish or update the registration panel'))
    .addSubcommand(sub => sub.setName('status').setDescription('View the current verification configuration'))
    .addSubcommand(sub => sub
      .setName('logs')
      .setDescription('View recent verification activity')
      .addIntegerOption(option => option.setName('limit').setDescription('Number of recent activities to display').setMinValue(1).setMaxValue(15).setRequired(false)))
    .addSubcommand(sub => sub
      .setName('manual')
      .setDescription('Register a member manually as an administrator')
      .addUserOption(option => option.setName('member').setDescription('Member to register').setRequired(true))
      .addStringOption(option => option.setName('first-name').setDescription('IC first name').setMaxLength(32).setRequired(true))
      .addStringOption(option => option.setName('last-name').setDescription('IC last name').setMaxLength(32).setRequired(true)))
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Reset a member verification and require registration again')
      .addUserOption(option => option.setName('member').setDescription('Member to reset').setRequired(true))),

  async execute(interaction, _guildConfig, client) {
    try {
      assertAdministrator(interaction);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'setup') {
        const config = await configureSkawVerification(client, interaction.guild, {
          verifiedRoleId: interaction.options.getRole('verified-role', true).id,
          unverifiedRoleId: interaction.options.getRole('unverified-role', true).id,
          channelId: interaction.options.getChannel('channel', true).id,
          logChannelId: interaction.options.getChannel('log-channel')?.id || null,
        });
        return interaction.editReply({
          content: [
            '✅ SKAW Verification berhasil dikonfigurasi.',
            'Verification Channel: <#' + config.verificationChannelId + '>',
            'Verified Role: <@&' + config.verifiedRoleId + '>',
            'Unverified Role: <@&' + config.unverifiedRoleId + '>',
            config.logChannelId ? 'Log Channel: <#' + config.logChannelId + '>' : 'Log Channel: tidak diatur',
            '',
            'Langkah berikutnya: jalankan /verification publish untuk menerbitkan panel registrasi.',
          ].join('\n'),
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'publish') {
        const result = await publishSkawVerificationPanel(client, interaction.guild);
        return interaction.editReply({
          content: '✅ Panel registrasi SKAW berhasil diterbitkan atau diperbarui di ' + result.channel.toString() + '.',
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'status') {
        const config = await getSkawVerificationConfig(client, interaction.guildId);
        return interaction.editReply({ embeds: [buildVerificationStatusEmbed(interaction.guild, config)], allowedMentions: { parse: [] } });
      }

      if (subcommand === 'logs') {
        const limit = interaction.options.getInteger('limit') || 10;
        const logs = await getSkawVerificationLogs(client, interaction.guildId, limit);
        return interaction.editReply({ embeds: [buildVerificationLogsEmbed(logs)], allowedMentions: { parse: [] } });
      }

      if (subcommand === 'manual') {
        const user = interaction.options.getUser('member', true);
        const member = await interaction.guild.members.fetch(user.id);
        const result = await registerSkawMember(client, interaction.guild, member, {
          firstName: interaction.options.getString('first-name', true),
          lastName: interaction.options.getString('last-name', true),
        }, { source: 'manual', actorId: interaction.user.id });
        return interaction.editReply({
          content: '✅ Registrasi manual berhasil untuk <@' + user.id + '>.\nNama IC: **' +
            result.record.icName + '**\nNickname: **' + result.record.nickname + '**' +
            (result.duplicateWarning ? '\n⚠️ Nama IC terdeteksi duplikat, tetapi registrasi tetap diterima.' : ''),
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'reset') {
        const user = interaction.options.getUser('member', true);
        const member = await interaction.guild.members.fetch(user.id);
        await resetSkawVerification(client, interaction.guild, member, interaction.user.id);
        return interaction.editReply({
          content: '✅ Status verifikasi <@' + user.id + '> telah direset. Role Unverified diberikan dan registrasi ulang diperlukan.',
          allowedMentions: { parse: [] },
        });
      }

      throw new Error('Subcommand verification tidak dikenal.');
    } catch (error) {
      const payload = {
        content: '❌ SKAW Verification: ' + String(error?.message || 'Permintaan tidak dapat diproses.').slice(0, 1700),
        embeds: [],
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
      return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
  },
};
