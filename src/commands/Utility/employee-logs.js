import {
    ChannelType,
    EmbedBuilder,
    MessageFlags,
    PermissionFlagsBits,
    PermissionsBitField,
    SlashCommandBuilder,
} from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    EMPLOYEE_LOG_BANNER_EVENTS,
    clearEmployeeLogsBanner,
    clearEmployeeLogsEventBanner,
    clearEmployeeLogsChannel,
    clearEmployeeLogsManagementRole,
    clearEmployeeLogsStaffRole,
    clearEmployeeLogsSticker,
    getEmployeeLogsConfig,
    getEmployeeLogAudit,
    setEmployeeLogsApprovalChannel,
    setEmployeeLogsBanner,
    setEmployeeLogsEventBanner,
    setEmployeeLogsChannel,
    setEmployeeLogsManagementRole,
    setEmployeeLogsStaffRole,
    setEmployeeLogsSticker,
} from '../../services/employeeLogsService.js';
import { buildEmployeeLogsPanel, startEmployeeLogsInteractionHandler } from '../../services/employeeLogsInteractionService.js';

const TYPE_CHOICES = Object.entries(EMPLOYEE_LOG_TYPES).map(([value, entry]) => ({ name: `${entry.emoji} ${entry.shortLabel}`.slice(0, 100), value }));
const BANNER_EVENT_CHOICES = Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([value, entry]) => ({ name: entry.label.slice(0, 100), value }));

function requireManager(interaction) {
    if (!interaction.inGuild()) throw new Error('Command ini hanya dapat digunakan di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        throw new Error('Kamu membutuhkan permission **Manage Server** untuk mengubah konfigurasi Employee Logs.');
    }
}
function canUsePanel(interaction, config) {
    const roles = interaction.member?.roles;
    const hasStaffRole = config.staffRoleId && (roles?.cache?.has?.(config.staffRoleId)
        || (Array.isArray(roles) && roles.includes(config.staffRoleId))
        || interaction.guild?.members?.cache?.get(interaction.user.id)?.roles?.cache?.has?.(config.staffRoleId));
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        || hasStaffRole);
}
async function assertCanSend(channel, guild) {
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== guild.id) throw new Error('Pilih channel teks dari server yang sama.');
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(me || guild.client.user);
    const required = PermissionsBitField.Flags.ViewChannel | PermissionsBitField.Flags.SendMessages | PermissionsBitField.Flags.EmbedLinks;
    if (!permissions?.has(required)) throw new Error(`Bot membutuhkan izin View Channel, Send Messages, dan Embed Links di ${channel}.`);
}
function configurationEmbed(guild, config) {
    const channelFields = Object.entries(EMPLOYEE_LOG_TYPES).map(([type, entry]) => ({
        name: `${entry.emoji} ${entry.shortLabel}`,
        value: config.channels[type] ? `<#${config.channels[type]}>` : '⚪ Not configured',
        inline: true,
    }));
    const bannerLines = Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([key, entry]) => `${config.banners?.[key] ? '🟢' : '⚪'} **${entry.label}:** ${config.banners?.[key] ? 'Configured' : 'Default / none'}`);
    const stickerLines = Object.entries(EMPLOYEE_LOG_TYPES).map(([type, entry]) => `${config.stickers?.[type] ? '✨' : '⚪'} **${entry.shortLabel}:** ${config.stickers?.[type] ? `Configured (${config.stickers[type]})` : 'Not configured'}`);
    return new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: '🏢 SKAW GROUP • PEOPLE OPERATIONS' })
        .setTitle('⚙️ EMPLOYEE RECORDS CONFIGURATION')
        .setDescription(`**SERVER:** ${guild.name}\nManage channel routing, branding, staff access, and approval workflow from this configuration.`)
        .addFields(channelFields)
        .addFields(
            { name: '🔐 Staff Access', value: config.staffRoleId ? `<@&${config.staffRoleId}>` : 'No staff role set — Manage Server permission required.', inline: false },
            { name: '🛡️ Management Approver Role', value: config.managementRoleId ? `<@&${config.managementRoleId}>` : '⚠️ Not configured — Blacklist and Dismissal approval is unavailable.', inline: false },
            { name: '📨 Approval Queue Channel', value: config.approvalChannelId ? `<#${config.approvalChannelId}>` : '⚠️ Not configured — Blacklist and Dismissal approval is unavailable.', inline: false },
            { name: '🖼️ Default Banner', value: config.bannerUrl ? '✅ Configured as fallback.' : '⚪ No default banner.', inline: false },
            { name: '🎨 Event-specific Banners', value: bannerLines.join('\n').slice(0, 1024), inline: false },
            { name: '✨ Optional Stickers', value: stickerLines.join('\n').slice(0, 1024), inline: false },
        )
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
}

