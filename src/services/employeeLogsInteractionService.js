import { randomUUID } from 'node:crypto';
import {
    ActionRowBuilder,
    escapeMarkdown,
    ChannelType,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    PermissionFlagsBits,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
    UserSelectMenuBuilder,
} from 'discord.js';
import {
    EMPLOYEE_LOG_TYPES,
    EMPLOYEE_LOG_BANNER_EVENTS,
    buildEmployeeLogEmbed,
    getEmployeeLogsConfig,
    resolveEmployeeLogsBanner,
    sendEmployeeLog,
    createEmployeeLogRecordId,
    getEmployeeLogRecord,
    updateEmployeeLogRecord,
    setEmployeeLogsChannel,
    setEmployeeLogsBanner,
    clearEmployeeLogsBanner,
    setEmployeeLogsEventBanner,
    clearEmployeeLogsEventBanner,
    getEmployeeAutoRoleConfig,
    setEmployeeAutoRoleEnabled,
    getEmployeeLogAudit,
} from './employeeLogsService.js';
import {
    BASE_EMPLOYEE_ROLE,
    getEmployeeRoleRegistry,
    registerEmployeeRole,
    disableEmployeeRole,
} from './employeeRoleRegistryService.js';
import { SKAW_EMPLOYEE_ROLE_CATALOG } from './employeeLogsAutoRoleService.js';
import { formatDirectoryTimestamp, searchEmployeeDirectory, getEmployeeDirectoryIndex, syncEmployeeDirectoryMembership } from './employeeDirectoryService.js';

const SESSION_TTL_MS = 15 * 60 * 1000;
const sessions = new Map();
async function acknowledgeComponentUpdate(interaction) {
    await interaction.deferUpdate();
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
    return ({ division: 'Division / divisi', position: 'Position / jabatan', previousRank: 'Previous Rank', newRank: 'New Rank', fromRole: 'Previous Position', toRole: 'New Position' })[field] || 'Position';
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
    if (session.type === 'dismissal' || session.type === 'blacklist' || session.type === 'resignation' || session.type === 'demote') {
        const reasonLabel = session.type === 'resignation' ? 'Resignation Reason (required)' : session.type === 'demote' ? 'Demotion Reason (required)' : session.type === 'dismissal' ? 'Dismissal Reason (required)' : 'Blacklist Reason (required)';
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

function buildPublishedRecordEditModal(record) {
    const isSignOut = record.type === 'sign_out';
    return new ModalBuilder()
        .setCustomId(`skaw_el_edit_record_modal:${record.recordId}`)
        .setTitle('Edit Employee Log')
        .addComponents(
            textInput('editReason', isSignOut ? 'Reason Details (optional)' : 'Reason (optional)', isSignOut ? 'Add details about the selected exit reason.' : 'Add or update the reason.', false, TextInputStyle.Paragraph, 900, record.data?.reason || ''),
            textInput('editNotes', 'Additional Notes (optional)', 'Add or update additional notes.', false, TextInputStyle.Paragraph, 900, record.data?.notes || ''),
        );
}

const EXIT_REASON_CATEGORIES = [
    { label: 'Dismissal', value: 'dismissal', description: 'Employment ended by SKAW Management.' },
    { label: 'Personal Resignation', value: 'personal_resignation', description: 'Employee chose to resign.' },
    { label: 'Blacklist', value: 'blacklist', description: 'Exit associated with a blacklist record.' },
    { label: 'Others', value: 'others', description: 'Another reason not listed above.' },
    { label: 'Belum ditentukan', value: 'unset', description: 'Clear the category and choose it later.' },
];

function buildSignOutEditControls(record) {
    const current = String(record.data?.reasonCategory || 'unset');
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`skaw_el_reason_category:${record.recordId}`)
        .setPlaceholder('Pilih kategori Reason')
        .setMinValues(1).setMaxValues(1)
        .addOptions(EXIT_REASON_CATEGORIES.map(item => ({ ...item, default: item.value === current })));
    return [
        new ActionRowBuilder().addComponents(menu),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`skaw_el_edit_record_details:${record.recordId}`).setLabel('Edit Reason Details / Notes').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        ),
    ];
}

