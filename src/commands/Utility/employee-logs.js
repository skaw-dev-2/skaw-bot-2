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
    getEmployeeLogsConfig,
    setEmployeeLogsBanner,
    setEmployeeLogsEventBanner,
    setEmployeeLogsChannel,
    setEmployeeLogsSticker,
    clearEmployeeLogsSticker,
} from '../../services/employeeLogsService.js';
import { buildEmployeeLogsPanel } from '../../services/employeeLogsInteractionService.js';

const TYPE_CHOICES = Object.entries(EMPLOYEE_LOG_TYPES).map(([value, entry]) => ({
    name: `${entry.emoji} ${entry.shortLabel}`,
    value,
}));

const BANNER_EVENT_CHOICES = Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([value, entry]) => ({
    name: entry.label,
    value,
}));

function requireManageGuild(interaction) {
    if (!interaction.inGuild()) throw new Error('Command ini hanya dapat digunakan di server.');
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        throw new Error('Kamu membutuhkan permission **Manage Server** untuk mengelola Employee Logs.');
    }
}

async function assertCanSend(channel, guild) {
    if (!channel || !channel.isTextBased() || channel.isDMBased() || channel.guildId !== guild.id) {
        throw new Error('Pilih channel teks dari server yang sama.');
    }
    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    const permissions = channel.permissionsFor(me || guild.client.user);
    const required = PermissionsBitField.Flags.ViewChannel
        | PermissionsBitField.Flags.SendMessages
        | PermissionsBitField.Flags.EmbedLinks;
    if (!permissions?.has(required)) throw new Error(`Bot membutuhkan izin View Channel, Send Messages, dan Embed Links di ${channel}.`);
}