export default {
    data: new SlashCommandBuilder()
        .setName('employee-logs')
        .setDescription('Buka panel privat dan atur channel log karyawan SKAW GROUP.')
        // Leave command visible so a configured staff role can use /panel; sensitive config subcommands are checked below.
        .addSubcommand(subcommand => subcommand.setName('panel').setDescription('Buka panel Employee Logs privat dari channel mana pun.'))
        .addSubcommand(subcommand => subcommand.setName('set-channel').setDescription('Atur channel tujuan untuk salah satu jenis log.')
            .addStringOption(option => option.setName('type').setDescription('Jenis log.').setRequired(true).addChoices(...TYPE_CHOICES))
            .addChannelOption(option => option.setName('channel').setDescription('Channel teks tujuan.').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('clear-channel').setDescription('Hapus channel tujuan untuk jenis log.')
            .addStringOption(option => option.setName('type').setDescription('Jenis log.').setRequired(true).addChoices(...TYPE_CHOICES)))
        .addSubcommand(subcommand => subcommand.setName('set-banner').setDescription('Atur banner default/fallback untuk log.')
            .addStringOption(option => option.setName('url').setDescription('URL gambar HTTPS langsung.').setRequired(true).setMaxLength(500)))
        .addSubcommand(subcommand => subcommand.setName('set-event-banner').setDescription('Atur banner berbeda untuk satu aktivitas.')
            .addStringOption(option => option.setName('event').setDescription('Aktivitas yang memakai banner.').setRequired(true).addChoices(...BANNER_EVENT_CHOICES))
            .addStringOption(option => option.setName('url').setDescription('URL gambar HTTPS langsung.').setRequired(true).setMaxLength(500)))
        .addSubcommand(subcommand => subcommand.setName('clear-event-banner').setDescription('Hapus banner khusus satu aktivitas.')
            .addStringOption(option => option.setName('event').setDescription('Aktivitas.').setRequired(true).addChoices(...BANNER_EVENT_CHOICES)))
        .addSubcommand(subcommand => subcommand.setName('clear-banner').setDescription('Hapus banner default; banner event tetap berlaku.'))
        .addSubcommand(subcommand => subcommand.setName('set-sticker').setDescription('Atur sticker opsional untuk jenis log.')
            .addStringOption(option => option.setName('type').setDescription('Jenis log.').setRequired(true).addChoices(...TYPE_CHOICES))
            .addStringOption(option => option.setName('sticker_id').setDescription('ID sticker server Discord.').setRequired(true).setMinLength(17).setMaxLength(20)))
        .addSubcommand(subcommand => subcommand.setName('clear-sticker').setDescription('Hapus sticker opsional dari jenis log.')
            .addStringOption(option => option.setName('type').setDescription('Jenis log.').setRequired(true).addChoices(...TYPE_CHOICES)))
        .addSubcommand(subcommand => subcommand.setName('set-staff-role').setDescription('Role yang boleh membuat employee logs.')
            .addRoleOption(option => option.setName('role').setDescription('Role staff yang diizinkan.').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('clear-staff-role').setDescription('Hapus role staff; panel kembali terbatas ke Manage Server.'))
        .addSubcommand(subcommand => subcommand.setName('set-management-role').setDescription('Role yang boleh menyetujui Blacklist dan Dismissal.')
            .addRoleOption(option => option.setName('role').setDescription('Role Management approver.').setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('clear-management-role').setDescription('Hapus role approver Management.'))
        .addSubcommand(subcommand => subcommand.setName('set-approval-channel').setDescription('Atur channel antrian persetujuan Blacklist dan Dismissal.')
            .addChannelOption(option => option.setName('channel').setDescription('Channel privat yang hanya dapat diakses Management.').addChannelTypes(ChannelType.GuildText).setRequired(true)))
        .addSubcommand(subcommand => subcommand.setName('status').setDescription('Lihat seluruh channel dan konfigurasi Employee Logs.'))
        .addSubcommand(subcommand => subcommand.setName('history').setDescription('Lihat audit trail log yang sudah dipublikasikan.')
            .addStringOption(option => option.setName('type').setDescription('Filter jenis log (opsional).').setRequired(false).addChoices(...TYPE_CHOICES))
            .addIntegerOption(option => option.setName('limit').setDescription('Jumlah catatan, maksimum 25.').setRequired(false).setMinValue(1).setMaxValue(25))),

    async execute(interaction) {
        try {
            if (!interaction.inGuild()) throw new Error('Command ini hanya dapat digunakan di server.');
            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guildId;
            if (subcommand === 'panel') {
                // Self-start the interaction listener when the panel is first opened; duplicate app.js hooks remain safe/idempotent.
                startEmployeeLogsInteractionHandler(interaction.client);
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const config = await getEmployeeLogsConfig(interaction.client, guildId);
                if (!canUsePanel(interaction, config)) {
                    return interaction.editReply({ content: '❌ Kamu membutuhkan role Staff yang dikonfigurasi atau permission Manage Server untuk menggunakan panel.', allowedMentions: { parse: [] } });
                }
                return interaction.editReply({ ...buildEmployeeLogsPanel(), allowedMentions: { parse: [] } });
            }
            requireManager(interaction);
            if (subcommand === 'status') {
                const config = await getEmployeeLogsConfig(interaction.client, guildId);
                return interaction.reply({ embeds: [configurationEmbed(interaction.guild, config)], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'history') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type');
                const limit = interaction.options.getInteger('limit') || 10;
                const records = await getEmployeeLogAudit(interaction.client, guildId, { type, limit });
                const embed = new EmbedBuilder().setColor(0x2563eb).setAuthor({ name: '🏢 SKAW GROUP • PEOPLE OPERATIONS' }).setTitle('📚 EMPLOYEE LOG AUDIT HISTORY').setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' }).setTimestamp(new Date());
                if (!records.length) embed.setDescription('No published records were found for this filter.');
                else {
                    const lines = [];
                    let total = 0;
                    for (const [index, record] of records.entries()) {
                        const meta = EMPLOYEE_LOG_TYPES[record.type];
                        const date = new Date(record.publishedAt);
                        const validDate = Number.isNaN(date.getTime()) ? 'Unknown time' : `<t:${Math.floor(date.getTime() / 1000)}:f>`;
                        const line = `**${index + 1}. ${meta?.emoji || '📄'} ${meta?.shortLabel || record.type}**\nEmployee: <@${record.employeeId}> · Recorded by: <@${record.recordedBy}>${record.approvedBy ? ` · Approved by: <@${record.approvedBy}>` : ''}\nChannel: <#${record.channelId}> · ${validDate}\n[Open record](https://discord.com/channels/${guildId}/${record.channelId}/${record.messageId})`;
                        if (total + line.length > 3800) break;
                        lines.push(line); total += line.length + 2;
                    }
                    embed.setDescription(lines.join('\n\n'));
                }
                return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-channel') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                const channel = interaction.options.getChannel('channel', true);
                await assertCanSend(channel, interaction.guild);
                const currentConfig = await getEmployeeLogsConfig(interaction.client, guildId);
                if (currentConfig.approvalChannelId === channel.id) throw new Error('Channel approval Management tidak boleh dipakai sebagai channel log resmi.');
                await setEmployeeLogsChannel(interaction.client, guildId, type, channel.id, interaction.user.id);
                return interaction.editReply({ content: `✅ Channel **${EMPLOYEE_LOG_TYPES[type].shortLabel}** diset ke ${channel}.`, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-channel') {
                const type = interaction.options.getString('type', true);
                await clearEmployeeLogsChannel(interaction.client, guildId, type, interaction.user.id);
                return interaction.reply({ content: `✅ Channel **${EMPLOYEE_LOG_TYPES[type].shortLabel}** dihapus.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-banner') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await setEmployeeLogsBanner(interaction.client, guildId, interaction.options.getString('url', true), interaction.user.id);
                return interaction.editReply({ content: '✅ Banner default/fallback disimpan.', allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-event-banner') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const event = interaction.options.getString('event', true);
                await setEmployeeLogsEventBanner(interaction.client, guildId, event, interaction.options.getString('url', true), interaction.user.id);
                return interaction.editReply({ content: `✅ Banner **${EMPLOYEE_LOG_BANNER_EVENTS[event].label}** disimpan.`, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-event-banner') {
                const event = interaction.options.getString('event', true);
                await clearEmployeeLogsEventBanner(interaction.client, guildId, event, interaction.user.id);
                return interaction.reply({ content: `✅ Banner **${EMPLOYEE_LOG_BANNER_EVENTS[event].label}** dihapus.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-banner') {
                await clearEmployeeLogsBanner(interaction.client, guildId, interaction.user.id);
                return interaction.reply({ content: '✅ Banner default dihapus; banner event tetap berlaku.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-sticker') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                const stickerId = interaction.options.getString('sticker_id', true).trim();
                await setEmployeeLogsSticker(interaction.client, guildId, type, stickerId, interaction.user.id);
                return interaction.editReply({ content: `✅ Sticker disimpan untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}**. Jika sticker gagal, embed tetap dikirim.`, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-sticker') {
                const type = interaction.options.getString('type', true);
                await clearEmployeeLogsSticker(interaction.client, guildId, type, interaction.user.id);
                return interaction.reply({ content: `✅ Sticker untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}** dihapus.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-staff-role') {
                const role = interaction.options.getRole('role', true);
                await setEmployeeLogsStaffRole(interaction.client, guildId, role.id, interaction.user.id);
                return interaction.reply({ content: `✅ Role Staff diset ke ${role}. Role ini dapat menggunakan panel Employee Logs.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-staff-role') {
                await clearEmployeeLogsStaffRole(interaction.client, guildId, interaction.user.id);
                return interaction.reply({ content: '✅ Role Staff dihapus. Panel kembali hanya untuk pengguna dengan Manage Server.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-management-role') {
                const role = interaction.options.getRole('role', true);
                if (role.id === interaction.guildId) throw new Error('Pilih role Management, bukan @everyone.');
                await setEmployeeLogsManagementRole(interaction.client, guildId, role.id, interaction.user.id);
                return interaction.reply({ content: `✅ Role approver Management diset ke ${role}.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-management-role') {
                await clearEmployeeLogsManagementRole(interaction.client, guildId, interaction.user.id);
                return interaction.reply({ content: '✅ Role approver Management dihapus. Persetujuan Blacklist/Dismissal dinonaktifkan sampai role baru diset.', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-approval-channel') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const channel = interaction.options.getChannel('channel', true);
                await assertCanSend(channel, interaction.guild);
                const currentConfig = await getEmployeeLogsConfig(interaction.client, guildId);
                if (Object.values(currentConfig.channels).includes(channel.id)) throw new Error('Pilih channel khusus Management yang berbeda dari semua channel log resmi.');
                await setEmployeeLogsApprovalChannel(interaction.client, guildId, channel.id, interaction.user.id);
                return interaction.editReply({ content: `✅ Approval queue diset ke ${channel}. Pastikan channel ini hanya dapat dilihat Management.`, allowedMentions: { parse: [] } });
            }
            throw new Error('Subcommand tidak dikenal.');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const payload = { content: `❌ ${message}`, allowedMentions: { parse: [] } };
            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
        }
    },
};