async function handlePublishedRecordEditButton(interaction) {
    const recordId = interaction.customId.slice('skaw_el_edit_record:'.length);
    const record = await getEmployeeLogRecord(interaction.client, interaction.guildId, recordId);
    if (!record) return sendPrivate(interaction, 'This record is no longer available to edit.');
    if (String(record.guildId) !== String(interaction.guildId)) return sendPrivate(interaction, 'This record is not available in this server.');
    if (String(interaction.message?.id || '') !== String(record.messageId)
        || String(interaction.message?.author?.id || '') !== String(interaction.client.user?.id || '')) {
        return sendPrivate(interaction, 'This Edit button is not linked to the original Employee Log message.');
    }
    if (record.type === 'sign_out') {
        return interaction.reply({
            content: 'Pilih kategori alasan Sign-Out. Untuk keterangan tambahan, buka **Edit Reason Details / Notes**.',
            components: buildSignOutEditControls(record),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    }
    return interaction.showModal(buildPublishedRecordEditModal(record));
}

async function handlePublishedRecordReasonCategory(interaction) {
    const recordId = interaction.customId.slice('skaw_el_reason_category:'.length);
    const record = await getEmployeeLogRecord(interaction.client, interaction.guildId, recordId);
    if (!record || record.type !== 'sign_out') return sendPrivate(interaction, 'This Sign-Out record is no longer available to edit.');
    const selected = interaction.values[0];
    const reasonCategory = selected === 'unset' ? '' : selected;
    const result = await updateEmployeeLogRecord(interaction.client, interaction.guildId, recordId, { reasonCategory }, interaction.user.id);
    return interaction.update({
        content: '✅ Reason category updated on the original Employee Sign-Out log. You can also edit details or notes below.',
        embeds: [],
        components: buildSignOutEditControls(result.record),
        allowedMentions: { parse: [] },
    });
}

async function handlePublishedRecordEditDetailsButton(interaction) {
    const recordId = interaction.customId.slice('skaw_el_edit_record_details:'.length);
    const record = await getEmployeeLogRecord(interaction.client, interaction.guildId, recordId);
    if (!record || record.type !== 'sign_out') return sendPrivate(interaction, 'This Sign-Out record is no longer available to edit.');
    return interaction.showModal(buildPublishedRecordEditModal(record));
}

async function handlePublishedRecordAuditButton(interaction) {
    const recordId = interaction.customId.slice('skaw_el_audit_record:'.length);
    const record = await getEmployeeLogRecord(interaction.client, interaction.guildId, recordId);
    if (!record) return sendPrivate(interaction, 'This record is no longer available.');
    if (String(record.guildId) !== String(interaction.guildId)) return sendPrivate(interaction, 'This record is not available in this server.');
    if (String(interaction.message?.id || '') !== String(record.messageId)
        || String(interaction.message?.author?.id || '') !== String(interaction.client.user?.id || '')) {
        return sendPrivate(interaction, 'This Audit Trail button is not linked to the original Employee Log message.');
    }

    const history = Array.isArray(record.editHistory) ? record.editHistory.slice(-10).reverse() : [];
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setTitle('EMPLOYEE RECORD AUDIT TRAIL')
        .setDescription([
            '**Record ID:** ' + record.recordId,
            '**Employee:** ' + (record.data?.displayName || 'Unknown member') + ' (<@' + record.data?.userId + '>)',
            '**Record type:** ' + (EMPLOYEE_LOG_TYPES[record.type]?.shortLabel || record.type),
            '**Created:** ' + formatDirectoryTimestamp(record.publishedAt),
            '**Total recorded edits:** ' + (Array.isArray(record.editHistory) ? record.editHistory.length : 0),
            '',
            history.length ? 'Latest changes are shown below.' : 'No recorded content edits have been made to this record.',
        ].join('\n'))
        .setFooter({ text: 'Audit entries are saved with the durable record and do not change its Record ID.' });
    for (const item of history) {
        const details = [];
        for (const [field, change] of Object.entries(item.changes || {})) {
            const label = field === 'reason' ? 'Reason Details' : field === 'reasonCategory' ? 'Reason Category' : field === 'notes' ? 'Additional Notes' : field === 'division' ? 'Division' : field === 'position' ? 'Position' : field;
            const before = escapeMarkdown(String(change?.before || '')).slice(0, 180) || '(empty)';
            const after = escapeMarkdown(String(change?.after || '')).slice(0, 180) || '(empty)';
            details.push('**' + label + ':** ' + before + ' → ' + after);
        }
        embed.addFields({
            name: formatDirectoryTimestamp(item.editedAt) + ' · ' + (item.editedBy ? 'Editor recorded' : 'Editor unavailable'),
            value: [
                item.editedBy ? 'Edited by <@' + item.editedBy + '>' : 'Editor: Not recorded',
                ...(details.length ? details : ['No field values changed.']),
            ].join('\n').slice(0, 1000),
            inline: false,
        });
    }
    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

async function handlePublishedRecordEditModal(interaction) {
    const recordId = interaction.customId.slice('skaw_el_edit_record_modal:'.length);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reason = interaction.fields.getTextInputValue('editReason').trim();
    const notes = interaction.fields.getTextInputValue('editNotes').trim();
    await updateEmployeeLogRecord(interaction.client, interaction.guildId, recordId, { reason, notes }, interaction.user.id);
    return interaction.editReply({ content: 'Employee log updated.', allowedMentions: { parse: [] } });
}
async function sendPrivate(interaction, content) {
    const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}
async function validateSessionConfig(interaction, type, config) {
    const channelId = config.channels[type];
    if (!channelId) throw new Error(`Channel for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is not configured. Ask an administrator to run /epl set-channel.`);
    const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || channel.guildId !== interaction.guildId) {
        throw new Error(`The configured destination for **${EMPLOYEE_LOG_TYPES[type].shortLabel}** is unavailable. Set its channel again with /epl set-channel.`);
    }
    const botMember = interaction.guild?.members?.me || await interaction.guild?.members?.fetchMe?.().catch(() => null);
    const channelPermissions = channel.permissionsFor(botMember || interaction.client.user);
    const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory;
    if (!channelPermissions?.has(required)) {
        throw new Error(`The bot needs View Channel, Send Messages, Embed Links, and Read Message History in ${channel}.`);
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
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/epl panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
    const memberId = interaction.values[0];
    const member = await interaction.guild.members.fetch(memberId).catch(() => null);
    if (!member) return interaction.editReply({ content: '❌ Employee could not be found in this server.', embeds: [], components: [], allowedMentions: { parse: [] } });
    session.data.userId = member.id;
    session.data.displayName = member.displayName;
    session.stepIndex = 0;
    const roleFields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    return interaction.editReply({
        content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: ${member.displayName} (<@${member.id}>)\nStep 2 of ${roleFields.length + 2}: select **${roleFieldLabel(roleFields[0])}**.`,
        embeds: [], components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
    });
}

async function handleRoleSelect(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_role:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/epl panel` and start again.');
    const fields = EMPLOYEE_LOG_TYPES[session.type].roleFields;
    const field = fields[session.stepIndex];
    const roleId = interaction.values[0];
    if (!roleId || roleId === interaction.guildId) return sendPrivate(interaction, '❌ Choose a valid position role.');
    session.data[field] = roleId;
    session.stepIndex += 1;
    if (session.stepIndex < fields.length) {
        const nextField = fields[session.stepIndex];
        return interaction.update({
            content: `**${EMPLOYEE_LOG_TYPES[session.type].shortLabel}**\nEmployee: ${session.data.displayName || 'Unknown member'} (<@${session.data.userId}>)\nSelected: ${session.stepIndex}/${fields.length} roles\nNext: choose **${roleFieldLabel(nextField)}**.`,
            components: [roleSelectRow(session), backToPanelRow(session.id)], allowedMentions: { parse: [] },
        });
    }
    return interaction.showModal(buildModal(session));
}

async function handleModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sessionId = interaction.customId.slice('skaw_el_form:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/epl panel` and start again.', allowedMentions: { parse: [] } });
    const get = id => interaction.fields.getTextInputValue(id).trim();
    if (session.type === 'dismissal' || session.type === 'blacklist' || session.type === 'resignation' || session.type === 'demote') session.data.reason = get('reason');
    if (session.type === 'warning') { session.data.warn = get('warn'); session.data.reason = get('reason'); }
    if (session.type === 'others') { session.data.activityTitle = get('activityTitle'); session.data.activityDescription = get('activityDescription'); }
    session.data.notes = get('notes');
    session.data.recordedBy = interaction.user.id;
    return showPreview(interaction, session);
}

async function handleEdit(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_edit:'.length);
    const session = getSession(interaction, sessionId);
    if (!session) return sendPrivate(interaction, '⌛ Form expired. Open `/epl panel` and start again.');
    if (session.status === 'submitting') return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
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
    if (!session) return interaction.editReply({ content: '⌛ Form expired. Open `/epl panel` and start again.', embeds: [], components: [], allowedMentions: { parse: [] } });
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
    const sessionId = interaction.customId.slice('skaw_el_back:'.length);
    const session = getSession(interaction, sessionId);
    if (session?.status === 'submitting') {
        await acknowledgeComponentUpdate(interaction);
        return sendPrivate(interaction, '⏳ This record is already being processed. Please wait.');
    }
    await acknowledgeComponentUpdate(interaction);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
    return interaction.editReply({ content: 'Session cancelled. Choose another activity or close this private panel.', ...buildEmployeeLogsActivitiesPanel(config), allowedMentions: { parse: [] } });
}

async function handleCancel(interaction) {
    const sessionId = interaction.customId.slice('skaw_el_cancel:'.length);
    const session = getSession(interaction, sessionId);
    if (session?.status === 'submitting') {
        await acknowledgeComponentUpdate(interaction);
        return sendPrivate(interaction, '⏳ This record is already being processed and cannot be cancelled now.');
    }
    await acknowledgeComponentUpdate(interaction);
    if (session) sessions.delete(sessionKey(session.guildId, session.userId));
    return interaction.editReply({ content: '🗑️ Record cancelled. Nothing was published.', embeds: [], components: [], allowedMentions: { parse: [] } });
}


const registrySessions = new Map();

function buildSettingsPanel(config, autoConfig) {
    const configuredCount = Object.keys(EMPLOYEE_LOG_TYPES).filter(type => config.channels?.[type]).length;
    const autoTypes = ['sign_in', 'sign_out', 'promotion', 'demote', 'mutation', 'warning', 'blacklist'];
    const missing = autoTypes.filter(type => !config.channels?.[type]).map(type => EMPLOYEE_LOG_TYPES[type].shortLabel);
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setTitle('EMPLOYEE LOGS · SYSTEM SETTINGS')
        .setDescription([
            'Channel routing: ' + configuredCount + '/' + Object.keys(EMPLOYEE_LOG_TYPES).length + ' activity channels configured.',
            'Automatic Employee Logs: ' + (autoConfig.enabled ? 'Enabled' : 'Disabled'),
            'Default banner: ' + (config.bannerUrl ? 'Configured' : 'Not configured'),
            '',
            missing.length ? 'Auto Logs still needs channels: ' + missing.join(', ') : 'Auto Logs channels: Ready',
            '',
            'Use the controls below to update routing, banners, and automation. Changes are saved per server.',
        ].join('\n'))
        .setFooter({ text: 'Settings changes are saved immediately' });
    const autoButton = new ButtonBuilder()
        .setCustomId('skaw_el_autorole:' + (autoConfig.enabled ? 'disable' : 'enable'))
        .setLabel(autoConfig.enabled ? 'Disable Auto Logs' : 'Enable Auto Logs')
        .setEmoji(autoConfig.enabled ? '⏸️' : '▶️')
        .setStyle(autoConfig.enabled ? ButtonStyle.Danger : ButtonStyle.Success);
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_settings:channels').setLabel('Channel Routing').setEmoji('📣').setStyle(ButtonStyle.Primary),
                autoButton,
                new ButtonBuilder().setCustomId('skaw_el_settings:banner').setLabel('Set Default Banner').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_settings:clear-banner').setLabel('Clear Banner').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_settings:event-banner').setLabel('Set Event Banner').setEmoji('🎨').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_settings:clear-event-banner').setLabel('Clear Event Banner').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setEmoji('↩️').setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildChannelTypePicker() {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('skaw_el_channel_type')
        .setPlaceholder('Choose which activity channel to configure')
        .setMinValues(1).setMaxValues(1)
        .addOptions(Object.entries(EMPLOYEE_LOG_TYPES).map(([type, entry]) => ({
            label: entry.shortLabel,
            description: 'Destination for ' + entry.label,
            value: type,
            emoji: entry.emoji,
        })));
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle('CHANNEL ROUTING').setDescription('Choose an activity type, then select a text or announcement channel.')],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Back to Settings').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildEventBannerPicker(clear = false) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId(clear ? 'skaw_el_clear_event_banner_pick' : 'skaw_el_event_banner_pick')
        .setPlaceholder(clear ? 'Choose which event banner to clear' : 'Choose which event banner to set')
        .setMinValues(1).setMaxValues(1)
        .addOptions(Object.entries(EMPLOYEE_LOG_BANNER_EVENTS).map(([key, entry]) => ({
            label: entry.label.slice(0, 100),
            description: clear ? 'Remove this custom event banner' : 'Set a custom banner for this event',
            value: key,
        })));
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle(clear ? 'CLEAR EVENT BANNER' : 'CONFIGURE EVENT BANNER').setDescription('Select the employee activity or event.')],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Back to Settings').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildRoleRegistryPanelPayload(registry) {
    const active = registry.roles.filter(role => role.active);
    const inactive = registry.roles.filter(role => !role.active);
    const lines = [
        '**Base Employee Role:** <@&' + BASE_EMPLOYEE_ROLE.id + '> (' + BASE_EMPLOYEE_ROLE.id + ')',
        '**Built-in mappings:** ' + Object.keys(SKAW_EMPLOYEE_ROLE_CATALOG).length,
        '**Custom mappings:** ' + active.length + ' active · ' + inactive.length + ' inactive',
        '',
    ];
    const shown = registry.roles.slice(0, 16);
    if (shown.length) {
        for (const role of shown) {
            let details = role.category.charAt(0).toUpperCase() + role.category.slice(1);
            if (role.department) details += ' · ' + role.department;
            if (role.level != null) details += ' · Level ' + role.level;
            if (role.warn) details += ' · ' + role.warn;
            lines.push((role.active ? '🟢' : '⚪') + ' <@&' + role.id + '> — ' + details + (role.active ? '' : ' (inactive)'));
        }
        if (registry.roles.length > shown.length) lines.push('…and ' + (registry.roles.length - shown.length) + ' more.');
    } else {
        lines.push('No custom role mappings registered yet. Built-in mappings remain available.');
    }
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle('EMPLOYEE ROLE REGISTRY').setDescription(lines.join('\n').slice(0, 3900))
            .setFooter({ text: 'Deactivate mappings instead of deleting them so existing records remain intact.' })],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_registry:add').setLabel('Register Role').setEmoji('➕').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('skaw_el_registry:edit').setLabel('Edit Mapping').setEmoji('✏️').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skaw_el_registry:disable').setLabel('Deactivate Role').setEmoji('⏸️').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

