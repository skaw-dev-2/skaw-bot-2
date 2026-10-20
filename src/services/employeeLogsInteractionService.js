import { randomUUID } from 'node:crypto';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    RoleSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    buildEmployeeLogEmbed,
    getEmployeeLogsConfig,
    resolveEmployeeLogsBanner,
    sendEmployeeLog,
    createEmployeeLogRecordId,
} from './employeeLogsService.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();
const deferredUpdateInteractions = new WeakSet();

async function acknowledgeComponentUpdate(interaction) {
    await interaction.deferUpdate();
    deferredUpdateInteractions.add(interaction);
}

function hasManageGuild(interaction) {
    return Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
        || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}
function canCreate(interaction) {
    return Boolean(interaction.inGuild?.() && hasManageGuild(interaction));
}
function sessionKey(guildId, userId) { return `${guildId}:${userId}`; }
function createSession(interaction, type) {
    const id = randomUUID().replaceAll('-', '').slice(0, 14);
    const session = { id, guildId: interaction.guildId, userId: interaction.user.id, type, stepIndex: 0, data: {}, updatedAt: Date.now() };
    sessions.set(sessionKey(session.guildId, session.userId), session);
    if (sessions.size > 1500) {
        for (const [key, item] of sessions) if (Date.now() - item.updatedAt > SESSION_TTL_MS) sessions.delete(key);
    }
    return session;
}
function getSession(interaction, id) {
    const key = sessionKey(interaction.guildId, interaction.user.id);
    const session = sessions.get(key);
    if (!session || session.id !== id || Date.now() - session.updatedAt > SESSION_TTL_MS) {
        if (session) sessions.delete(key);
        return null;
    }
    session.updatedAt = Date.now();
    return session;
}
function roleFieldLabel(field) {
    return ({ position: 'Position / jabatan', previousRank: 'Previous Rank', nextRank: 'New Rank', fromRole: 'Previous Position', toRole: 'New Position' })[field] || 'Position';
}
function userSelectRow(session) {
    return new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
        .setCustomId(`skaw_el_user:${session.id}`)
        .setPlaceholder('Select employee / pilih anggota')
        .setMinValues(1).setMaxValues(1));
}
function roleSelectRow(session) {
    const field = EMPLOYEE_LOG_TYPES[session.type].roleFields[session.stepIndex];
    return new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
        .setCustomId(`skaw_el_role:${session.id}`)
        .setPlaceholder(`Select ${roleFieldLabel(field)}`.slice(0, 150))
        .setMinValues(1).setMaxValues(1));
}
function backToPanelRow(sessionId) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`skaw_el_back:${sessionId}`)
        .setLabel('Cancel / Back to Activities')
        .setEmoji('↩️')
        .setStyle(ButtonStyle.Secondary));
}
function textInput(id, label, placeholder, required, style = TextInputStyle.Short, maxLength = 900, value = null) {
    const input = new TextInputBuilder()
        .setCustomId(id).setLabel(label.slice(0, 45)).setPlaceholder(placeholder.slice(0, 100))
        .setStyle(style).setRequired(required).setMaxLength(maxLength);
    if (typeof value === 'string' && value.length) input.setValue(value.slice(0, maxLength));
    return new ActionRowBuilder().addComponents(input);
}
function buildModal(session) {
    const template = EMPLOYEE_LOG_TYPES[session.type];
    const modal = new ModalBuilder().setCustomId(`skaw_el_form:${session.id}`).setTitle(`${template.shortLabel} • Record Details`.slice(0, 45));
    if (session.type === 'dismissal' || session.type === 'blacklist' || session.type === 'resignation') {
        const reasonLabel = session.type === 'resignation' ? 'Resignation Reason (required)' : 'Reason (required)';
        modal.addComponents(
            textInput('reason', reasonLabel, 'Explain the reason for this record.', true, TextInputStyle.Paragraph, 850, session.data.reason),
            textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 850, session.data.notes),
        );
    } else if (session.type === 'warning') {
        modal.addComponents(
            textInput('warn', 'Warning Level (e.g. 1/2)', '1/2', true, TextInputStyle.Short, 10, session.data.warn || '1/2'),
            textInput('reason', 'Reason / Observation', 'Explain the warning clearly.', true, TextInputStyle.Paragraph, 750, session.data.reason),
            textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 600, session.data.notes),
        );
    } else if (session.type === 'others') {
        modal.addComponents(
            textInput('activityTitle', 'Activity Title', 'Name this new log type.', true, TextInputStyle.Short, 80, session.data.activityTitle),
            textInput('activityDescription', 'Activity Details', 'Describe the activity.', true, TextInputStyle.Paragraph, 700, session.data.activityDescription),
            textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 600, session.data.notes),
        );
    } else {
        modal.addComponents(textInput('notes', 'Additional Notes (optional)', 'Optional supporting details.', false, TextInputStyle.Paragraph, 900, session.data.notes));
    }
    return modal;
}
function previewButtons(sessionId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`skaw_el_edit:${sessionId}`).setLabel('Edit Details').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`skaw_el_confirm:${sessionId}`).setLabel('Confirm & Send').setEmoji('✅').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`skaw_el_cancel:${sessionId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    );
}
async function sendPrivate(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}
async function validateSessionConfig(interaction, type, config) {
    const channelId = config.channels[type];
    if (!channelId) throw new Error(`Channel for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is not configured. Ask an administrator to run /employee-logs set-channel.`);
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== interaction.guildId) {
        throw new Error(`The configured destination for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is unavailable. Set its channel again with /employee-logs set-channel.`);
    }
    const botMember = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
    const channelPermissions = channel.permissionsFor(botMember || interaction.client.user);
    const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;
    if (!channelPermissions?.has(required)) {
        throw new Error(`The bot needs View Channel, Send Messages, and Embed Links in ${channel}.`);
    }
}
async function showPreview(interaction, session) {
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    await validateSessionConfig(interaction, session.type, config);
    session.data.recordedBy = interaction.user.id;
    if (!session.data.recordId) session.data.recordId = createEmployeeLogRecordId(new Date());
    if (!session.data.recordedAt) session.data.recordedAt = new Date().toISOString();
    const embed = buildEmployeeLogEmbed(session.type, session.data, resolveEmployeeLogsBanner(config, session.type));
    return interaction.editReply({
        content: `**PRIVATE PREVIEW · ${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nDestination: <#${config.channels[session.type]}>\nReview carefully before publishing.`,
        embeds: [embed],
        components: [previewButtons(session.id)],
        allowedMentions: { parse: [] },
    });
}
async function handleStart(interaction) {
    if (!interaction.inGuild?.()) return sendPrivate(interaction, 'Employee Logs can only be used in a server.');
    // Replace the current private panel instead of creating a trail of ephemeral messages.
    await acknowledgeComponentUpdate(interaction);
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    if (!canCreate(interaction)) return interaction.editReply({ content: '❌ You need the **Manage Server** permission to use Employee Logs.', embeds: [], components: [], allowedMentions: { parse: [] } });
    const type = interaction.customId.slice('skaw_el_start:'.length);
    if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) return interaction.editReply({ content: '❌ Unknown activity type.', embeds: [], components: [], allowedMentions: { parse: [] } });
    await validateSessionConfig(interaction, type, config);
    const session = createSession(interaction, type);
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[type].emoji} ${EMPLOYEE_LOG_TYPES[type].shortLabel}**\nStep 1: select the employee. This private session expires in 15 minutes.`,
        embeds: [], components: [userSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
    });
}

async function handleUserSelect(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_user:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/employee-logs panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    const memberId = interaction.values[0];
    const member = await interaction.guild.members.fetch(memberId).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ Employee could not be found in this server.', embeds: [], components: [], allowedMentions: { parse: [] } });
    session.data.userId = member.id;
    session.stepIndex = 0;
    const roleFields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: <@${member.id}>\nStep 2 of ${roleFields.length + 2}: select **${roleFieldLabel(roleFields[0])}**.`,
        embeds: [], components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
    });
}

