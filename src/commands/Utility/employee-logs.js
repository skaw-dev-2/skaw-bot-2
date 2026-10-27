import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { buildEmployeeLogsPanel, buildEmployeeLogsActivitiesPanel } from '../../services/employeeLogsInteractionService.js';
import { getEmployeeLogsConfig, getEmployeeLogAudit, ensureEmployeeDirectoryBackfilled } from '../../services/employeeLogsService.js';
import {
    formatDirectoryTimestamp,
    getEmployeeDirectoryIndex,
    parseDiscordUserId,
    searchEmployeeDirectory,
} from '../../services/employeeDirectoryService.js';

const BASE_EMPLOYEE_ROLE_ID = '1564660065783390371';
const BRAND_BLUE = 0x2563eb;

function requireManageGuild(interaction) {
    if (!interaction.inGuild()) throw new Error('Command ini hanya dapat digunakan di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('Kamu membutuhkan permission Manage Server untuk mengelola Employee Logs.');
    }
}

function safeText(value, max = 180) {
    return escapeMarkdown(String(value ?? '').replace(/[\\r\\n\\t]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max)) || 'Not recorded';
}

function employeeFindEmbed(query, records) {
    const embed = new EmbedBuilder().setColor(BRAND_BLUE).setTitle('EMPLOYEE DIRECTORY')
        .setDescription(records.length
            ? 'Search results for **' + safeText(query, 100) + '**'
            : 'No employee profile or Employee Log matched **' + safeText(query, 100) + '**.');
    for (const record of records.slice(0, 10)) {
        const position = record.currentPosition?.name || record.lastKnownPosition?.name || 'Not recorded';
        const history = Array.isArray(record.history) ? record.history.slice(-3).reverse() : [];
        const historyLines = history.length
            ? history.map(item => '• ' + safeText(item.type, 30) + ' — ' + formatDirectoryTimestamp(item.publishedAt)).join('\\n')
            : 'No activity history recorded yet.';
        embed.addFields({
            name: safeText(record.displayName, 100),
            value: [
                '<@' + record.userId + '> · **' + String(record.status || 'unknown').toUpperCase() + '**',
                'Position: ' + safeText(position, 100),
                'First Sign In: ' + formatDirectoryTimestamp(record.firstSignInAt),
                'Last Sign Out: ' + formatDirectoryTimestamp(record.lastSignOutAt),
                'Last Blacklist: ' + formatDirectoryTimestamp(record.lastBlacklistAt),
                'Recent history:',
                historyLines,
            ].join('\\n').slice(0, 1000),
            inline: false,
        });
    }
    return embed;
}

function buildReportEmbed(index, audit, days) {
    const since = Date.now() - days * 86_400_000;
    const recent = audit.filter(item => new Date(item.publishedAt || 0).getTime() >= since);
    const counts = {};
    for (const item of recent) counts[item.type] = (counts[item.type] || 0) + 1;
    return new EmbedBuilder()
        .setColor(BRAND_BLUE)
        .setTitle('EMPLOYEE LOGS · MANAGEMENT REPORT')
        .setDescription('Activity summary for the last ' + days + ' days.')
        .addFields(
            { name: 'Active Employees', value: String(index.filter(item => item.status === 'active').length), inline: true },
            { name: 'Former Employees', value: String(index.filter(item => item.status === 'former').length), inline: true },
            { name: 'Directory Profiles', value: String(index.length), inline: true },
            { name: 'Records in Period', value: String(recent.length), inline: true },
            { name: 'Sign In', value: String(counts.sign_in || 0), inline: true },
            { name: 'Sign Out', value: String(counts.sign_out || 0), inline: true },
            { name: 'Promotions', value: String(counts.promotion || 0), inline: true },
            { name: 'Demotions', value: String(counts.demote || 0), inline: true },
            { name: 'Mutations', value: String(counts.mutation || 0), inline: true },
            { name: 'Resignations', value: String(counts.resignation || 0), inline: true },
            { name: 'Dismissals', value: String(counts.dismissal || 0), inline: true },
            { name: 'Warnings', value: String(counts.warning || 0), inline: true },
            { name: 'Blacklists', value: String(counts.blacklist || 0), inline: true },
            { name: 'Others', value: String(counts.others || 0), inline: true },
        )
        .setFooter({ text: 'Directory totals come from indexed profiles; activity totals come from durable Employee Logs audit entries.' })
        .setTimestamp(new Date());
}

export default {
    data: new SlashCommandBuilder()
        .setName('epl')
        .setDescription('Employee Logs and employee management for SKAW Group.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand => subcommand
            .setName('panel')
            .setDescription('Open the central Employee Logs management dashboard.'))
        .addSubcommand(subcommand => subcommand
            .setName('logs')
            .setDescription('Create and publish an Employee Log manually.'))
        .addSubcommand(subcommand => subcommand
            .setName('find')
            .setDescription('Find an employee profile and activity history.')
            .addStringOption(option => option
                .setName('query')
                .setDescription('Employee name, mention, or Discord ID.')
                .setRequired(true)
                .setMaxLength(100)))
        .addSubcommand(subcommand => subcommand
            .setName('report')
            .setDescription('View employee activity and membership statistics.')
            .addIntegerOption(option => option
                .setName('days')
                .setDescription('Activity period in days.')
                .setRequired(false)
                .addChoices(
                    { name: 'Last 7 days', value: 7 },
                    { name: 'Last 30 days', value: 30 },
                    { name: 'Last 90 days', value: 90 },
                ))),

    async execute(interaction) {
        try {
            requireManageGuild(interaction);
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === 'panel') {
                return interaction.reply({
                    ...buildEmployeeLogsPanel(),
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'logs') {
                const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
                return interaction.reply({
                    content: 'Choose the type of Employee Log to create. This manual workflow and preview are private.',
                    ...buildEmployeeLogsActivitiesPanel(config),
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'find') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const query = interaction.options.getString('query', true).trim();
                await ensureEmployeeDirectoryBackfilled(interaction.client, interaction.guild);
                let records = await searchEmployeeDirectory(interaction.client, interaction.guildId, query, { limit: 10 });
                if (!records.length) {
                    const userId = parseDiscordUserId(query);
                    if (userId) {
                        const member = await interaction.guild.members.fetch(userId).catch(() => null);
                        if (member && member.roles.cache.has(BASE_EMPLOYEE_ROLE_ID)) {
                            records = [{
                                userId: member.id,
                                displayName: member.displayName,
                                status: 'active',
                                currentPosition: null,
                                lastKnownPosition: null,
                                firstSignInAt: null,
                                lastSignOutAt: null,
                                lastBlacklistAt: null,
                                history: [],
                            }];
                        }
                    }
                }
                return interaction.editReply({
                    embeds: [employeeFindEmbed(query, records)],
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'report') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const days = interaction.options.getInteger('days') || 30;
                const [index, audit] = await Promise.all([
                    getEmployeeDirectoryIndex(interaction.client, interaction.guildId),
                    getEmployeeLogAudit(interaction.client, interaction.guildId, { limit: 1000 }),
                ]);
                return interaction.editReply({
                    embeds: [buildReportEmbed(index, audit, days)],
                    allowedMentions: { parse: [] },
                });
            }

            throw new Error('Subcommand Employee Logs tidak dikenal.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const payload = { content: '❌ Employee Logs: ' + message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
            if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
            return interaction.reply(payload).catch(() => null);
        }
    },
};