function buildRegistryMappingPicker(registry, mode) {
    const options = registry.roles
        .filter(role => mode !== 'disable' || role.active)
        .slice(0, 25)
        .map(role => ({
            label: role.name.slice(0, 100),
            description: (role.active ? 'Active' : 'Inactive') + ' · ' + role.category + (role.department ? ' · ' + role.department : ''),
            value: role.id,
        }));
    if (!options.length) {
        return {
            content: mode === 'disable' ? 'There are no active custom role mappings to deactivate.' : 'Register a custom role first.',
            embeds: [],
            components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Back to Role Registry').setStyle(ButtonStyle.Secondary))],
            allowedMentions: { parse: [] },
        };
    }
    const menu = new StringSelectMenuBuilder()
        .setCustomId(mode === 'disable' ? 'skaw_el_registry_disable_pick' : 'skaw_el_registry_edit_pick')
        .setPlaceholder(mode === 'disable' ? 'Choose a role to deactivate' : 'Choose a role mapping to edit')
        .setMinValues(1).setMaxValues(1).addOptions(options);
    return {
        embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle(mode === 'disable' ? 'DEACTIVATE ROLE MAPPING' : 'EDIT ROLE MAPPING').setDescription('Select a custom role mapping.')],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Back to Registry').setStyle(ButtonStyle.Secondary)),
        ],
        allowedMentions: { parse: [] },
    };
}