async function handleRoleSelect(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_role:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/employee-logs panel` and start again.');
    const fields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    const field = fields[session.stepIndex];
    const roleId = interaction.values[0];
    if (!roleId || roleId === interaction.guildId) return sendPrivate(interaction, '❌ Choose a valid position role.');
    session.data[field] = roleId;
    session.stepIndex += 1;
    if (session.stepIndex < fields.length) {
        const nextField = fields[session.stepIndex];
        return interaction.update({
            content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: <@${session.data.userId}>\nSelected: ${session.stepIndex}/${fields.length} roles\nNext: choose **${roleFieldLabel(nextField)}**.`,
            components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
        });
    }
    return interaction.showModal(buildModal(session));
}

async function handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sessionId = interaction.customId.slice('skaw_el_form:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/employee-logs panel` and start again.', allowedMentions: { parse: [] } });
    const get = id => interaction.fields.getTextInputValue(id).trim();
    if (session.type === 'dismissal' || session.type === 'blacklist' || session.type === 'resignation') session.data.reason = get('reason');
    if (session.type === 'warning') { session.data.warn = get('warn'); session.data.reason = get('reason'); }
    if (session.type === 'others') { session.data.activityTitle = get('activityTitle'); session.data.activityDescription = get('activityDescription'); }
    session.data.notes = get('notes');
    session.data.recordedBy = interaction.user.id;
    return showPreview(interaction, session);
}

async function handleEdit(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_edit:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/employee-logs panel` and start again.');
    return interaction.showModal(buildModal(session));
}

async function handleConfirm(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_confirm:'.length);
    const session = getSession(interaction, sessionId);
    if (session?.status === 'submitting') {
        await acknowledgeComponentUpdate(interaction);
        return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
    }
    if (session) session.status = 'submitting';
    await acknowledgeComponentUpdate(interaction);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/employee-logs panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    try {
        const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
        await validateSessionConfig(interaction, session.type, config);
        session.data.recordedBy = interaction.user.id;
        const result = await sendEmployeeLog(interaction.client, interaction.guild, session.type, session.data);
        sessions.delete(sessionKey(session.guildId, session.userId));
        const stickerNote = result.stickerWarning ? `\n⚠️ ${result.stickerWarning}` : (result.stickerSent ? '\n✨ Sticker successfully sent.' : '');
        return interaction.editReply({ content: `✅ **${result.template.shortLabel} published successfully** to ${result.channel}.\nRecord ID: \`${result.recordId}\`${stickerNote}`, embeds: [], components: [], allowedMentions: { parse: [] } });
    } catch (error) {
        session.status = 'ready';
        throw error;
    }
}

