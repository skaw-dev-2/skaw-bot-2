import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import {
  analyzeGuildPermissionHealth,
  compareRoleAccess,
  createRoleBackupRestorePreview,
  getRoleAccessAudit,
  getRoleAccessBackups,
} from '../../services/roleAccessManagerService.js';
import {
  buildBackupsPanel,
  buildMemberAccessPanel,
  buildPermissionPreviewPanel,
  buildRestorePreviewPanel,
  buildRoleAccessDashboard,
  buildRoleAccessRoleDetail,
  buildRoleChannelsPanel,
} from '../../services/roleAccessManagerPanelService.js';

const BLUE = 0x0878FF;

function assertAccess(interaction) {
  if (!interaction.inGuild()) throw new Error('This command can only be used inside a server.');
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('Access denied. Manage Roles permission is required.');
  }
}

async function prepareGuild(guild) {
  await guild.members.fetchMe().catch(() => null);
  await guild.roles.fetch().catch(() => null);
  await guild.channels.fetch().catch(() => null);
}

async function fetchRole(guild, roleId) {
  return guild.roles.cache.get(String(roleId)) ||
    await guild.roles.fetch(String(roleId)).catch(() => null);
}

function embed(title, description) {
  return new EmbedBuilder()
    .setColor(BLUE)
    .setAuthor({ name: 'SKAW GROUP · MANAGEMENT' })
    .setTitle(title)
    .setDescription(description)
    .setFooter({ text: 'SKAW ROLE ACCESS MANAGER' });
}

function safeDate(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? '<t:' + Math.floor(time / 1000) + ':R>' : 'Unknown time';
}