function roleCategoryOptions(currentCategory = null) {
    const categories = [
        { label: 'Jabatan / Rank', value: 'rank', description: 'Rank in a division; level drives promotion/demotion.' },
        { label: 'Divisi', value: 'division', description: 'Division marker, not a rank by itself.' },
        { label: 'Warning', value: 'warning', description: 'Adds a warning log when assigned.' },
        { label: 'Blacklist', value: 'blacklist', description: 'Adds a blacklist log when assigned.' },
        { label: 'Retired / Former', value: 'retired', description: 'Non-active former employee marker.' },
        { label: 'Civilian / Non-employee', value: 'civilian', description: 'Non-active employee marker.' },
        { label: 'Other / Ignored', value: 'other', description: 'Registered for reference, no automatic classification.' },
    ];
    return new StringSelectMenuBuilder()
        .setCustomId('skaw_el_registry_category')
        .setPlaceholder('Choose the role category')
        .setMinValues(1).setMaxValues(1)
        .addOptions(categories.map(item => ({ ...item, default: item.value === currentCategory })));
}

function buildRegistryForm(category, session) {
    const modal = new ModalBuilder()
        .setCustomId('skaw_el_registry_form:' + category)
        .setTitle(('Register ' + category + ' mapping').slice(0, 45));
    const addInput = (id, label, placeholder, required, maxLength, value = '') => {
        const input = new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
            .setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength);
        if (String(value || '').length) input.setValue(String(value).slice(0, maxLength));
        modal.addComponents(new ActionRowBuilder().addComponents(input));
    };
    if (category === 'rank' || category === 'division') {
        addInput('department', 'Department key', 'e.g. mechanic, modshop, builder', true, 50, session.existing?.department || '');
    }
    if (category === 'rank') {
        addInput('level', 'Rank level (1–100)', 'Use higher numbers for higher ranks', true, 3, session.existing?.level == null ? '' : String(session.existing.level));
    }
    if (category === 'warning') {
        addInput('warn', 'Warning level (e.g. 1/2)', '1/2', true, 10, session.existing?.warn || '');
    }
    addInput('note', 'Internal note (optional)', 'Optional admin reference; not shown in public logs', false, 100, session.existing?.note || '');
    return modal;
}

function buildFindModal() {
    return new ModalBuilder().setCustomId('skaw_el_find_form').setTitle('Find Employee')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
            .setCustomId('query').setLabel('Name, mention, or Discord ID')
            .setPlaceholder('Search employee directory').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100)));
}