function configEmbed(guild, config) {
    const fields = Object.entries(EMPLOYEE_LOG_TYPES).map(([type, entry]) => ({
        name: `${entry.emoji} ${entry.shortLabel}`,
        value: config.channels[type] ? `<#${config.channels[type]}>` : '⚪ Not configured — use `/employee-logs set-channel`',
        inline: true,
    }));
    return new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: '🏢 SKAW GROUP • PEOPLE OPERATIONS' })
        .setTitle('⚙️  EMPLOYEE RECORDS CONFIGURATION')
        .setDescription(`**SERVER:** ${guild.name}\nManage personnel log routing, brand banner, and optional sticker accents from this panel.`)
        .addFields(fields)
        .addFields({
            name: '🖼️ Default Banner',
            value: config.bannerUrl ? '✅ Configured — used when no event-specific banner is set.' : '⚪ Not configured — event-specific banners can still be used.',
            inline: false,
        }, {
            name: '🎨 Event-specific Banners',
            value: Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([key, entry]) => `${config.banners?.[key] ? '🟢' : '⚪'} **${entry.label}:** ${config.banners?.[key] ? 'Configured' : 'Default/fallback'}`).join('\n'),
            inline: false,
        }, {
            name: '✨ Optional Stickers',
            value: Object.keys(EMPLOYEE_LOG_TYPES).map(type => `${EMPLOYEE_LOG_TYPES[type].emoji} **${EMPLOYEE_LOG_TYPES[type].shortLabel}:** ${config.stickers?.[type] ? `Configured (\`${config.stickers[type]}\`)` : 'Not configured'}`).join('\n'),
            inline: false,
        })
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
}

export default {
    data: new SlashCommandBuilder()
        .setName('employee-logs')
        .setDescription('Buat panel dan atur channel surat/log karyawan SKAW.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand => subcommand
            .setName('panel')
            .setDescription('Kirim panel interaktif Employee Logs ke channel pilihan.')
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Channel tempat panel interaktif akan dikirim.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('set-channel')
            .setDescription('Atur channel tujuan untuk salah satu jenis log.')
            .addStringOption(option => option
                .setName('type')
                .setDescription('Jenis log yang channel-nya ingin diatur.')
                .setRequired(true)
                .addChoices(...TYPE_CHOICES))
            .addChannelOption(option => option
                .setName('channel')
                .setDescription('Channel teks tujuan pengiriman log.')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true)))
        .addSubcommand(subcommand => subcommand
            .setName('clear-channel')
            .setDescription('Hapus konfigurasi channel dari salah satu jenis log.')
            .addStringOption(option => option
                .setName('type')
                .setDescription('Jenis log yang channel-nya akan dilepas.')
                .setRequired(true)
                .addChoices(...TYPE_CHOICES)))
        .addSubcommand(subcommand => subcommand
            .setName('set-banner')
            .setDescription('Atur gambar banner default jika event tidak punya banner khusus.')
            .addStringOption(option => option
                .setName('url')
                .setDescription('URL gambar HTTPS langsung (misalnya gambar dari Discord CDN).')
                .setRequired(true)
                .setMaxLength(500)))
        .addSubcommand(subcommand => subcommand
            .setName('set-event-banner')
            .setDescription('Atur banner berbeda untuk satu event log tertentu.')
            .addStringOption(option => option
                .setName('event')
                .setDescription('Event atau jenis log yang menggunakan banner ini.')
                .setRequired(true)
                .addChoices(...BANNER_EVENT_CHOICES))
            .addStringOption(option => option
                .setName('url')
                .setDescription('URL gambar HTTPS langsung.')
                .setRequired(true)
                .setMaxLength(500)))
        .addSubcommand(subcommand => subcommand
            .setName('clear-event-banner')
            .setDescription('Hapus banner khusus event dan kembali ke banner default.')
            .addStringOption(option => option
                .setName('event')
                .setDescription('Event yang banner khususnya ingin dihapus.')
                .setRequired(true)
                .addChoices(...BANNER_EVENT_CHOICES)))
        .addSubcommand(subcommand => subcommand
            .setName('clear-banner')
            .setDescription('Hapus banner default/fallback; banner khusus event tetap berlaku.'))
        .addSubcommand(subcommand => subcommand
            .setName('set-sticker')
            .setDescription('Tambahkan sticker server ke pesan log jenis tertentu (opsional).')
            .addStringOption(option => option
                .setName('type')
                .setDescription('Jenis log yang akan memakai sticker.')
                .setRequired(true)
                .addChoices(...TYPE_CHOICES))
            .addStringOption(option => option
                .setName('sticker_id')
                .setDescription('ID sticker yang tersedia untuk server ini.')
                .setRequired(true)
                .setMinLength(17)
                .setMaxLength(20)))
        .addSubcommand(subcommand => subcommand
            .setName('clear-sticker')
            .setDescription('Nonaktifkan sticker untuk satu jenis log.')
            .addStringOption(option => option
                .setName('type')
                .setDescription('Jenis log yang sticker-nya akan dilepas.')
                .setRequired(true)
                .addChoices(...TYPE_CHOICES)))
        .addSubcommand(subcommand => subcommand
            .setName('status')
            .setDescription('Lihat seluruh channel tujuan Employee Logs dan status banner.')),

    async execute(interaction) {
        try {
            requireManageGuild(interaction);
            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guildId;

            if (subcommand === 'panel') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const channel = interaction.options.getChannel('channel', true);
                await assertCanSend(channel, interaction.guild);
                const message = await channel.send(buildEmployeeLogsPanel());
                return interaction.editReply({
                    content: `✅ Panel Employee Logs berhasil dikirim ke ${channel}.\nMessage ID: \`${message.id}\``,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'set-channel') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                const channel = interaction.options.getChannel('channel', true);
                await assertCanSend(channel, interaction.guild);
                await setEmployeeLogsChannel(interaction.client, guildId, type, channel.id, interaction.user.id);
                const typeLabel = EMPLOYEE_LOG_TYPES[type]?.shortLabel || type;
                return interaction.editReply({
                    content: `✅ Channel **${typeLabel}** diatur ke ${channel}.`,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'clear-channel') {
                const type = interaction.options.getString('type', true);
                await clearEmployeeLogsChannel(interaction.client, guildId, type, interaction.user.id);
                return interaction.reply({
                    content: `✅ Konfigurasi channel **${EMPLOYEE_LOG_TYPES[type].shortLabel}** dihapus.`,
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'set-banner') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const url = interaction.options.getString('url', true);
                await setEmployeeLogsBanner(interaction.client, guildId, url, interaction.user.id);
                return interaction.editReply({
                    content: '✅ Banner default berhasil disimpan. Banner khusus per event akan tetap mengutamakan konfigurasi masing-masing.',
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'set-event-banner') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const eventKey = interaction.options.getString('event', true);
                const url = interaction.options.getString('url', true);
                await setEmployeeLogsEventBanner(interaction.client, guildId, eventKey, url, interaction.user.id);
                return interaction.editReply({
                    content: `✅ Banner khusus **${EMPLOYEE_LOG_BANNER_EVENTS[eventKey].label}** berhasil disimpan. Banner ini akan dipakai hanya untuk event tersebut.`,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'clear-event-banner') {
                const eventKey = interaction.options.getString('event', true);
                await clearEmployeeLogsEventBanner(interaction.client, guildId, eventKey, interaction.user.id);
                return interaction.reply({
                    content: `✅ Banner khusus **${EMPLOYEE_LOG_BANNER_EVENTS[eventKey].label}** dihapus. Event tersebut akan memakai banner default jika tersedia.`,
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'clear-banner') {
                await clearEmployeeLogsBanner(interaction.client, guildId, interaction.user.id);
                return interaction.reply({
                    content: '✅ Banner default/fallback dihapus. Banner khusus per event tetap berlaku.',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'set-sticker') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const type = interaction.options.getString('type', true);
                const stickerId = interaction.options.getString('sticker_id', true).trim();
                await setEmployeeLogsSticker(interaction.client, guildId, type, stickerId, interaction.user.id);
                return interaction.editReply({
                    content: `✅ Sticker \`${stickerId}\` disimpan untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}**. Jika sticker tidak dapat digunakan, embed log tetap akan terkirim tanpa sticker.`,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'clear-sticker') {
                const type = interaction.options.getString('type', true);
                await clearEmployeeLogsSticker(interaction.client, guildId, type, interaction.user.id);
                return interaction.reply({
                    content: `✅ Sticker untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}** dinonaktifkan.`,
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            if (subcommand === 'status') {
                const config = await getEmployeeLogsConfig(interaction.client, guildId);
                return interaction.reply({
                    embeds: [configEmbed(interaction.guild, config)],
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
            }

            throw new Error(`Subcommand tidak dikenal: ${subcommand}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const payload = { content: `❌ Employee Logs: ${message}`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
            if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
            return interaction.reply(payload).catch(() => null);
        }
    },
};