async function handleBackToPanel(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_back:'.length);
    const session = getSession(interaction, sessionId);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    return interaction.editReply({ content: 'Session cancelled. Choose another activity or close this private panel.', ...buildEmployeeLogsPanel(config), allowedMentions: { parse: [] } });
}

async function handleCancel(interaction) {
    await acknowledgeComponentUpdate(interaction);
    const sessionId = interaction.customId.slice('skaw_el_cancel:'.length);
    const session = getSession(interaction, sessionId);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    return interaction.editReply({ content: '🗑️ Record cancelled. Nothing was published.', embeds: [], components: [], allowedMentions: { parse: [] } });
}

async function handleInteraction(interaction) {
    if (!interaction.inGuild?.()) return;
    const isEmployeeLogsComponent = Boolean(interaction.customId?.startsWith('skaw_el_')) && (
        interaction.isButton?.() || interaction.isUserSelectMenu?.() || interaction.isRoleSelectMenu?.()
        || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()
    );
    if (!isEmployeeLogsComponent) return;
    if (!hasManageGuild(interaction)) {
        return sendPrivate(interaction, '🔒 You need the **Manage Server** permission to use Employee Logs.');
    }
    if (interaction.isButton?.()) {
        if (interaction.customId.startsWith('skaw_el_start:')) return handleStart(interaction);
        if (interaction.customId.startsWith('skaw_el_back:')) return handleBackToPanel(interaction);
        if (interaction.customId.startsWith('skaw_el_edit:')) return handleEdit(interaction);
        if (interaction.customId.startsWith('skaw_el_confirm:')) return handleConfirm(interaction);
        if (interaction.customId.startsWith('skaw_el_cancel:')) return handleCancel(interaction);
    }
    if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('skaw_el_user:')) return handleUserSelect(interaction);
    if (interaction.isRoleSelectMenu?.() && interaction.customId.startsWith('skaw_el_role:')) return handleRoleSelect(interaction);
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith('skaw_el_form:')) return handleModal(interaction);
}

export function buildEmployeeLogsPanel(config = null) {
    const missingChannels = config ? Object.entries(EMPLOYEE_LOG_TYPES).filter(([type]) => !config.channels?.[type]).map(([, entry]) => `${entry.emoji} ${entry.shortLabel}`) : [];
    const setupSummary = !config
        ? 'Use /employee-logs status to inspect setup.'
        : missingChannels.length
            ? `⚙️ **Setup needed:** destination channel not configured for ${missingChannels.join(', ')}. Use /employee-logs set-channel for each activity.`
            : '✅ **Setup complete:** all activity destination channels are configured.';
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: '🏢 SKAW GROUP • PEOPLE OPERATIONS' })
        .setTitle('📑 EMPLOYEE RECORDS CONSOLE')
        .setDescription([
            '**CENTRAL PERSONNEL LOGGING SYSTEM**',
            'Choose an activity below. Forms and previews are visible only to you.',
            '',
            '🟢 Sign In • 🔵 Sign Out • 🏆 Promotion',
            '⛔ Dismissal • 📄 Resignation • 🔄 Mutation',
            '⚠️ Warning • 🛡️ Blacklist • 📝 Others',
            '',
            'All activity forms and previews are private. Final records are published to the configured destination channel.',
            '',
            setupSummary,
        ].join('\n'))
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
    const types = Object.entries(EMPLOYEE_LOG_TYPES);
    const rows = [];
    for (let start = 0; start < types.length; start += 3) {
        const row = new ActionRowBuilder();
        for (const [type, entry] of types.slice(start, start + 3)) {
            const style = type === 'sign_in' ? ButtonStyle.Success
                : type === 'dismissal' || type === 'blacklist' ? ButtonStyle.Danger
                : type === 'promotion' ? ButtonStyle.Primary : ButtonStyle.Secondary;
            row.addComponents(new ButtonBuilder()
                .setCustomId(`skaw_el_start:${type}`)
                .setLabel(entry.shortLabel)
                .setEmoji(entry.emoji)
                .setStyle(style));
        }
        rows.push(row);
    }
    return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

export async function handleEmployeeLogsComponent(interaction) {
    try {
        await handleInteraction(interaction);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[Employee Logs]', error);
        if (!interaction.isRepliable?.()) return;
        try {
            if (interaction.deferred && !interaction.replied && !deferredUpdateInteractions.has(interaction)) {
                await interaction.editReply({ content: `❌ Employee Logs: ${message}`, embeds: [], components: [], allowedMentions: { parse: [] } });
            } else {
                await sendPrivate(interaction, `❌ Employee Logs: ${message}`);
            }
        } catch { /* Interaction already expired/acknowledged */ }
    }
}