async function buildReportPayload(client, guildId, days = 30) {
    const index = await getEmployeeDirectoryIndex(client, guildId);
    const audit = await getEmployeeLogAudit(client, guildId, { limit: 1000 });
    const since = Date.now() - Math.max(1, Number(days) || 30) * 86_400_000;
    const recent = audit.filter(item => new Date(item.publishedAt || 0).getTime() >= since);
    const counts = {};
    for (const item of recent) counts[item.type] = (counts[item.type] || 0) + 1;
    const embed = new EmbedBuilder().setColor(0x2563eb).setTitle('EMPLOYEE LOGS · MANAGEMENT REPORT')
        .setDescription('Activity summary for the last ' + days + ' days.')
        .addFields(
            { name: 'Active Employees', value: String(index.filter(item => item.status === 'active').length), inline: true },
            { name: 'Former Employees', value: String(index.filter(item => item.status === 'former').length), inline: true },
            { name: 'Directory Profiles', value: String(index.length), inline: true },
            { name: 'Records in Period', value: String(recent.length), inline: true },
            { name: 'Promotions', value: String(counts.promotion || 0), inline: true },
            { name: 'Mutations', value: String(counts.mutation || 0), inline: true },
            { name: 'Warnings', value: String(counts.warning || 0), inline: true },
            { name: 'Blacklists', value: String(counts.blacklist || 0), inline: true },
            { name: 'Sign In / Sign Out', value: String((counts.sign_in || 0) + (counts.sign_out || 0)), inline: true },
        )
        .setFooter({ text: 'Employee directory totals are indexed profiles; activity counts use durable log audit entries.' })
        .setTimestamp(new Date());
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary))], allowedMentions: { parse: [] } };
}


