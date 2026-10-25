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
    clearEmployeeLogsSticker,
    getEmployeeLogsConfig,
    getEmployeeLogAudit,
    setEmployeeLogsBanner,
    setEmployeeLogsEventBanner,
    setEmployeeLogsChannel,
    setEmployeeLogsSticker,
} from '../../services/employeeLogsService.js';
import { buildEmployeeLogsPanel } from '../../services/employeeLogsInteractionService.js';

const TYPE_CHOICES = Object.entries(EMPLOYEE_LOG_TYPES).map(([value, entry]) => ({ name: `${entry.emoji} ${entry.shortLabel}`.slice(0, 100), value }));
const BANNER_EVENT_CHOICES = Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([value, entry]) => ({ name: entry.label.slice(0, 100), value }));

function requireManager(interaction) {
    if (!interaction.inGuild()) throw new Error('Command ini hanya dapat digunakan di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        throw new Error('Kamu membutuhkan permission **Manage Server** untuk mengubah konfigurasi Employee Logs.');
    }
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
        .setDescription(`**SERVER:** ${guild.name}\nManage channel routing and event branding. All Employee Logs actions require Manage Server permission.`)
        .addFields(channelFields)
        .addFields(
            { name: '🔐 Access Control', value: 'Manage Server permission required for panel, configuration, and all record actions.', inline: false },
            { name: '🖼️ Default Banner', value: config.bannerUrl ? '✅ Configured as fallback.' : '⚪ No default banner.', inline: false },
            { name: '🎨 Event-specific Banners', value: bannerLines.join('\n').slice(0, 1024), inline: false },
            { name: '✨ Optional Stickers', value: stickerLines.join('\n').slice(0, 1024), inline: false },
        )
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
}

export default {
    data: new SlashCommandBuilder()
        .setName('epl')
        .setDescription('Buka panel privat dan atur channel log karyawan SKAW GROUP.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
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
                requireManager(interaction);
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const config = await getEmployeeLogsConfig(interaction.client, guildId);
                return interaction.editReply({ ...buildEmployeeLogsPanel(config), allowedMentions: { parse: [] } });
            }
            requireManager(interaction);
            if (subcommand === 'status') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const config = await getEmployeeLogsConfig(interaction.client, guildId);
                return interaction.editReply({ embeds: [configurationEmbed(interaction.guild, config)], allowedMentions: { parse: [] } });
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
                        const line = `**${index + 1}. ${meta?.emoji || '📄'} ${meta?.shortLabel || record.type}**\nRecord ID: \`${record.recordId || 'legacy record'}\`\nEmployee: <@${record.employeeId}> · Recorded by: <@${record.recordedBy}>\nChannel: <#${record.channelId}> · ${validDate}\n[Open record](https://discord.com/channels/${guildId}/${record.channelId}/${record.messageId})`;
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
                await setEmployeeLogsChannel(interaction.client, guildId, type, channel.id, interaction.user.id);
                return interaction.editReply({ content: `✅ Channel **${EMPLOYEE_LOG_TYPES[type].shortLabel}** diset ke ${channel}.`, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-channel') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                await clearEmployeeLogsChannel(interaction.client, guildId, type, interaction.user.id);
                return interaction.editReply({ content: `✅ Channel **${EMPLOYEE_LOG_TYPES[type].shortLabel}** dihapus.`, allowedMentions: { parse: [] } });
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
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const event = interaction.options.getString('event', true);
                await clearEmployeeLogsEventBanner(interaction.client, guildId, event, interaction.user.id);
                return interaction.editReply({ content: `✅ Banner **${EMPLOYEE_LOG_BANNER_EVENTS[event].label}** dihapus.`, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-banner') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                await clearEmployeeLogsBanner(interaction.client, guildId, interaction.user.id);
                return interaction.editReply({ content: '✅ Banner default dihapus; banner event tetap berlaku.', allowedMentions: { parse: [] } });
            }
            if (subcommand === 'set-sticker') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                const stickerId = interaction.options.getString('sticker_id', true).trim();
                await setEmployeeLogsSticker(interaction.client, guildId, type, stickerId, interaction.user.id);
                return interaction.editReply({ content: `✅ Sticker disimpan untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}**. Jika sticker gagal, embed tetap dikirim.`, allowedMentions: { parse: [] } });
            }
            if (subcommand === 'clear-sticker') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                await clearEmployeeLogsSticker(interaction.client, guildId, type, interaction.user.id);
                return interaction.editReply({ content: `✅ Sticker untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}** dihapus.`, allowedMentions: { parse: [] } });
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