export default {
  data: new SlashCommandBuilder()
    .setName('access')
    .setDescription('Inspect and manage Discord role permissions and channel access for SKAW.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand(subcommand => subcommand
      .setName('panel')
      .setDescription('Open the centralized Role Access Manager.'))
    .addSubcommand(subcommand => subcommand
      .setName('inspect')
      .setDescription('Inspect a role permission profile.')
      .addRoleOption(option => option.setName('role').setDescription('Role to inspect').setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('channels')
      .setDescription('Inspect channel visibility for one role.')
      .addRoleOption(option => option.setName('role').setDescription('Role to inspect').setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('member')
      .setDescription('Inspect a member effective access across all their roles.')
      .addUserOption(option => option.setName('member').setDescription('Member to inspect').setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('compare')
      .setDescription('Compare permissions and channel visibility of two roles.')
      .addRoleOption(option => option.setName('first').setDescription('First role').setRequired(true))
      .addRoleOption(option => option.setName('second').setDescription('Second role').setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('health')
      .setDescription('Run a permission health check across the server.'))
    .addSubcommand(subcommand => subcommand
      .setName('audit')
      .setDescription('View Role Access Manager audit history.')
      .addIntegerOption(option => option.setName('limit').setDescription('Number of recent entries (1–25)').setMinValue(1).setMaxValue(25).setRequired(false)))
    .addSubcommand(subcommand => subcommand
      .setName('backups')
      .setDescription('List permission backups for a role.')
      .addRoleOption(option => option.setName('role').setDescription('Role whose backups should be listed').setRequired(true)))
    .addSubcommand(subcommand => subcommand
      .setName('restore')
      .setDescription('Preview and restore a saved role permission backup.')
      .addStringOption(option => option.setName('backup_id').setDescription('Backup ID from /access backups').setRequired(true).setMaxLength(40))),

  async execute(interaction, guildConfig, client) {
    try {
      assertAccess(interaction);
      await prepareGuild(interaction.guild);
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'panel') {
        return interaction.reply({
          ...buildRoleAccessDashboard(interaction.guild, 0),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'inspect') {
        const role = interaction.options.getRole('role', true);
        return interaction.reply({
          ...buildRoleAccessRoleDetail(interaction.guild, role),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'channels') {
        const role = interaction.options.getRole('role', true);
        return interaction.reply({
          ...buildRoleChannelsPanel(interaction.guild, role, 0),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'member') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const user = interaction.options.getUser('member', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) throw new Error('That member is not in this server.');
        return interaction.editReply({
          ...buildMemberAccessPanel(interaction.guild, member, 0),
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'compare') {
        const first = interaction.options.getRole('first', true);
        const second = interaction.options.getRole('second', true);
        const result = compareRoleAccess(interaction.guild, first, second);
        const permissionLines = result.permissionDifferences.slice(0, 15).map(item =>
          '• **' + item.label + '** — ' + (item.first ? '✅' : '⛔') + ' ' + first.name +
          ' / ' + (item.second ? '✅' : '⛔') + ' ' + second.name,
        );
        const channelLines = result.channelDifferences.slice(0, 15).map(item =>
          '• <#' + item.channelId + '> — ' + (item.first ? 'Visible' : 'Hidden') +
          ' / ' + (item.second ? 'Visible' : 'Hidden'),
        );
        return interaction.reply({
          embeds: [embed('ROLE PERMISSION COMPARISON', [
            '**' + first.name + '** vs **' + second.name + '**',
            'Server permission differences: **' + result.permissionDifferences.length + '**',
            'Channel visibility differences: **' + result.channelDifferences.length + '**',
            '',
            '**Server permission differences**',
            permissionLines.join('\n') || 'No differences.',
            '',
            '**Channel visibility differences**',
            channelLines.join('\n') || 'No differences.',
            '',
            'Comparison evaluates each role with @everyone. It does not combine the member’s other roles.',
          ].join('\n'))],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'health') {
        const report = analyzeGuildPermissionHealth(interaction.guild);
        const lines = report.issues.slice(0, 22).map(item =>
          (item.severity === 'critical' ? '🚨' : item.severity === 'warning' ? '⚠️' : 'ℹ️') + ' ' + item.message,
        );
        return interaction.reply({
          embeds: [embed('PERMISSION HEALTH CHECK', [
            'Roles scanned: **' + report.roleCount + '**',
            'Channels scanned: **' + report.channelCount + '**',
            'Critical: **' + report.criticalCount + '** · Warnings: **' + report.warningCount + '** · Info: **' + report.infoCount + '**',
            '',
            lines.join('\n') || 'No basic permission health issues were detected.',
            '',
            'Findings are rules-based review prompts, not automatic proof of misconfiguration.',
          ].join('\n'))],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'audit') {
        const limit = interaction.options.getInteger('limit') || 15;
        const records = await getRoleAccessAudit(client, interaction.guildId, limit);
        const lines = records.map(item =>
          '• ' + safeDate(item.timestamp) + ' · ' + item.action + ' · ' +
          (item.roleName || 'Role update') + ' · ' +
          (item.actorId ? '<@' + item.actorId + '>' : 'Actor not resolved'),
        );
        return interaction.reply({
          embeds: [embed('ROLE ACCESS · AUDIT HISTORY', lines.join('\n') || 'No Role Access Manager audit records yet.')],
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'backups') {
        const role = interaction.options.getRole('role', true);
        const backups = await getRoleAccessBackups(client, interaction.guildId, 40);
        return interaction.reply({
          ...buildBackupsPanel(role, backups),
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      }

      if (subcommand === 'restore') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const backupId = interaction.options.getString('backup_id', true).trim();
        const pending = await createRoleBackupRestorePreview(client, interaction.guild, interaction.user.id, backupId);
        const role = await fetchRole(interaction.guild, pending.roleId);
        if (!role) throw new Error('The role from this backup no longer exists.');
        return interaction.editReply({
          ...buildRestorePreviewPanel(role, pending),
          allowedMentions: { parse: [] },
        });
      }

      throw new Error('Unknown Role Access subcommand.');
    } catch (error) {
      const payload = {
        content: '❌ Role Access Manager: ' + String(error?.message || 'The request could not be completed.').slice(0, 1700),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      };
      if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
      return interaction.reply(payload).catch(() => null);
    }
  },
};