async function handleAdminInteraction(interaction) {
    const id = String(interaction.customId || '');

    if (interaction.isButton?.() && id.startsWith('skaw_el_dashboard:')) {
        const action = id.slice('skaw_el_dashboard:'.length);
        if (action === 'home') {
            await interaction.deferUpdate();
            return interaction.editReply({ content: '', ...buildEmployeeLogsPanel(), allowedMentions: { parse: [] } });
        }
        if (action === 'logs') {
            const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
            await interaction.deferUpdate();
            return interaction.editReply({ content: 'Choose the type of manual Employee Log. Your selection and preview remain private.', ...buildEmployeeLogsActivitiesPanel(config), allowedMentions: { parse: [] } });
        }
        if (action === 'find') return interaction.showModal(buildFindModal());
        if (action === 'report') {
            await interaction.deferUpdate();
            return interaction.editReply(await buildReportPayload(interaction.client, interaction.guildId, 30));
        }
        if (action === 'settings') {
            const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
            await interaction.deferUpdate();
            return interaction.editReply(buildSettingsPanel(values[0], values[1]));
        }
        if (action === 'roles') {
            const registry = await getEmployeeRoleRegistry(interaction.client, interaction.guildId);
            await interaction.deferUpdate();
            return interaction.editReply(buildRoleRegistryPanelPayload(registry));
        }
        if (action === 'sync') {
            await interaction.deferUpdate();
            const result = await syncEmployeeDirectoryMembership(interaction.client, interaction.guild);
            const summary = new EmbedBuilder().setColor(0x2563eb).setTitle('COMPANY STAFF DIRECTORY SYNC')
                .setDescription([
                    'Membership profiles initialized from <@&' + BASE_EMPLOYEE_ROLE.id + '>.',
                    '',
                    'Members scanned: ' + result.scanned,
                    'Company Staff members: ' + result.matched,
                    'New profiles created: ' + result.created,
                    'Former profiles reactivated: ' + result.activated,
                    'Unchanged profiles: ' + result.unchanged,
                    '',
                    '**Sign-In logs created: 0**',
                    'This sync initializes current membership without fabricating historical Sign-In records.',
                ].join('\\n'))
                .setFooter({ text: 'SKAW GROUP • EMPLOYEE DIRECTORY' });
            return interaction.editReply({ embeds: [summary], components: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary),
            )], allowedMentions: { parse: [] } });
        }
    }

    if (interaction.isButton?.() && id.startsWith('skaw_el_settings:')) {
        const action = id.slice('skaw_el_settings:'.length);
        if (action === 'channels') {
            await interaction.deferUpdate();
            return interaction.editReply(buildChannelTypePicker());
        }
        if (action === 'banner') {
            const modal = new ModalBuilder().setCustomId('skaw_el_default_banner_form').setTitle('Set Default Employee Banner');
            modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('HTTPS image URL').setPlaceholder('https://...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)));
            return interaction.showModal(modal);
        }
        if (action === 'clear-banner') {
            await interaction.deferUpdate();
            await clearEmployeeLogsBanner(interaction.client, interaction.guildId, interaction.user.id);
            const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
            return interaction.editReply({ content: '✅ Default banner cleared. Event-specific banners remain configured.', ...buildSettingsPanel(values[0], values[1]), allowedMentions: { parse: [] } });
        }
        if (action === 'event-banner' || action === 'clear-event-banner') {
            await interaction.deferUpdate();
            return interaction.editReply(buildEventBannerPicker(action === 'clear-event-banner'));
        }
    }

    if (interaction.isButton?.() && id.startsWith('skaw_el_autorole:')) {
        const action = id.slice('skaw_el_autorole:'.length);
        if (!['enable', 'disable'].includes(action)) return sendPrivate(interaction, 'Unknown Auto Logs action.');
        const enabled = action === 'enable';
        if (enabled) {
            const config = await getEmployeeLogsConfig(interaction.client, interaction.guildId);
            const requiredTypes = ['sign_in', 'sign_out', 'promotion', 'demote', 'mutation', 'warning', 'blacklist'];
            const missing = requiredTypes.filter(type => !config.channels?.[type]).map(type => EMPLOYEE_LOG_TYPES[type].shortLabel);
            if (missing.length) return sendPrivate(interaction, 'Configure these destination channels before enabling Auto Logs: ' + missing.join(', ') + '.');
        }
        await interaction.deferUpdate();
        await setEmployeeAutoRoleEnabled(interaction.client, interaction.guildId, enabled, interaction.user.id);
        const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
        return interaction.editReply({ content: '✅ Automatic Employee Logs ' + (values[1].enabled ? 'enabled.' : 'disabled.'), ...buildSettingsPanel(values[0], values[1]), allowedMentions: { parse: [] } });
    }

    if (interaction.isStringSelectMenu?.() && id === 'skaw_el_channel_type') {
        const type = interaction.values[0];
        if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) return sendPrivate(interaction, 'Unknown activity channel type.');
        const menu = new ChannelSelectMenuBuilder().setCustomId('skaw_el_channel_pick:' + type)
            .setPlaceholder('Choose a text or announcement channel').setMinValues(1).setMaxValues(1)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
        return interaction.update({
            embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle('SELECT DESTINATION CHANNEL').setDescription('Activity: ' + EMPLOYEE_LOG_TYPES[type].shortLabel)],
            components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Back to Settings').setStyle(ButtonStyle.Secondary))],
            allowedMentions: { parse: [] },
        });
    }

    if (interaction.isChannelSelectMenu?.() && id.startsWith('skaw_el_channel_pick:')) {
        const type = id.slice('skaw_el_channel_pick:'.length);
        if (!Object.hasOwn(EMPLOYEE_LOG_TYPES, type)) return sendPrivate(interaction, 'Unknown activity channel type.');
        const channelId = interaction.values[0];
        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased?.() || channel.isDMBased?.() || String(channel.guildId) !== String(interaction.guildId)) return sendPrivate(interaction, 'Choose a text channel from this server.');
        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
        const permissions = channel.permissionsFor(botMember || interaction.client.user);
        const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks | PermissionFlagsBits.ReadMessageHistory;
        if (!permissions?.has(required)) return sendPrivate(interaction, 'The bot needs View Channel, Send Messages, Embed Links, and Read Message History in ' + channel + '.');
        await interaction.deferUpdate();
        await setEmployeeLogsChannel(interaction.client, interaction.guildId, type, channelId, interaction.user.id);
        const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
        return interaction.editReply({ content: '✅ Channel for ' + EMPLOYEE_LOG_TYPES[type].shortLabel + ' saved to ' + channel + '.', ...buildSettingsPanel(values[0], values[1]), allowedMentions: { parse: [] } });
    }

    if (interaction.isStringSelectMenu?.() && (id === 'skaw_el_event_banner_pick' || id === 'skaw_el_clear_event_banner_pick')) {
        const eventKey = interaction.values[0];
        if (!Object.hasOwn(EMPLOYEE_LOG_BANNER_EVENTS, eventKey)) return sendPrivate(interaction, 'Unknown event banner.');
        if (id === 'skaw_el_clear_event_banner_pick') {
            await interaction.deferUpdate();
            await clearEmployeeLogsEventBanner(interaction.client, interaction.guildId, eventKey, interaction.user.id);
            const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
            return interaction.editReply({ content: '✅ Custom banner cleared for ' + EMPLOYEE_LOG_BANNER_EVENTS[eventKey].label + '.', ...buildSettingsPanel(values[0], values[1]), allowedMentions: { parse: [] } });
        }
        const modal = new ModalBuilder().setCustomId('skaw_el_event_banner_form:' + eventKey).setTitle(('Set ' + EMPLOYEE_LOG_BANNER_EVENTS[eventKey].label + ' banner').slice(0, 45));
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('HTTPS image URL').setPlaceholder('https://...').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500)));
        return interaction.showModal(modal);
    }

    if (interaction.isButton?.() && id.startsWith('skaw_el_registry:')) {
        const action = id.slice('skaw_el_registry:'.length);
        const registry = await getEmployeeRoleRegistry(interaction.client, interaction.guildId);
        if (action === 'add') {
            await interaction.deferUpdate();
            const menu = new RoleSelectMenuBuilder().setCustomId('skaw_el_registry_role_pick:add').setPlaceholder('Select a Discord role to register').setMinValues(1).setMaxValues(1);
            return interaction.editReply({
                embeds: [new EmbedBuilder().setColor(0x2563eb).setTitle('REGISTER EMPLOYEE ROLE').setDescription('Choose a role from the server. The next step configures its meaning in EmployeeLogs.')],
                components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Cancel').setStyle(ButtonStyle.Secondary))],
                allowedMentions: { parse: [] },
            });
        }
        if (action === 'edit' || action === 'disable') {
            await interaction.deferUpdate();
            return interaction.editReply(buildRegistryMappingPicker(registry, action));
        }
    }

    if (interaction.isRoleSelectMenu?.() && id.startsWith('skaw_el_registry_role_pick:')) {
        const roleId = interaction.values[0];
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) return sendPrivate(interaction, 'The selected Discord role could not be found.');
        if (role.id === BASE_EMPLOYEE_ROLE.id) return sendPrivate(interaction, 'Company Staff | SKAW is the fixed Base Employee Role and cannot be registered again.');
        if (SKAW_EMPLOYEE_ROLE_CATALOG[role.id]) return sendPrivate(interaction, 'This role already has a built-in mapping and cannot be duplicated in the custom registry.');
        registrySessions.set(sessionKey(interaction.guildId, interaction.user.id), { roleId: role.id, roleName: role.name, mode: 'add', existing: null, updatedAt: Date.now() });
        return interaction.update({ content: 'Selected role: <@&' + role.id + '>. Choose how EmployeeLogs should interpret it.', embeds: [], components: [new ActionRowBuilder().addComponents(roleCategoryOptions())], allowedMentions: { parse: [] } });
    }

    if (interaction.isStringSelectMenu?.() && (id === 'skaw_el_registry_edit_pick' || id === 'skaw_el_registry_disable_pick')) {
        const roleId = interaction.values[0];
        const registry = await getEmployeeRoleRegistry(interaction.client, interaction.guildId);
        const role = registry.roles.find(item => item.id === roleId);
        if (!role) return sendPrivate(interaction, 'This role mapping was not found.');
        if (id === 'skaw_el_registry_disable_pick') {
            await interaction.deferUpdate();
            await disableEmployeeRole(interaction.client, interaction.guildId, roleId, interaction.user.id);
            const next = await getEmployeeRoleRegistry(interaction.client, interaction.guildId);
            return interaction.editReply({ content: '✅ Role mapping deactivated. Existing records remain intact.', ...buildRoleRegistryPanelPayload(next), allowedMentions: { parse: [] } });
        }
        const roleObject = await interaction.guild.roles.fetch(roleId).catch(() => null);
        registrySessions.set(sessionKey(interaction.guildId, interaction.user.id), { roleId, roleName: roleObject?.name || role.name, mode: 'edit', existing: role, updatedAt: Date.now() });
        return interaction.update({ content: 'Editing mapping for <@&' + roleId + '>. Choose the category and mapping details.', embeds: [], components: [new ActionRowBuilder().addComponents(roleCategoryOptions(role.category))], allowedMentions: { parse: [] } });
    }

    if (interaction.isStringSelectMenu?.() && id === 'skaw_el_registry_category') {
        const key = sessionKey(interaction.guildId, interaction.user.id);
        const session = registrySessions.get(key);
        if (!session || Date.now() - session.updatedAt > SESSION_TTL_MS) return sendPrivate(interaction, 'Role registration session expired. Start again from Role Registry.');
        session.category = interaction.values[0];
        session.updatedAt = Date.now();
        registrySessions.set(key, session);
        return interaction.showModal(buildRegistryForm(session.category, session));
    }

    if (interaction.isModalSubmit?.() && id.startsWith('skaw_el_registry_form:')) {
        const category = id.slice('skaw_el_registry_form:'.length);
        const key = sessionKey(interaction.guildId, interaction.user.id);
        const session = registrySessions.get(key);
        await interaction.deferUpdate();
        if (!session || Date.now() - session.updatedAt > SESSION_TTL_MS) return interaction.editReply({ content: '⌛ Role registration session expired. Start again from Role Registry.', embeds: [], components: [], allowedMentions: { parse: [] } });
        const readField = field => { try { return interaction.fields.getTextInputValue(field).trim(); } catch { return ''; } };
        const department = readField('department');
        const levelRaw = readField('level');
        const warn = readField('warn');
        const note = readField('note');
        const roleObject = await interaction.guild.roles.fetch(session.roleId).catch(() => null);
        await registerEmployeeRole(interaction.client, interaction.guildId, {
            id: session.roleId,
            name: roleObject?.name || session.roleName,
            category,
            department,
            level: levelRaw ? Number(levelRaw) : null,
            warn,
            note,
        }, interaction.user.id);
        registrySessions.delete(key);
        const next = await getEmployeeRoleRegistry(interaction.client, interaction.guildId);
        return interaction.editReply({ content: '✅ Role mapping saved. Automatic classification will use it for future role changes.', ...buildRoleRegistryPanelPayload(next), allowedMentions: { parse: [] } });
    }

    if (interaction.isModalSubmit?.() && id === 'skaw_el_default_banner_form') {
        const url = interaction.fields.getTextInputValue('url').trim();
        await interaction.deferUpdate();
        await setEmployeeLogsBanner(interaction.client, interaction.guildId, url, interaction.user.id);
        const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
        return interaction.editReply({ content: '✅ Default banner saved.', ...buildSettingsPanel(values[0], values[1]), allowedMentions: { parse: [] } });
    }

    if (interaction.isModalSubmit?.() && id.startsWith('skaw_el_event_banner_form:')) {
        const eventKey = id.slice('skaw_el_event_banner_form:'.length);
        if (!Object.hasOwn(EMPLOYEE_LOG_BANNER_EVENTS, eventKey)) return sendPrivate(interaction, 'Unknown event banner.');
        const url = interaction.fields.getTextInputValue('url').trim();
        await interaction.deferUpdate();
        await setEmployeeLogsEventBanner(interaction.client, interaction.guildId, eventKey, url, interaction.user.id);
        const values = await Promise.all([getEmployeeLogsConfig(interaction.client, interaction.guildId), getEmployeeAutoRoleConfig(interaction.client, interaction.guildId)]);
        return interaction.editReply({ content: '✅ Event-specific banner saved for ' + EMPLOYEE_LOG_BANNER_EVENTS[eventKey].label + '.', ...buildSettingsPanel(values[0], values[1]), allowedMentions: { parse: [] } });
    }

    if (interaction.isModalSubmit?.() && id === 'skaw_el_find_form') {
        const query = interaction.fields.getTextInputValue('query').trim();
        await interaction.deferUpdate();
        const matches = await searchEmployeeDirectory(interaction.client, interaction.guildId, query, { limit: 10 });
        const cleanQuery = query.replace(/[\r\n]/g, ' ').slice(0, 100);
        const embed = new EmbedBuilder().setColor(0x2563eb).setTitle('EMPLOYEE DIRECTORY SEARCH')
            .setDescription(matches.length ? 'Results for **' + cleanQuery + '**' : 'No employee records matched **' + cleanQuery + '**.');
        for (const record of matches.slice(0, 10)) {
            const position = record.currentPosition?.name || record.lastKnownPosition?.name || 'Not recorded';
            embed.addFields({
                name: (record.displayName || 'Unknown member').slice(0, 250),
                value: [
                    '<@' + record.userId + '> · ' + (record.status || 'unknown').toUpperCase(),
                    'Position: ' + position,
                    'First Sign In: ' + formatDirectoryTimestamp(record.firstSignInAt),
                    'Last Sign Out: ' + formatDirectoryTimestamp(record.lastSignOutAt),
                    'History entries: ' + (Array.isArray(record.history) ? record.history.length : 0),
                ].join('\n').slice(0, 1000),
                inline: false,
            });
        }
        return interaction.editReply({ content: '', embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary))], allowedMentions: { parse: [] } });
    }

    return false;
}

