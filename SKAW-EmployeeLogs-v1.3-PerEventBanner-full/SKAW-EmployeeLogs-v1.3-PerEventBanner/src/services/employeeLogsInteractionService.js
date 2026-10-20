import {
    ActionRowBuilder,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    RoleSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import { EMPLOYEE_LOG_TYPES, getEmployeeLogsConfig, sendEmployeeLog } from './employeeLogsService.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();
const attachedClients = new WeakSet();

function isManager(interaction) {
    return Boolean(interaction.inGuild?.() && interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
}

function sessionKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function removeExpiredSessions() {
    const now = Date.now();
    for (const [key, session] of sessions) {
        if (now - session.updatedAt > SESSION_TTL_MS) sessions.delete(key);
    }
    if (sessions.size > 5000) {
        const ordered = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        for (const [key] of ordered.slice(0, sessions.size - 4000)) sessions.delete(key);
    }
}

function createSession(interaction, type) {
    removeExpiredSessions();
    const session = {
        id: Math.random().toString(36).slice(2, 10),
        guildId: interaction.guildId,
        userId: interaction.user.id,
        type,
        stepIndex: 0,
        data: {},
        updatedAt: Date.now(),
    };
    sessions.set(sessionKey(session.guildId, session.userId), session);
    return session;
}

function getSession(interaction, sessionId) {
    const session = sessions.get(sessionKey(interaction.guildId, interaction.user.id));
    if (!session || session.id !== sessionId || Date.now() - session.updatedAt > SESSION_TTL_MS) {
        if (session) sessions.delete(sessionKey(interaction.guildId, interaction.user.id));
        return null;
    }
    session.updatedAt = Date.now();
    return session;
}

function roleStepLabel(type, field) {
    if (field === 'position') return 'Position / jabatan anggota';
    if (field === 'previousRank') return 'Previous Rank';
    if (field === 'nextRank') return 'New Rank';
    if (field === 'fromRole') return 'Role asal mutation';
    if (field === 'toRole') return 'Role tujuan mutation';
    return `Role untuk ${EMPLOYEE_LOG_TYPES[type]?.shortLabel || 'log'}`;
}

function userSelectRow(session) {
    const menu = new UserSelectMenuBuilder()
        .setCustomId(`skaw_el_user:${session.id}`)
        .setPlaceholder('Pilih anggota yang akan dicatat')
        .setMinValues(1)
        .setMaxValues(1);
    return new ActionRowBuilder().addComponents(menu);
}

function roleSelectRow(session) {
    const field = EMPLOYEE_LOG_TYPES[session.type].roleFields[session.stepIndex];
    const menu = new RoleSelectMenuBuilder()
        .setCustomId(`skaw_el_role:${session.id}`)
        .setPlaceholder(roleStepLabel(session.type, field))
        .setMinValues(1)
        .setMaxValues(1);
    return new ActionRowBuilder().addComponents(menu);
}

function modalTextInput(customId, label, placeholder, required, style = TextInputStyle.Short, maxLength = 1000, value = null) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style)
        .setRequired(required)
        .setMaxLength(maxLength)
        .setPlaceholder(placeholder);
    if (value !== null) input.setValue(value.slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
}

function buildModal(session) {
    const template = EMPLOYEE_LOG_TYPES[session.type];
    const modal = new ModalBuilder()
        .setCustomId(`skaw_el_form:${session.id}`)
        .setTitle(template.shortLabel.slice(0, 45));

    if (session.type === 'employee') {
        modal.addComponents(modalTextInput('logs', 'Logs / aktivitas', 'Sign In, Sign Out, Personal Resignation, etc.', true, TextInputStyle.Short, 800, 'Sign In'));
    } else if (session.type === 'mutation') {
        modal.addComponents(modalTextInput('logs', 'Mutation logs (opsional)', 'Request by member on Mutation request.', false, TextInputStyle.Paragraph, 800, `Request by <@${session.data.userId}> on Mutation request.`));
    } else if (session.type === 'blacklist' || session.type === 'dismissal') {
        modal.addComponents(modalTextInput('reason', 'Reason / alasan', 'Tulis alasan dengan jelas.', true, TextInputStyle.Paragraph, 900));
    } else if (session.type === 'warning') {
        modal.addComponents(
            modalTextInput('warn', 'Warn count (contoh 1/2)', '1/2', true, TextInputStyle.Short, 10, '1/2'),
            modalTextInput('reason', 'Reason / alasan', 'Tulis alasan warning dengan jelas.', true, TextInputStyle.Paragraph, 850),
        );
    }

    return modal;
}

async function sendEphemeral(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

async function publishPromotion(interaction, session) {
    try {
        session.data.recordedBy = interaction.user.id;
        const result = await sendEmployeeLog(interaction.client, interaction.guild, session.type, session.data);
        sessions.delete(sessionKey(session.guildId, session.userId));
        const stickerNote = result.stickerWarning ? `\n⚠️ ${result.stickerWarning}` : (result.stickerSent ? '\n✨ Sticker berhasil ditambahkan.' : '');
        await interaction.update({ content: `✅ **${result.template.shortLabel} berhasil dikirim** ke ${result.channel}.${stickerNote}`, components: [] });
    } catch (error) {
        await interaction.update({ content: `❌ ${error.message}`, components: [] });
    }
}

async function handleInteraction(interaction) {
    if (!interaction.inGuild?.()) return;
    if (interaction.isStringSelectMenu() && interaction.customId === 'skaw_el_type') {
        if (!isManager(interaction)) return sendEphemeral(interaction, '❌ Kamu membutuhkan permission **Manage Server** untuk membuat employee logs.');
        const type = interaction.values[0];
        if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) return sendEphemeral(interaction, '❌ Jenis log tidak dikenal.');
        const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
        if (!config.channels[type]) {
            return sendEphemeral(interaction, `⚙️ Channel untuk **${EMPLOYEE_LOG_TYPES[type].shortLabel}** belum diatur. Admin perlu menjalankan /employee-logs set-channel terlebih dahulu.`);
        }

        const session = createSession(interaction, type);
        return interaction.reply({
            content: `**${EMPLOYEE_LOG_TYPES[type].shortLabel}**\nLangkah 1/3: pilih anggota yang akan dicatat. Form kedaluwarsa dalam 15 menit.`,
            components: [userSelectRow(session)],
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    }

    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('skaw_el_user:')) {
        if (!isManager(interaction)) return sendEphemeral(interaction, '❌ Kamu membutuhkan permission **Manage Server**.');
        const [, sessionId] = interaction.customId.split(':');
        const session = getSession(interaction, sessionId);
        if (!session) return sendEphemeral(interaction, '⌛ Form kedaluwarsa. Pilih jenis log dari panel lagi.');

        const memberId = interaction.values[0];
        const member = await interaction.guild.members.fetch(memberId).catch(() => null);
        if (!member) return sendEphemeral(interaction, '❌ Anggota tidak ditemukan di server ini.');
        session.data.userId = member.id;
        session.stepIndex = 0;
        session.updatedAt = Date.now();
        const field = EMPLOYEE_LOG_TYPES[session.type].roleFields[0];
        return interaction.update({
            content: `Anggota: <@${member.id}>\nLangkah 2/${EMPLOYEE_LOG_TYPES[session.type].roleFields.length + 2}: pilih **${roleStepLabel(session.type, field)}**.`,
            components: [roleSelectRow(session)],
            allowedMentions: { parse: [] },
        });
    }

    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('skaw_el_role:')) {
        if (!isManager(interaction)) return sendEphemeral(interaction, '❌ Kamu membutuhkan permission **Manage Server**.');
        const [, sessionId] = interaction.customId.split(':');
        const session = getSession(interaction, sessionId);
        if (!session) return sendEphemeral(interaction, '⌛ Form kedaluwarsa. Pilih jenis log dari panel lagi.');

        const field = EMPLOYEE_LOG_TYPES[session.type].roleFields[session.stepIndex];
        const roleId = interaction.values[0];
        if (!roleId || roleId === interaction.guildId) return sendEphemeral(interaction, '❌ Pilih role jabatan yang valid.');
        session.data[field] = roleId;
        session.stepIndex += 1;
        session.updatedAt = Date.now();

        const roleFields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
        if (session.stepIndex < roleFields.length) {
            const nextField = roleFields[session.stepIndex];
            return interaction.update({
                content: `Anggota: <@${session.data.userId}>\nRole dipilih: ${session.stepIndex}/${roleFields.length}\nLangkah berikutnya: pilih **${roleStepLabel(session.type, nextField)}**.`,
                components: [roleSelectRow(session)],
                allowedMentions: { parse: [] },
            });
        }

        if (session.type === 'promotion') return publishPromotion(interaction, session);
        return interaction.showModal(buildModal(session));
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('skaw_el_form:')) {
        if (!isManager(interaction)) return sendEphemeral(interaction, '❌ Kamu membutuhkan permission **Manage Server**.');
        const [, sessionId] = interaction.customId.split(':');
        const session = getSession(interaction, sessionId);
        if (!session) return sendEphemeral(interaction, '⌛ Form kedaluwarsa. Pilih jenis log dari panel lagi.');

        if (session.type === 'employee') session.data.logs = interaction.fields.getTextInputValue('logs');
        if (session.type === 'mutation') session.data.logs = interaction.fields.getTextInputValue('logs');
        if (session.type === 'blacklist' || session.type === 'dismissal') session.data.reason = interaction.fields.getTextInputValue('reason');
        if (session.type === 'warning') {
            session.data.warn = interaction.fields.getTextInputValue('warn');
            session.data.reason = interaction.fields.getTextInputValue('reason');
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            session.data.recordedBy = interaction.user.id;
            const result = await sendEmployeeLog(interaction.client, interaction.guild, session.type, session.data);
            sessions.delete(sessionKey(session.guildId, session.userId));
            const stickerNote = result.stickerWarning ? `\n⚠️ ${result.stickerWarning}` : (result.stickerSent ? '\n✨ Sticker berhasil ditambahkan.' : '');
            return interaction.editReply({ content: `✅ **${result.template.shortLabel} berhasil dikirim** ke ${result.channel}.${stickerNote}`, allowedMentions: { parse: [] } });
        } catch (error) {
            return interaction.editReply({ content: `❌ ${error.message}`, allowedMentions: { parse: [] } });
        }
    }
}

export function buildEmployeeLogsPanel() {
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: '🏢 SKAW GROUP • PEOPLE OPERATIONS' })
        .setTitle('📑  EMPLOYEE RECORDS CONSOLE')
        .setDescription([
            '**CENTRAL PERSONNEL LOGGING SYSTEM**',
            'Create consistent employee records and official notices using the workflow below.',
            '',
            '📋 **Employee Activity** — sign-in, sign-out, resignation, and other activity.',
            '🏆 **Promotion** — previous rank and new rank.',
            '🔄 **Mutation** — position transfer and supporting note.',
            '🛡️ **Blacklist / Dismissal** — compliance and employment notices.',
            '⚠️ **Warning** — warning level and observation details.',
            '',
            '🔐 Access is restricted to members with **Manage Server** permission.',
        ].join('\n'))
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());

    const menu = new StringSelectMenuBuilder()
        .setCustomId('skaw_el_type')
        .setPlaceholder('Pilih jenis Employee Log...')
        .addOptions(...Object.entries(EMPLOYEE_LOG_TYPES).map(([value, entry]) => ({
            label: entry.shortLabel,
            value,
            description: entry.label.slice(0, 100),
            emoji: { name: entry.emoji },
        })));

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(menu)],
        allowedMentions: { parse: [] },
    };
}

export function startEmployeeLogsInteractionHandler(client) {
    if (!client || attachedClients.has(client)) return;
    attachedClients.add(client);
    client.on('interactionCreate', async (interaction) => {
        try {
            await handleInteraction(interaction);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            if (interaction.isRepliable?.()) {
                try { await sendEphemeral(interaction, `❌ Employee Logs error: ${text}`); } catch { /* interaction expired/already acknowledged */ }
            }
            console.error('[Employee Logs] interaction error:', error);
        }
    });
}