async function handleInteraction(interaction) {
    if (!interaction.inGuild?.()) return;
    const id = String(interaction.customId || '');
    const isEmployeeLogsComponent = id.startsWith('skaw_el_') && (
        interaction.isButton?.() || interaction.isUserSelectMenu?.() || interaction.isRoleSelectMenu?.()
        || interaction.isStringSelectMenu?.() || interaction.isChannelSelectMenu?.() || interaction.isModalSubmit?.()
    );
    if (!isEmployeeLogsComponent) return;
    if (!hasManageGuild(interaction)) return sendPrivate(interaction, 'You do not have permission to manage Employee Logs.');

    const adminPrefixes = [
        'skaw_el_dashboard:', 'skaw_el_settings:', 'skaw_el_autorole:', 'skaw_el_registry:',
        'skaw_el_channel_type', 'skaw_el_channel_pick:', 'skaw_el_event_banner_pick',
        'skaw_el_clear_event_banner_pick', 'skaw_el_registry_role_pick:', 'skaw_el_registry_edit_pick',
        'skaw_el_registry_disable_pick', 'skaw_el_registry_category', 'skaw_el_registry_form:',
        'skaw_el_default_banner_form', 'skaw_el_event_banner_form:', 'skaw_el_find_form',
    ];
    if (adminPrefixes.some(prefix => id.startsWith(prefix))) return handleAdminInteraction(interaction);

    if (interaction.isButton?.()) {
        if (interaction.customId.startsWith('skaw_el_edit_record_details:')) return handlePublishedRecordEditDetailsButton(interaction);
        if (interaction.customId.startsWith('skaw_el_edit_record:')) return handlePublishedRecordEditButton(interaction);
        if (interaction.customId.startsWith('skaw_el_audit_record:')) return handlePublishedRecordAuditButton(interaction);
        if (interaction.customId.startsWith('skaw_el_start:')) return handleStart(interaction);
        if (interaction.customId.startsWith('skaw_el_back:')) return handleBackToPanel(interaction);
        if (interaction.customId.startsWith('skaw_el_edit:')) return handleEdit(interaction);
        if (interaction.customId.startsWith('skaw_el_confirm:')) return handleConfirm(interaction);
        if (interaction.customId.startsWith('skaw_el_cancel:')) return handleCancel(interaction);
    }
    if (interaction.isStringSelectMenu?.() && interaction.customId.startsWith('skaw_el_reason_category:')) return handlePublishedRecordReasonCategory(interaction);
    if (interaction.isUserSelectMenu?.() && interaction.customId.startsWith('skaw_el_user:')) return handleUserSelect(interaction);
    if (interaction.isRoleSelectMenu?.() && interaction.customId.startsWith('skaw_el_role:')) return handleRoleSelect(interaction);
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith('skaw_el_edit_record_modal:')) return handlePublishedRecordEditModal(interaction);
    if (interaction.isModalSubmit?.() && interaction.customId.startsWith('skaw_el_form:')) return handleModal(interaction);
    return sendPrivate(interaction, 'This Employee Logs action is not recognized or has expired. Reopen the Employee Logs dashboard and try again.');
}

export function buildEmployeeLogsPanel(config = null) {
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('EMPLOYEE MANAGEMENT SYSTEM')
        .setDescription([
            '**CENTRAL PERSONNEL CONSOLE**',
            'Manage employee records, role mappings, automatic role classification, and system configuration from one place.',
            '',
            '• Manual logs and editable employee records',
            '• Instant Sign-In / Sign-Out and role-change logs',
            '• Role Registry, employee search, and activity reports',
        ].join('\n'))
        .setFooter({ text: 'SKAW GROUP • EMPLOYEE LOGS' })
        .setTimestamp(new Date());
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_dashboard:logs').setLabel('Manual Logs').setEmoji('📝').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:find').setLabel('Find Employee').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:report').setLabel('Reports').setEmoji('📊').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:settings').setLabel('Settings').setEmoji('⚙️').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('skaw_el_dashboard:roles').setLabel('Role Registry').setEmoji('🏷️').setStyle(ButtonStyle.Secondary),
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('skaw_el_dashboard:sync').setLabel('Sync Members').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
            ),
        ],
        allowedMentions: { parse: [] },
    };
}

export function buildEmployeeLogsActivitiesPanel(config = null) {
    const missingChannels = config ? Object.entries(EMPLOYEE_LOG_TYPES).filter(([type]) => !config.channels?.[type]).map(([, entry]) => entry.shortLabel) : [];
    const setupSummary = !config
        ? 'System setup details are available from the Employee Logs dashboard.'
        : missingChannels.length
            ? '⚙️ Channels still needed: ' + missingChannels.join(', ') + '. Open Dashboard → Settings.'
            : '✅ All activity destination channels are configured.';
    const embed = new EmbedBuilder()
        .setColor(0x2563eb)
        .setAuthor({ name: 'SKAW GROUP · PEOPLE OPERATIONS' })
        .setTitle('MANUAL EMPLOYEE LOGS')
        .setDescription([
            '**CREATE AN OFFICIAL PERSONNEL RECORD**',
            'Choose an activity below. Your selection, details, and preview are private.',
            '',
            '🟢 Sign In · 🔵 Sign Out · 🏆 Promotion · 🔻 Demote',
            '⛔ Dismissal · 📄 Resignation · 🔄 Mutation',
            '⚠️ Warning · 🛡️ Blacklist · 📝 Others',
            '',
            'The final embed is sent to the destination channel configured for that activity.',
            '',
            setupSummary,
        ].join('\n'))
        .setFooter({ text: 'SKAW GROUP • PEOPLE OPERATIONS' })
        .setTimestamp(new Date());
    const types = Object.entries(EMPLOYEE_LOG_TYPES);
    const rowSizes = [4, 3, 3];
    const rows = [];
    let offset = 0;
    for (const rowSize of rowSizes) {
        const group = types.slice(offset, offset + rowSize);
        if (!group.length) continue;
        const row = new ActionRowBuilder();
        for (const [type, entry] of group) {
            const style = type === 'sign_in' ? ButtonStyle.Success
                : ['dismissal', 'blacklist', 'warning', 'demote'].includes(type) ? ButtonStyle.Danger
                : ['promotion', 'sign_out'].includes(type) ? ButtonStyle.Primary : ButtonStyle.Secondary;
            row.addComponents(new ButtonBuilder()
                .setCustomId('skaw_el_start:' + type)
                .setLabel(entry.shortLabel)
                .setEmoji(entry.emoji)
                .setStyle(style));
        }
        rows.push(row);
        offset += rowSize;
    }
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('skaw_el_dashboard:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary)));
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
            const payload = { content: `❌ Employee Logs: ${message}`, embeds: [], components: [], allowedMentions: { parse: [] } };
            if (interaction.deferred && !interaction.replied) {
                await interaction.editReply(payload);
            } else if (interaction.replied) {
                await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });
            } else {
                await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
            }
        } catch { /* Interaction expired or already acknowledged. */ }
    }
}
